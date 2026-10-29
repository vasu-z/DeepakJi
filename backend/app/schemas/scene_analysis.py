"""Structured scene analysis schemas for Gemma 4 / Gemini vision.

Returns validated structured information including:
- A concise spoken description.
- Visible objects with relative positions.
- Detected text and signs.
- Grounded object search results ("Where are my keys?") with frame-relative positions.
- Spatial descriptions only when supported by the image.
- Explicit uncertainty and limitations.
- Image quality assessment.
- WebSocket live session protocol schemas.

All distances, collision risks, and depth claims are excluded per safety rules.
"""
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field


class DetectedObject(BaseModel):
    """A single visually identifiable object in the scene."""

    label: str = Field(
        ...,
        description="Short name of the detected object (e.g. 'door', 'staircase', 'bench', 'keys').",
        max_length=100,
    )
    relative_position: Optional[str] = Field(
        default=None,
        description="Qualitative position from camera perspective: 'left', 'center', 'right', 'above', 'below'. Null if indeterminate.",
        max_length=50,
    )
    confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Object identification confidence.",
    )


class DetectedText(BaseModel):
    """A text fragment extracted from the scene."""

    text: str = Field(
        ...,
        description="Verbatim text as read from the image.",
        max_length=2000,
    )
    context: Optional[str] = Field(
        default=None,
        description="What surface the text appears on: 'sign', 'door', 'notice_board', 'screen', 'paper', 'other'.",
        max_length=50,
    )
    confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
    )


class GroundedObjectSearchResult(BaseModel):
    """Result of a targeted visual search for an object (e.g. 'Where are my keys?')."""

    is_found: bool = Field(
        ...,
        description="True only if the model visibly identified the requested target object.",
    )
    target_object: str = Field(
        ...,
        description="The object requested by the user (e.g. 'keys', 'backpack', 'bottle').",
        max_length=100,
    )
    relative_frame_position: Optional[str] = Field(
        default=None,
        description="Grounded qualitative position in the camera frame (e.g. 'near the lower-left side of the table'). Never physical distance.",
        max_length=200,
    )
    confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Confidence of detection.",
    )
    next_action: Literal["located", "sweep_camera", "improve_lighting", "continue_scanning"] = Field(
        default="continue_scanning",
        description="Instruction for blind user: 'located', 'sweep_camera', 'improve_lighting', or 'continue_scanning'.",
    )
    spoken_description: str = Field(
        ...,
        description="Concise spoken sentence for text-to-speech output.",
    )


class SceneAnalysisRequest(BaseModel):
    """Request for structured scene analysis."""

    image_base64: str = Field(
        ...,
        description="Base64-encoded JPEG or PNG image data.",
    )
    query: Optional[str] = Field(
        default=None,
        description="Optional user question about the scene (e.g. 'Where are my keys?', 'What sign is this?', 'Describe my surroundings').",
        max_length=2000,
    )
    target_object: Optional[str] = Field(
        default=None,
        description="Optional specific object to find in the frame (e.g. 'keys', 'water bottle').",
        max_length=100,
    )
    previous_description: Optional[str] = Field(
        default=None,
        description="Optional previous scene description to detect meaningful visual changes.",
        max_length=2000,
    )
    mime_type: str = Field(
        default="image/jpeg",
        description="MIME type. Must be image/jpeg or image/png.",
    )
    include_objects: bool = Field(
        default=True,
        description="Whether to attempt object identification.",
    )
    include_text: bool = Field(
        default=True,
        description="Whether to attempt text extraction.",
    )


class SceneAnalysisResponse(BaseModel):
    """Structured scene analysis response from Gemma 4 / Gemini."""

    status: str = Field(
        default="success",
        description="'success', 'mock_success', 'low_quality', 'error'.",
    )
    model: str = Field(
        default="",
        description="Model identifier used for inference.",
    )
    spoken_description: str = Field(
        ...,
        description="Concise 1-3 sentence description optimized for text-to-speech.",
    )
    objects: List[DetectedObject] = Field(
        default_factory=list,
        description="Visually identifiable objects in the scene.",
    )
    detected_texts: List[DetectedText] = Field(
        default_factory=list,
        description="Text fragments extracted from signs, notices, screens.",
    )
    search_result: Optional[GroundedObjectSearchResult] = Field(
        default=None,
        description="Present when request performed targeted visual object search.",
    )
    spatial_description: Optional[str] = Field(
        default=None,
        description="Brief spatial layout description only when clearly supported by the image. Null if uncertain.",
        max_length=500,
    )
    uncertainties: List[str] = Field(
        default_factory=list,
        description="Aspects that could not be determined (e.g. 'sign text partially obscured').",
    )
    unchecked_areas: List[str] = Field(
        default_factory=lambda: [
            "Ground-level obstacles and drop-offs below the camera field of view",
            "Areas behind the camera or outside the visible frame",
        ],
        description="Regions not verified (never claim path is clear).",
    )
    image_quality: str = Field(
        default="adequate",
        description="'good', 'adequate', 'poor', 'unreadable'.",
    )
    needs_rescan: bool = Field(
        default=False,
        description="True if image quality prevents safe analysis.",
    )
    confidence: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Overall analysis confidence.",
    )


# ==============================================================================
# Live WebSocket Session Protocol Schemas (Client <-> Server)
# ==============================================================================

LiveClientMessageType = Literal[
    "activate",
    "frame",
    "query",
    "pause",
    "resume",
    "stop",
    "ping",
]

LiveServerMessageType = Literal[
    "session_state",
    "description",
    "object_search_result",
    "error",
    "pong",
    "session_terminated",
]


class LiveClientMessage(BaseModel):
    """Inbound message from client over WebSocket."""

    model_config = ConfigDict(populate_by_name=True)

    type: LiveClientMessageType = Field(..., description="Message intent.")
    session_id: Optional[str] = Field(default=None, max_length=128)
    seq: Optional[int] = Field(default=0, ge=0, description="Monotonically increasing sequence number.")
    timestamp: Optional[float] = Field(default=None, description="Client unix epoch timestamp in seconds.")
    image_base64: Optional[str] = Field(default=None, alias="data", description="JPEG image frame Base64 encoded.")
    mime_type: Optional[str] = Field(default="image/jpeg")
    query: Optional[str] = Field(default=None, max_length=2000, description="Spoken user question.")
    target_object: Optional[str] = Field(default=None, max_length=100, description="Target object for search.")


class LiveServerMessage(BaseModel):
    """Outbound message from server to client over WebSocket."""

    type: LiveServerMessageType = Field(..., description="Message type.")
    session_id: Optional[str] = Field(default=None)
    seq: Optional[int] = Field(default=None)
    status: Optional[str] = Field(default=None, description="Session status: connecting, active, paused, closed, error.")
    model: Optional[str] = Field(default=None)
    spoken_description: Optional[str] = Field(default=None)
    search_result: Optional[GroundedObjectSearchResult] = Field(default=None)
    image_quality: Optional[str] = Field(default="adequate")
    confidence: Optional[float] = Field(default=None)
    uncertainties: List[str] = Field(default_factory=list)
    unchecked_areas: List[str] = Field(
        default_factory=lambda: [
            "Ground-level obstacles and drop-offs below the camera field of view",
            "Areas behind the camera or outside the visible frame",
        ]
    )
    error: Optional[str] = Field(default=None)
    recoverable: Optional[bool] = Field(default=True)
