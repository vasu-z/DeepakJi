"""Shared Grounding and Spatial Reasoning Policy for Scene Understanding.

Reused across both the Live WebSocket session and the REST fallback (/api/v1/ai/scene-assist).
Strictly adheres to AGENTS.md Safety Rules:
- Rule 1: No Hallucinations / Invention (never guess objects or room numbers).
- Rule 2: Confidence Thresholds (uncertain outputs trigger re-scan instructions).
- Rule 3: Extraction vs. Reasoning (models extract grounded observations; plain code structures).
- Rule 4: Fail Safe & Fail Audible (clear spoken text for TTS).
- Rule 5: Cautious Spatial Assertions (camera-frame position only, never physical distances).
"""
import logging
import re
from typing import Optional, Tuple
from app.schemas.scene_analysis import (
    DetectedObject,
    DetectedText,
    GroundedObjectSearchResult,
    SceneAnalysisResponse,
)
from app.services.gemini import GeminiServiceException, analyze_image

logger = logging.getLogger(__name__)

# Patterns identifying targeted visual object search queries
OBJECT_SEARCH_PATTERNS = [
    re.compile(r"where (?:are|is) (?:my|the|a)?\s*(.+)", re.IGNORECASE),
    re.compile(r"find (?:my|the|a)?\s*(.+)", re.IGNORECASE),
    re.compile(r"can you see (?:my|the|a)?\s*(.+)", re.IGNORECASE),
    re.compile(r"do you see (?:my|the|a)?\s*(.+)", re.IGNORECASE),
    re.compile(r"look for (?:my|the|a)?\s*(.+)", re.IGNORECASE),
    re.compile(r"is there (?:a|an)?\s*(.+)", re.IGNORECASE),
]


def extract_target_object_from_query(query: Optional[str]) -> Optional[str]:
    """Extract requested search target from natural user speech."""
    if not query:
        return None
    cleaned = query.strip().rstrip("?.!")
    for pattern in OBJECT_SEARCH_PATTERNS:
        match = pattern.search(cleaned)
        if match and match.group(1):
            target = match.group(1).strip().lower()
            # Filter out non-object filler words
            if target and target not in {"ahead", "here", "around", "near me", "in front", "this"}:
                return target
    return None


def build_grounded_prompt(
    query: Optional[str],
    target_object: Optional[str],
    previous_description: Optional[str] = None,
) -> Tuple[str, bool]:
    """
    Build a tightly bounded prompt that forces frame-relative grounding
    and prevents distance hallucination. Returns (prompt, is_object_search).
    """
    effective_target = target_object or extract_target_object_from_query(query)

    if effective_target:
        prompt = (
            f"TARGET OBJECT SEARCH: '{effective_target}'\n"
            "Task: Inspect this camera frame carefully for the requested target object.\n"
            "MANDATORY SAFETY RULES:\n"
            f"1. If you visibly see the {effective_target}: describe its grounded position relative to the camera frame "
            "(for example: 'near the lower-left side of the table', 'in the center of the desk', or 'on the shelf to your right'). "
            "Never invent physical distances (e.g. do NOT say 'two feet away' or '1 meter'). "
            "State clearly what it looks like and where it rests in the frame.\n"
            f"2. If you do NOT visibly and clearly see the {effective_target}: say EXACTLY:\n"
            f"\"I can't see the {effective_target} clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking.\"\n"
            "3. If the image is blurry, too dark, or obscured, state plainly that the image is not clear enough to identify details.\n"
            "4. Keep your answer to 1 or 2 natural spoken sentences suitable for text-to-speech. Never use markdown or bullet points."
        )
        return prompt, True

    if query and ("what changed" in query.lower() or "did anything change" in query.lower()):
        prev_ctx = f"\nPrevious scene observation was: \"{previous_description}\"\n" if previous_description else ""
        prompt = (
            f"SCENE CHANGE ANALYSIS:{prev_ctx}"
            "Task: Inspect what is currently in front of the camera and describe meaningful visual changes.\n"
            "State whether you see new doors, signs, or obstacles, or if the view appears substantially similar.\n"
            "In 1 to 2 spoken sentences, speak directly and objectively. Never claim the path is clear."
        )
        return prompt, False

    if query and query.strip():
        prompt = (
            f"User Question: {query.strip()}\n"
            "Task: Answer the user's question based strictly on what is directly visible in the frame.\n"
            "In 1 to 2 natural spoken sentences, state what you see. "
            "Read signs or door plaques verbatim. "
            "Never invent room numbers or physical distances. "
            "If unsure, state uncertainty plainly."
        )
        return prompt, False

    # Default proactive scene narration
    prompt = (
        "PROACTIVE SCENE NARRATION:\n"
        "Analyze what is directly visible in front of the camera on this university campus.\n"
        "In 1 to 2 short, natural spoken sentences, describe the primary object, door, sign, corridor, or obstacle in view.\n"
        "Read any legible room numbers or signs verbatim.\n"
        "Never invent physical distances or claim that the path is clear.\n"
        "If blurry or dim, state plainly that the image is unclear."
    )
    return prompt, False


def parse_grounded_response(
    raw_description: str,
    target_object: Optional[str],
    model_name: str,
    status: str = "success",
) -> SceneAnalysisResponse:
    """Parse and structure the description according to Saarthi safety rules."""
    desc = raw_description.strip()
    is_unclear = any(
        kw in desc.lower()
        for kw in ["blurry", "too dark", "cannot see clearly", "unclear", "not clear", "hold steady", "insufficient lighting"]
    )
    quality = "poor" if is_unclear else "good"
    needs_rescan = is_unclear

    search_result: Optional[GroundedObjectSearchResult] = None

    if target_object:
        # Check if the target was actually located
        not_found_indicators = [
            "can't see",
            "cannot see",
            "not visible",
            "not see",
            "unable to find",
            "not clearly visible",
            "slowly sweep",
        ]
        is_not_found = is_unclear or any(ind in desc.lower() for ind in not_found_indicators)
        is_found = not is_not_found

        if is_found:
            # Extract qualitative frame position mention if present
            pos_match = re.search(
                r"(near the [^,.]+|in the [^,.]+|on the [^,.]+|to the [^,.]+)",
                desc,
                re.IGNORECASE,
            )
            rel_pos = pos_match.group(1).strip() if pos_match else "in the camera view"
            search_result = GroundedObjectSearchResult(
                is_found=True,
                target_object=target_object,
                relative_frame_position=rel_pos,
                confidence=0.88,
                next_action="located",
                spoken_description=desc,
            )
        else:
            if is_unclear:
                spoken = f"The view is too blurry or dark to spot the {target_object}. Please hold steady with good lighting."
                next_act = "improve_lighting"
            else:
                spoken = f"I can't see the {target_object} clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking."
                next_act = "sweep_camera"

            search_result = GroundedObjectSearchResult(
                is_found=False,
                target_object=target_object,
                relative_frame_position=None,
                confidence=0.40,
                next_action=next_act,
                spoken_description=spoken,
            )
            desc = spoken

    # Extract qualitative objects for structured response
    detected_objects = []
    if "door" in desc.lower():
        detected_objects.append(DetectedObject(label="door", relative_position="center", confidence=0.85))
    if "stairs" in desc.lower() or "staircase" in desc.lower():
        detected_objects.append(DetectedObject(label="stairs", relative_position="center", confidence=0.90))
    if target_object and search_result and search_result.is_found:
        detected_objects.append(
            DetectedObject(
                label=target_object,
                relative_position=search_result.relative_frame_position or "center",
                confidence=0.88,
            )
        )

    # Extract detected text if room number mentioned
    detected_texts = []
    room_match = re.search(r"room\s+([a-z0-9\-]+)", desc, re.IGNORECASE)
    if room_match:
        detected_texts.append(
            DetectedText(text=f"Room {room_match.group(1)}", context="door", confidence=0.92)
        )

    return SceneAnalysisResponse(
        status=status,
        model=model_name,
        spoken_description=desc,
        objects=detected_objects,
        detected_texts=detected_texts,
        search_result=search_result,
        spatial_description=None,
        uncertainties=["Ground obstacles or low-lying hazards below camera view"]
        if not is_unclear
        else ["Image clarity was insufficient to identify fine details"],
        unchecked_areas=[
            "Ground-level obstacles and drop-offs below the camera field of view",
            "Areas behind the camera or outside the visible frame",
        ],
        image_quality=quality,
        needs_rescan=needs_rescan,
        confidence=0.55 if is_unclear else 0.88,
    )


def execute_scene_analysis(
    image_bytes: bytes,
    mime_type: str,
    query: Optional[str],
    target_object: Optional[str],
    previous_description: Optional[str],
    api_key: Optional[str],
    model: str,
    is_mock: bool,
) -> SceneAnalysisResponse:
    """Execute unified scene analysis with safety grounding."""
    effective_target = target_object or extract_target_object_from_query(query)
    prompt, is_search = build_grounded_prompt(query, effective_target, previous_description)

    # 1. Mock Mode (ONLY if is_mock is explicitly True)
    if is_mock:
        if effective_target:
            if "key" in effective_target.lower():
                mock_desc = (
                    f"[MOCK AI] I can see what looks like a set of {effective_target} "
                    "near the lower-left side of the table."
                )
            elif "bottle" in effective_target.lower():
                mock_desc = (
                    f"[MOCK AI] I can see a water bottle resting on the center of the desk."
                )
            else:
                mock_desc = (
                    f"[MOCK AI] I can't see the {effective_target} clearly yet. "
                    "Slowly sweep the camera across the nearby surfaces and I'll keep checking."
                )
        else:
            mock_desc = (
                "[MOCK AI] In front of you is a corridor with Room 204 on the left and stairs ahead. "
                "Drop-offs and ground obstacles below the camera view were not checked."
            )

        return parse_grounded_response(
            raw_description=mock_desc,
            target_object=effective_target,
            model_name=f"mock-{model}",
            status="mock_success",
        )

    # 2. Real Gemini Vision Inference
    try:
        raw_description = analyze_image(
            image_bytes=image_bytes,
            mime_type=mime_type,
            prompt=prompt,
            api_key=api_key,
            model=model,
        )
        return parse_grounded_response(
            raw_description=raw_description,
            target_object=effective_target,
            model_name=model,
            status="success",
        )
    except GeminiServiceException as exc:
        if exc.status_code == 429:
            logger.warning("Gemini rate limit (429) encountered. Returning fail-audible guidance.")
            return SceneAnalysisResponse(
                status="rate_limited",
                model=model,
                spoken_description="I'm temporarily experiencing high AI traffic. Please pause a moment before re-scanning.",
                objects=[],
                detected_texts=[],
                search_result=None,
                spatial_description=None,
                uncertainties=["AI service quota temporarily throttled"],
                unchecked_areas=[
                    "Ground-level obstacles and drop-offs below the camera field of view",
                    "Areas behind the camera or outside the visible frame",
                ],
                image_quality="unreadable",
                needs_rescan=True,
                confidence=0.5,
            )
        raise
