"""Tests for /api/v1/ai/scene-assist endpoint."""
import base64
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import get_settings

# Minimal valid 1x1 JPEG magic bytes
VALID_JPEG_BYTES = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00"
    b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t"
    b"\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a"
    b"\x1f\x1e\x1d\x1a\x1c\x1c $.' \",#\x1c\x1c(7),01444\x1f'9=82<.342"
    b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f"
    b"\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00"
    b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00\x08\x01\x01"
    b"\x00\x00?\x00\xbf\x00\xff\xd9"
)
VALID_B64_JPEG = base64.b64encode(VALID_JPEG_BYTES).decode("utf-8")


@pytest.fixture
def client():
    return TestClient(app)


def test_scene_assist_empty_image(client, monkeypatch):
    """Empty image base64 should return 400 Bad Request."""
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    response = client.post("/api/v1/ai/scene-assist", json={"image_base64": ""})
    assert response.status_code == 400
    assert "Image data cannot be empty" in response.json()["detail"]


def test_scene_assist_invalid_base64(client, monkeypatch):
    """Invalid base64 payload should return 400 Bad Request."""
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/ai/scene-assist",
        json={"image_base64": "not_a_valid_base64!!@@"},
    )
    assert response.status_code == 400


def test_scene_assist_invalid_magic_bytes(client, monkeypatch):
    """Valid base64 but not JPEG/PNG should return 400 Bad Request."""
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    fake_bytes = b"Hello, this is not an image at all."
    b64 = base64.b64encode(fake_bytes).decode("utf-8")
    response = client.post(
        "/api/v1/ai/scene-assist",
        json={"image_base64": b64},
    )
    assert response.status_code == 400
    assert "Invalid image format" in response.json()["detail"]


def test_scene_assist_mock_mode(client, monkeypatch):
    """When ENABLE_AI_MOCK=True and no key, returns valid SceneAnalysisResponse."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/ai/scene-assist",
        json={
            "image_base64": VALID_B64_JPEG,
            "query": "What is ahead of me?",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "mock_success"
    assert "spoken_description" in data
    assert len(data["spoken_description"]) > 0
    assert "Room 204" in data["spoken_description"]
    assert len(data["unchecked_areas"]) > 0
    assert data["confidence"] > 0.0


def test_scene_assist_unconfigured_error(client, monkeypatch):
    """When unconfigured and mock mode is off, returns 503."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("GOOGLE_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "False")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/ai/scene-assist",
        json={"image_base64": VALID_B64_JPEG},
    )
    assert response.status_code == 503
    assert "Gemini API key is not configured" in response.json()["detail"]


def test_scene_assist_targeted_search_keys_found(client, monkeypatch):
    """When query is 'Where are my keys?', returns grounded search_result with is_found=True."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/ai/scene-assist",
        json={
            "image_base64": VALID_B64_JPEG,
            "query": "Where are my keys?",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "mock_success"
    assert data["search_result"] is not None
    search = data["search_result"]
    assert search["is_found"] is True
    assert "key" in search["target_object"]
    assert "lower-left" in search["relative_frame_position"]
    assert search["next_action"] == "located"
    assert "lower-left side of the table" in search["spoken_description"]


def test_scene_assist_targeted_search_not_found(client, monkeypatch):
    """When query is for an object not in view, returns is_found=False with camera sweep guidance."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    response = client.post(
        "/api/v1/ai/scene-assist",
        json={
            "image_base64": VALID_B64_JPEG,
            "query": "Where is my laptop?",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["search_result"] is not None
    search = data["search_result"]
    assert search["is_found"] is False
    assert search["next_action"] == "sweep_camera"
    assert "Slowly sweep the camera" in search["spoken_description"]
