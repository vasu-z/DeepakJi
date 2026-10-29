"""Tests for /api/v1/ai/scene-live-ws WebSocket endpoint."""
import base64
import json
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import get_settings

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


def test_ws_handshake_and_ping(client, monkeypatch):
    """Test initial handshake and ping/pong over WebSocket."""
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    with client.websocket_connect("/api/v1/ai/scene-live-ws") as ws:
        # Handshake
        raw = ws.receive_text()
        handshake = json.loads(raw)
        assert handshake["type"] == "session_state"
        assert handshake["status"] == "connected"
        assert "saarthi-live-" in handshake["session_id"]

        # Ping / Pong
        ws.send_text(json.dumps({"type": "ping"}))
        pong_raw = ws.receive_text()
        pong = json.loads(pong_raw)
        assert pong["type"] == "pong"

        # Stop
        ws.send_text(json.dumps({"type": "stop"}))
        term_raw = ws.receive_text()
        term = json.loads(term_raw)
        assert term["type"] == "session_terminated"
        assert term["status"] == "closed"


def test_ws_explicit_activation_lifecycle(client, monkeypatch):
    """Camera frames are ignored before activation; frames are analyzed after activation."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    with client.websocket_connect("/api/v1/ai/scene-live-ws") as ws:
        # Initial state
        ws.receive_text()

        # Frame sent before activation should NOT produce description
        ws.send_text(json.dumps({
            "type": "frame",
            "image_base64": VALID_B64_JPEG,
            "seq": 1,
        }))
        # Ping to verify event loop handled it without emitting description
        ws.send_text(json.dumps({"type": "ping"}))
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "pong"

        # Explicit activation
        ws.send_text(json.dumps({"type": "activate"}))
        active_resp = json.loads(ws.receive_text())
        assert active_resp["type"] == "session_state"
        assert active_resp["status"] == "active"

        # Frame sent AFTER activation produces description
        ws.send_text(json.dumps({
            "type": "frame",
            "image_base64": VALID_B64_JPEG,
            "seq": 2,
        }))
        frame_resp = json.loads(ws.receive_text())
        assert frame_resp["type"] == "description"
        assert "Room 204" in frame_resp["spoken_description"]
        assert frame_resp["seq"] == 1


def test_ws_user_query_grounded_search(client, monkeypatch):
    """Test user question 'Where are my keys?' over active WebSocket session."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    with client.websocket_connect("/api/v1/ai/scene-live-ws") as ws:
        ws.receive_text()  # Handshake

        # Activate
        ws.send_text(json.dumps({"type": "activate"}))
        ws.receive_text()  # Active state

        # Send frame first
        ws.send_text(json.dumps({
            "type": "frame",
            "image_base64": VALID_B64_JPEG,
            "seq": 1,
        }))
        ws.receive_text()  # Frame description

        # Ask "Where are my keys?"
        ws.send_text(json.dumps({
            "type": "query",
            "query": "Where are my keys?",
        }))
        query_resp = json.loads(ws.receive_text())
        assert query_resp["type"] == "object_search_result"
        search = query_resp["search_result"]
        assert search["is_found"] is True
        assert "key" in search["target_object"]
        assert "lower-left side of the table" in search["spoken_description"]


def test_ws_pause_and_resume(client, monkeypatch):
    """Test pausing and resuming continuous streaming over WebSocket."""
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("ENABLE_AI_MOCK", "True")
    get_settings.cache_clear()

    with client.websocket_connect("/api/v1/ai/scene-live-ws") as ws:
        ws.receive_text()  # Handshake
        ws.send_text(json.dumps({"type": "activate"}))
        ws.receive_text()  # Active

        # Pause
        ws.send_text(json.dumps({"type": "pause"}))
        pause_resp = json.loads(ws.receive_text())
        assert pause_resp["type"] == "session_state"
        assert pause_resp["status"] == "paused"

        # Resume
        ws.send_text(json.dumps({"type": "resume"}))
        resume_resp = json.loads(ws.receive_text())
        assert resume_resp["type"] == "session_state"
        assert resume_resp["status"] == "active"
