import base64
import binascii
import json
import logging
import time
import uuid
from typing import List, Optional
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from app.core.config import get_settings
from app.schemas.ai import (
    AIStatusResponse,
    AITestRequest,
    AITestResponse,
    AIVisionRequest,
    AIVisionResponse,
    DEFAULT_VISION_PROMPT,
    MAX_DECODED_IMAGE_SIZE_BYTES,
    SUPPORTED_MIME_TYPES,
)
from app.schemas.scene_analysis import (
    DetectedObject,
    DetectedText,
    GroundedObjectSearchResult,
    LiveClientMessage,
    LiveServerMessage,
    SceneAnalysisRequest,
    SceneAnalysisResponse,
)
from app.services.gemini import (
    GeminiCredentialsMissingException,
    GeminiServiceException,
    analyze_image,
    generate_text,
)
from app.services.live_session import GeminiLiveSession
from app.services.scene_grounding import (
    execute_scene_analysis,
    extract_target_object_from_query,
    parse_grounded_response,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get(
    "/status",
    response_model=AIStatusResponse,
    summary="Check AI configuration status",
    description="Check whether a Gemini API key is configured or development mock mode is enabled without exposing keys.",
)
def get_ai_status() -> AIStatusResponse:
    """Return whether the Gemini API key is configured and which model is selected."""
    settings = get_settings()
    return AIStatusResponse(
        configured=settings.is_gemini_configured or settings.ENABLE_AI_MOCK,
        model=settings.GEMINI_MODEL,
        mock_mode=settings.ENABLE_AI_MOCK,
    )



@router.post(
    "/test",
    response_model=AITestResponse,
    summary="Test Gemini text generation",
    description="Make a real, short text-generation request to the configured Gemini model.",
)
def test_ai_connectivity(request: AITestRequest = AITestRequest()) -> AITestResponse:
    """Perform a short connectivity test against the official Gemini API."""
    settings = get_settings()

    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return AITestResponse(
                status="mock_success",
                model=f"mock-{settings.GEMINI_MODEL}",
                prompt=request.prompt,
                response="[MOCK AI] SAARTHI is running in local development mode without external API keys.",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )

    try:
        response_text = generate_text(
            prompt=request.prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )
        return AITestResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            prompt=request.prompt,
            response=response_text,
        )
    except GeminiServiceException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


@router.post(
    "/vision",
    response_model=AIVisionResponse,
    summary="Analyze image with Gemini Vision",
    description="Analyze a Base64-encoded image with Gemini Vision for accessible scene description.",
)
def analyze_scene_image(request: AIVisionRequest) -> AIVisionResponse:
    """
    Process an image using Gemini Vision optimized for visually impaired users.
    Validates Base64 encoding, size limits, and image headers.
    """
    settings = get_settings()

    if not settings.is_gemini_configured and not settings.ENABLE_AI_MOCK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )



    # 1. Clean Base64 payload (strip whitespace and optional data URI prefix)
    raw_b64 = request.image_base64.strip() if request.image_base64 else ""
    if not raw_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image data cannot be empty.",
        )

    if raw_b64.startswith("data:") and "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1].strip()

    # 2. Validate MIME type
    declared_mime = (request.mime_type or "image/jpeg").lower().strip()
    if declared_mime == "image/jpg":
        declared_mime = "image/jpeg"
    if declared_mime not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image MIME type '{request.mime_type}'. Supported types: image/jpeg, image/png.",
        )

    # 3. Decode Base64 data
    try:
        image_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or malformed Base64 image data.",
        )

    # 4. Check decoded size
    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decoded image data is empty.",
        )

    if len(image_bytes) > MAX_DECODED_IMAGE_SIZE_BYTES:
        max_mb = MAX_DECODED_IMAGE_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image size exceeds the maximum allowed limit of {max_mb} MB.",
        )

    # 5. Validate magic bytes signature for JPEG / PNG
    is_jpeg = image_bytes.startswith(b"\xff\xd8\xff")
    is_png = image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    if not (is_jpeg or is_png):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image format. Decoded data does not match a valid JPEG or PNG signature.",
        )

    resolved_mime = "image/jpeg" if is_jpeg else "image/png"

    # 6. Compose effective prompt for blind/low-vision navigation
    user_prompt = request.prompt.strip() if request.prompt and request.prompt.strip() else None
    if user_prompt:
        effective_prompt = f"User Question: {user_prompt}\n\nPlease answer based strictly on what is visible in the image."
        prompt_used = user_prompt
    else:
        effective_prompt = DEFAULT_VISION_PROMPT
        prompt_used = DEFAULT_VISION_PROMPT

    logger.info(
        "Vision analysis requested: image_size=%d bytes, mime_type=%s, has_custom_prompt=%s",
        len(image_bytes),
        resolved_mime,
        bool(user_prompt),
    )

    # 7. Call Gemini Vision service or mock mode
    if not settings.is_gemini_configured and settings.ENABLE_AI_MOCK:
        mock_description = (
            "[MOCK AI] In front of you is a room door labeled 'Room 204 — Computer Science Dept'. "
            "Drop-offs and ground obstacles below the camera view were not checked."
        )
        return AIVisionResponse(
            status="mock_success",
            model=f"mock-{settings.GEMINI_MODEL}",
            prompt=prompt_used,
            description=mock_description,
            confidence=0.92,
            extracted_text="Room 204 — Computer Science Dept",
            uncertainties=[],
            unchecked_areas=["Drop-offs and ground obstacles below camera field of view"],
            needs_rescan=False,
        )

    try:
        description = analyze_image(
            image_bytes=image_bytes,
            mime_type=resolved_mime,
            prompt=effective_prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )

        logger.info(
            "Vision analysis completed successfully: model=%s, desc_len=%d chars",
            settings.GEMINI_MODEL,
            len(description),
        )

        # Disclose safety limitations (Rule 5)
        return AIVisionResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            prompt=prompt_used,
            description=description,
            confidence=0.90,
            uncertainties=[],
            unchecked_areas=["Drop-offs and ground obstacles below camera field of view"],
            needs_rescan=False,
        )
    except GeminiServiceException as exc:
        logger.warning("Vision analysis error: status_code=%d, detail=%s", exc.status_code, exc.message)
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )
@router.post(
    "/scene-assist",
    response_model=SceneAnalysisResponse,
    summary="Live Camera Assist scene analysis",
    description="Analyze a captured camera frame with Gemma 4 / Gemini vision, returning concise grounded descriptions, targeted object localization, and safety disclosures.",
)
def live_scene_assist(request: SceneAnalysisRequest) -> SceneAnalysisResponse:
    """Analyze a camera frame for Scene Understanding with safety disclosures."""
    settings = get_settings()

    if not settings.is_gemini_configured and not settings.ENABLE_AI_MOCK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )

    # 1. Clean Base64 payload
    raw_b64 = request.image_base64.strip() if request.image_base64 else ""
    if not raw_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image data cannot be empty.",
        )

    if raw_b64.startswith("data:") and "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1].strip()

    # 2. Validate MIME type
    declared_mime = (request.mime_type or "image/jpeg").lower().strip()
    if declared_mime == "image/jpg":
        declared_mime = "image/jpeg"
    if declared_mime not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image MIME type '{request.mime_type}'. Supported types: image/jpeg, image/png.",
        )

    # 3. Decode Base64 data
    try:
        image_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or malformed Base64 image data.",
        )

    # 4. Check decoded size
    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decoded image data is empty.",
        )

    if len(image_bytes) > MAX_DECODED_IMAGE_SIZE_BYTES:
        max_mb = MAX_DECODED_IMAGE_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image size exceeds the maximum allowed limit of {max_mb} MB.",
        )

    # 5. Validate magic bytes signature for JPEG / PNG
    is_jpeg = image_bytes.startswith(b"\xff\xd8\xff")
    is_png = image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    if not (is_jpeg or is_png):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image format. Decoded data does not match a valid JPEG or PNG signature.",
        )

    resolved_mime = "image/jpeg" if is_jpeg else "image/png"

    # 6. Execute unified grounded scene analysis
    try:
        return execute_scene_analysis(
            image_bytes=image_bytes,
            mime_type=resolved_mime,
            query=request.query,
            target_object=request.target_object,
            previous_description=request.previous_description,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
            is_mock=settings.ENABLE_AI_MOCK or not settings.is_gemini_configured,
        )
    except GeminiServiceException as exc:
        logger.warning("Scene assist error: status_code=%d, detail=%s", exc.status_code, exc.message)
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


@router.websocket("/scene-live-ws")
async def scene_live_websocket(websocket: WebSocket) -> None:
    """
    Server-managed WebSocket Live Scene Understanding Session.

    Connects mobile client to upstream AI service without exposing long-lived API keys.
    Enforces:
    - Explicit activation before frame processing.
    - Rate limit: max 1 frame per 1000ms (1 Hz) to respect upstream quotas.
    - Strict image size check (max 5 MB).
    - Targeted object search ("Where are my keys?") with grounded frame-relative positions.
    - Bounded in-memory frame retention buffer (cleared on teardown).
    - Immediate Stop and clean session termination.
    """
    await websocket.accept()
    settings = get_settings()

    session_id = f"saarthi-live-{uuid.uuid4().hex[:12]}"
    is_active = False
    is_paused = False
    last_frame_processed_time = 0.0
    latest_frame_bytes: Optional[bytes] = None
    latest_frame_mime: str = "image/jpeg"
    previous_description: Optional[str] = None
    active_target_object: Optional[str] = None
    frame_sequence: int = 0
    live_gemini: Optional[GeminiLiveSession] = None

    # Minimum spacing between frame analyses (1.0 second cadence = 1 FPS ceiling)
    MIN_FRAME_INTERVAL_SEC = 1.0
    MAX_WS_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB ceiling

    # Initial session handshake
    await websocket.send_text(
        LiveServerMessage(
            type="session_state",
            session_id=session_id,
            status="connected",
            model=settings.GEMINI_LIVE_MODEL if settings.is_gemini_configured else settings.GEMINI_MODEL,
        ).model_dump_json()
    )

    logger.info("Live WebSocket session started: session_id=%s", session_id)

    async def ensure_live_gemini() -> Optional[GeminiLiveSession]:
        nonlocal live_gemini
        if live_gemini and live_gemini.is_connected:
            return live_gemini
        if settings.is_gemini_configured:
            try:
                live_gemini = GeminiLiveSession(
                    api_key=settings.GEMINI_API_KEY,
                    model=settings.GEMINI_LIVE_MODEL,
                )
                started = await live_gemini.start(
                    system_instruction=(
                        "You are Saarthi, an AI navigation and visual assistant for blind university students. "
                        "State clearly and concisely in 1 to 2 spoken sentences what is visible directly in front of the camera. "
                        "If searching for an object and it is not visible, say so plainly and suggest sweeping the camera. "
                        "Never claim the path is clear."
                    )
                )
                if started and live_gemini.is_connected:
                    logger.info("Gemini Live session successfully connected: model=%s", settings.GEMINI_LIVE_MODEL)
                    return live_gemini
                if live_gemini.last_error:
                    logger.warning("Live session startup note: %s", live_gemini.last_error)
            except Exception as live_err:
                logger.info("Live session connection note: %s", live_err)
                live_gemini = None
        return live_gemini

    if settings.is_gemini_configured:
        await ensure_live_gemini()

    try:
        while True:
            raw_text = await websocket.receive_text()
            if not raw_text or not raw_text.strip():
                continue

            try:
                msg_dict = json.loads(raw_text)
                client_msg = LiveClientMessage.model_validate(msg_dict)
            except Exception as parse_err:
                await websocket.send_text(
                    LiveServerMessage(
                        type="error",
                        session_id=session_id,
                        error=f"Malformed client message: {str(parse_err)}",
                        recoverable=True,
                    ).model_dump_json()
                )
                continue

            # 1. PING / PONG
            if client_msg.type == "ping":
                await websocket.send_text(
                    LiveServerMessage(type="pong", session_id=session_id).model_dump_json()
                )
                continue

            # 2. ACTIVATE
            if client_msg.type == "activate":
                is_active = True
                is_paused = False
                active_target_object = client_msg.target_object
                logger.info("Session activated: session_id=%s, target=%s", session_id, active_target_object)

                if settings.is_gemini_configured and not (live_gemini and live_gemini.is_connected):
                    await ensure_live_gemini()

                if not settings.is_gemini_configured and not settings.ENABLE_AI_MOCK:
                    await websocket.send_text(
                        LiveServerMessage(
                            type="error",
                            session_id=session_id,
                            error="Authentication Blocker: GEMINI_API_KEY is not configured in backend/.env. Please configure a valid key for live model inference.",
                            spoken_description="Gemini API key is not configured. Please add your GEMINI_API_KEY in backend/.env to activate live camera understanding.",
                            recoverable=False,
                        ).model_dump_json()
                    )

                await websocket.send_text(
                    LiveServerMessage(
                        type="session_state",
                        session_id=session_id,
                        status="active",
                        model=settings.GEMINI_LIVE_MODEL if live_gemini and live_gemini.is_connected else (
                            settings.GEMINI_MODEL if settings.is_gemini_configured else "unconfigured"
                        ),
                    ).model_dump_json()
                )
                continue

            # 3. PAUSE
            if client_msg.type == "pause":
                is_paused = True
                await websocket.send_text(
                    LiveServerMessage(
                        type="session_state",
                        session_id=session_id,
                        status="paused",
                        model=settings.GEMINI_MODEL,
                    ).model_dump_json()
                )
                continue

            # 4. RESUME
            if client_msg.type == "resume":
                is_paused = False
                await websocket.send_text(
                    LiveServerMessage(
                        type="session_state",
                        session_id=session_id,
                        status="active",
                        model=settings.GEMINI_MODEL,
                    ).model_dump_json()
                )
                continue

            # 5. STOP
            if client_msg.type == "stop":
                is_active = False
                if live_gemini:
                    await live_gemini.close()
                    live_gemini = None
                await websocket.send_text(
                    LiveServerMessage(
                        type="session_terminated",
                        session_id=session_id,
                        status="closed",
                    ).model_dump_json()
                )
                break

            # 6. USER QUERY (e.g. "Where are my keys?", "What is ahead?", "What changed?")
            if client_msg.type == "query":
                query_text = (client_msg.query or "").strip()
                target_obj = client_msg.target_object or extract_target_object_from_query(query_text)
                active_target_object = target_obj

                # Prioritize fresh frame sent with the query message itself
                if client_msg.image_base64:
                    raw_b64 = client_msg.image_base64.strip()
                    if raw_b64.startswith("data:") and "," in raw_b64:
                        raw_b64 = raw_b64.split(",", 1)[1].strip()
                    try:
                        decoded_bytes = base64.b64decode(raw_b64, validate=True)
                        if decoded_bytes and (decoded_bytes.startswith(b"\xff\xd8\xff") or decoded_bytes.startswith(b"\x89PNG\r\n\x1a\n")):
                            latest_frame_bytes = decoded_bytes
                            latest_frame_mime = client_msg.mime_type or ("image/png" if decoded_bytes.startswith(b"\x89PNG") else "image/jpeg")
                            logger.info("[DIAGNOSTIC BACKEND] Ingested fresh frame from query payload: bytes=%d, mime=%s", len(latest_frame_bytes), latest_frame_mime)
                    except Exception as b64_err:
                        logger.warning("[DIAGNOSTIC BACKEND] Query frame decode warning: %s", b64_err)

                if not latest_frame_bytes:
                    logger.warning("[DIAGNOSTIC BACKEND] Query rejected: latest_frame_bytes is empty.")
                    await websocket.send_text(
                        LiveServerMessage(
                            type="description",
                            session_id=session_id,
                            spoken_description="Camera frame is not ready yet. Point your camera steady forward.",
                            confidence=0.3,
                            image_quality="unreadable",
                        ).model_dump_json()
                    )
                    continue

                # Run grounded query analysis on current active frame
                try:
                    if not (live_gemini and live_gemini.is_connected) and settings.is_gemini_configured:
                        await ensure_live_gemini()
                    result: Optional[SceneAnalysisResponse] = None
                    if live_gemini and live_gemini.is_connected:
                        if active_target_object:
                            formatted_query = (
                                f"Is there a {active_target_object} visible in this image? "
                                f"If visible, state its approximate relative location in the frame (e.g. on the desk, near the center). "
                                f"If NOT visible, state clearly: 'I can\'t see the {active_target_object} clearly yet. Slowly sweep the camera across the nearby surfaces and I\'ll keep checking.' "
                                "Never invent an object location."
                            )
                        else:
                            formatted_query = (
                                f"{query_text or 'Describe what is visibly in front of me.'} "
                                "State clearly and concisely in 1 to 2 spoken sentences what is visible directly in front of the camera. "
                                "Never say the path is clear."
                            )

                        logger.info(
                            "[DIAGNOSTIC BACKEND] Dispatching to Gemini Live: target='%s', query='%s'",
                            active_target_object,
                            formatted_query,
                        )
                        await live_gemini.send_query(
                            query=formatted_query,
                            image_bytes=latest_frame_bytes,
                            mime_type=latest_frame_mime,
                        )
                        raw_reply = await live_gemini.receive_text(timeout_sec=12.0)
                        logger.info("[DIAGNOSTIC BACKEND] Gemini Live raw reply: '%s'", raw_reply)
                        if raw_reply:
                            result = parse_grounded_response(
                                raw_description=raw_reply,
                                target_object=active_target_object,
                                model_name=settings.GEMINI_LIVE_MODEL,
                                status="success",
                            )

                    if not result:
                        logger.info("[DIAGNOSTIC BACKEND] Live session returned empty; evaluating via standard pipeline.")
                        result = execute_scene_analysis(
                            image_bytes=latest_frame_bytes,
                            mime_type=latest_frame_mime,
                            query=query_text,
                            target_object=active_target_object,
                            previous_description=previous_description,
                            api_key=settings.GEMINI_API_KEY,
                            model=settings.GEMINI_MODEL,
                            is_mock=settings.ENABLE_AI_MOCK or not settings.is_gemini_configured,
                        )
                    previous_description = result.spoken_description

                    if result.search_result:
                        await websocket.send_text(
                            LiveServerMessage(
                                type="object_search_result",
                                session_id=session_id,
                                search_result=result.search_result,
                                spoken_description=result.spoken_description,
                                confidence=result.confidence,
                                image_quality=result.image_quality,
                            ).model_dump_json()
                        )
                    else:
                        await websocket.send_text(
                            LiveServerMessage(
                                type="description",
                                session_id=session_id,
                                spoken_description=result.spoken_description,
                                confidence=result.confidence,
                                image_quality=result.image_quality,
                                uncertainties=result.uncertainties,
                                unchecked_areas=result.unchecked_areas,
                            ).model_dump_json()
                        )
                except GeminiCredentialsMissingException:
                    logger.warning("Query rejected: Gemini API key is missing.")
                    await websocket.send_text(
                        LiveServerMessage(
                            type="error",
                            session_id=session_id,
                            error="GEMINI_API_KEY is not configured in backend/.env. Real inference requires a valid API key.",
                            spoken_description="Gemini API key is not configured. Please set your key in backend/.env to answer scene questions.",
                            recoverable=False,
                        ).model_dump_json()
                    )
                except Exception as exc:
                    logger.warning("Query analysis error: %s", exc)
                    await websocket.send_text(
                        LiveServerMessage(
                            type="error",
                            session_id=session_id,
                            error=f"Model inference error: {str(exc)}",
                            spoken_description="I was unable to analyze the scene with the live model. Please try again.",
                            recoverable=True,
                        ).model_dump_json()
                    )
                continue

            # 7. INBOUND CAMERA FRAME
            if client_msg.type == "frame":
                if not is_active or is_paused:
                    # Ignore frames before explicit activation or while paused
                    continue

                now = time.time()
                # Rate limit enforcement (1 Hz cadence ceiling)
                if now - last_frame_processed_time < MIN_FRAME_INTERVAL_SEC:
                    continue

                raw_b64 = (client_msg.image_base64 or "").strip()
                if not raw_b64:
                    continue

                if raw_b64.startswith("data:") and "," in raw_b64:
                    raw_b64 = raw_b64.split(",", 1)[1].strip()

                try:
                    frame_bytes = base64.b64decode(raw_b64, validate=True)
                except Exception:
                    continue

                if len(frame_bytes) == 0 or len(frame_bytes) > MAX_WS_IMAGE_BYTES:
                    continue

                is_jpeg = frame_bytes.startswith(b"\xff\xd8\xff")
                is_png = frame_bytes.startswith(b"\x89PNG\r\n\x1a\n")
                if not (is_jpeg or is_png):
                    continue

                # Buffer latest valid frame (retention ceiling: 1 frame in memory, never persisted)
                latest_frame_bytes = frame_bytes
                latest_frame_mime = "image/jpeg" if is_jpeg else "image/png"
                last_frame_processed_time = now
                frame_sequence += 1

                if not (live_gemini and live_gemini.is_connected) and settings.is_gemini_configured:
                    await ensure_live_gemini()

                if live_gemini and live_gemini.is_connected:
                    try:
                        await live_gemini.send_frame(latest_frame_bytes, latest_frame_mime)
                    except Exception as live_send_err:
                        logger.debug("Live session frame forward error: %s", live_send_err)

                try:
                    result = execute_scene_analysis(
                        image_bytes=latest_frame_bytes,
                        mime_type=latest_frame_mime,
                        query=None,
                        target_object=active_target_object,
                        previous_description=previous_description,
                        api_key=settings.GEMINI_API_KEY,
                        model=settings.GEMINI_MODEL,
                        is_mock=settings.ENABLE_AI_MOCK or not settings.is_gemini_configured,
                    )
                    previous_description = result.spoken_description

                    if result.search_result:
                        if result.search_result.is_found:
                            active_target_object = None
                        await websocket.send_text(
                            LiveServerMessage(
                                type="object_search_result",
                                session_id=session_id,
                                seq=frame_sequence,
                                search_result=result.search_result,
                                spoken_description=result.spoken_description,
                                confidence=result.confidence,
                                image_quality=result.image_quality,
                            ).model_dump_json()
                        )
                    else:
                        await websocket.send_text(
                            LiveServerMessage(
                                type="description",
                                session_id=session_id,
                                seq=frame_sequence,
                                spoken_description=result.spoken_description,
                                confidence=result.confidence,
                                image_quality=result.image_quality,
                                uncertainties=result.uncertainties,
                                unchecked_areas=result.unchecked_areas,
                            ).model_dump_json()
                        )
                except GeminiCredentialsMissingException:
                    logger.warning("Frame processing rejected: Gemini credentials missing.")
                    await websocket.send_text(
                        LiveServerMessage(
                            type="error",
                            session_id=session_id,
                            error="Authentication missing: Set GEMINI_API_KEY in backend/.env for real AI live vision.",
                            spoken_description="Gemini API key is not configured.",
                            recoverable=False,
                        ).model_dump_json()
                    )
                except Exception as frame_err:
                    logger.warning("Frame processing error: %s", frame_err)
                    await websocket.send_text(
                        LiveServerMessage(
                            type="error",
                            session_id=session_id,
                            error=f"Live vision error: {str(frame_err)}",
                            spoken_description="Vision service error. Re-evaluating next frame.",
                            recoverable=True,
                        ).model_dump_json()
                    )

    except WebSocketDisconnect:
        logger.info("Live WebSocket client disconnected: session_id=%s", session_id)
    except Exception as exc:
        logger.error("Live WebSocket session error: %s", exc)
    finally:
        # Deterministic teardown and memory cleanup
        if live_gemini:
            await live_gemini.close()
            live_gemini = None
        latest_frame_bytes = None
        is_active = False
        logger.info("Live WebSocket session resources released: session_id=%s", session_id)


