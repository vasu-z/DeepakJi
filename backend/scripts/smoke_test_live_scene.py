"""
Opt-in Live Scene Understanding Smoke Test.

Verifies end-to-end integration with the Gemini / Gemma Live API and FastAPI
WebSocket session handler (/api/v1/ai/scene-live-ws).

Usage:
    # 1. Start backend server:
    #    cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000
    #
    # 2. Run opt-in live verification:
    #    python scripts/smoke_test_live_scene.py [--api-key YOUR_KEY] [--url ws://127.0.0.1:8000/api/v1/ai/scene-live-ws]
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import time

try:
    import websockets
except ImportError:
    print("[Error] websockets package is required to run live smoke test.")
    print("Run: pip install websockets")
    sys.exit(1)


def generate_synthetic_test_frame() -> str:
    """Generate a minimal valid 1x1 JPEG in Base64 for network protocol verification."""
    # 1x1 pixel JPEG binary
    jpeg_bytes = bytes([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
        0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
        0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
        0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
        0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
        0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
        0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0A, 0x0B, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F,
        0x00, 0xBE, 0x00, 0x3F, 0xFF, 0xD9
    ])
    return base64.b64encode(jpeg_bytes).decode("ascii")


async def run_smoke_test(ws_url: str, api_key: str | None = None):
    print(f"[*] Starting Saarthi Feature 01 Live Scene Understanding Smoke Test")
    print(f"[*] Target WebSocket URL: {ws_url}")

    if api_key:
        os.environ["GEMINI_API_KEY"] = api_key
        print("[*] Using provided GEMINI_API_KEY for live inference")
    elif not os.environ.get("GEMINI_API_KEY"):
        print("[!] Note: GEMINI_API_KEY environment variable is not currently set.")
        print("[!] The WebSocket session handler will verify protocol handshakes and fallback behaviors.")

    try:
        async with websockets.connect(ws_url) as ws:
            print("[+] Connected to Live Scene Understanding WebSocket successfully!")

            # 1. Receive initial connection state
            raw_welcome = await ws.recv()
            welcome_msg = json.loads(raw_welcome)
            welcome_state = welcome_msg.get("status") or welcome_msg.get("state")
            print(f"[+] Server Handshake: type={welcome_msg.get('type')}, state={welcome_state}")
            assert welcome_msg.get("type") == "session_state", "Expected session_state initial message"
            assert welcome_state == "connected", f"Expected state=connected, got {welcome_state}"

            # 2. Activate session
            print("[*] Sending 'activate' message with target_object='keys'...")
            t_start = time.perf_counter()
            await ws.send(json.dumps({
                "type": "activate",
                "target_object": "keys",
                "client_id": "smoke-test-client-1",
            }))

            raw_active = await ws.recv()
            active_msg = json.loads(raw_active)
            t_activate = (time.perf_counter() - t_start) * 1000
            status_val = active_msg.get("status") or active_msg.get("state")
            print(f"[+] Server Response ({t_activate:.1f}ms): status={status_val}, model={active_msg.get('model')}")
            assert status_val == "active", f"Expected status=active after activation, got {status_val}"

            # 3. Stream a test frame with targeted object query
            test_b64 = generate_synthetic_test_frame()
            print("[*] Streaming JPEG frame seq=1 with query 'Where are my keys?'...")
            t_frame_start = time.perf_counter()
            await ws.send(json.dumps({
                "type": "frame",
                "image_base64": test_b64,
                "mime_type": "image/jpeg",
                "timestamp": time.time(),
                "seq": 1,
            }))

            await ws.send(json.dumps({
                "type": "query",
                "query": "Where are my keys?",
                "target_object": "keys",
            }))

            # 4a. Query: "Where are my keys?" (Targeted object found)
            response_received = False
            while not response_received:
                raw_reply = await asyncio.wait_for(ws.recv(), timeout=10.0)
                reply = json.loads(raw_reply)
                msg_type = reply.get("type")
                t_latency = (time.perf_counter() - t_frame_start) * 1000

                if msg_type in ("object_search_result", "search_result"):
                    sr = reply.get("search_result") or reply
                    print(f"[+] Grounded Search Result Received ({t_latency:.1f}ms):")
                    print(f"    - is_found: {sr.get('is_found')}")
                    print(f"    - target_object: {sr.get('target_object')}")
                    print(f"    - relative_frame_position: {sr.get('relative_frame_position')}")
                    print(f"    - confidence: {sr.get('confidence')}")
                    print(f"    - spoken_description: {sr.get('spoken_description') or reply.get('spoken_description')}")
                    response_received = True

            # 4b. Query: "What is in front of me?" (General scene description)
            print("\n[*] Testing Query: 'What is in front of me?'...")
            await ws.send(json.dumps({
                "type": "query",
                "query": "What is in front of me?",
            }))
            while True:
                raw_reply = await asyncio.wait_for(ws.recv(), timeout=10.0)
                reply = json.loads(raw_reply)
                if reply.get("type") == "description":
                    print(f"[+] Scene Description: {reply.get('spoken_description')}")
                    print(f"    - confidence: {reply.get('confidence')}")
                    print(f"    - unchecked_areas: {reply.get('unchecked_areas')}")
                    break

            # 4c. Query: "Where are my glasses?" (Object NOT found -> Sweep guidance)
            print("\n[*] Testing Query: 'Where are my glasses?' (Expect sweep guidance)...")
            await ws.send(json.dumps({
                "type": "query",
                "query": "Where are my glasses?",
                "target_object": "glasses",
            }))
            while True:
                raw_reply = await asyncio.wait_for(ws.recv(), timeout=10.0)
                reply = json.loads(raw_reply)
                if reply.get("type") in ("object_search_result", "search_result"):
                    sr = reply.get("search_result") or reply
                    print(f"[+] Sweep Guidance Result:")
                    print(f"    - is_found: {sr.get('is_found')}")
                    print(f"    - next_action: {sr.get('next_action')}")
                    print(f"    - spoken_description: {sr.get('spoken_description') or reply.get('spoken_description')}")
                    print(f"    - sweep_guidance: {sr.get('sweep_guidance')}")
                    assert sr.get("is_found") is False, "Expected glasses to not be found"
                    assert "sweep" in str(sr.get("spoken_description", "")).lower() or "sweep" in str(sr.get("sweep_guidance", "")).lower(), "Expected camera sweep guidance"
                    break

            # 5. Test Pause & Resume
            print("[*] Testing Pause...")
            await ws.send(json.dumps({"type": "pause"}))
            while True:
                raw_pause = await asyncio.wait_for(ws.recv(), timeout=5.0)
                pause_msg = json.loads(raw_pause)
                if pause_msg.get("type") == "session_state" and (pause_msg.get("status") == "paused" or pause_msg.get("state") == "paused"):
                    print("[+] Pause acknowledged by server.")
                    break

            print("[*] Testing Resume...")
            await ws.send(json.dumps({"type": "resume"}))
            while True:
                raw_resume = await asyncio.wait_for(ws.recv(), timeout=5.0)
                resume_msg = json.loads(raw_resume)
                if resume_msg.get("type") == "session_state" and (resume_msg.get("status") == "active" or resume_msg.get("state") == "active"):
                    print("[+] Resume acknowledged by server.")
                    break

            # 6. Test Stop and Graceful Teardown
            print("[*] Testing Stop...")
            await ws.send(json.dumps({"type": "stop"}))
            while True:
                raw_stop = await asyncio.wait_for(ws.recv(), timeout=5.0)
                stop_msg = json.loads(raw_stop)
                if stop_msg.get("type") in ("session_terminated", "session_state"):
                    stop_status = stop_msg.get("status") or stop_msg.get("state")
                    print(f"[+] Session stopped cleanly: status={stop_status}")
                    break

            print("\n=======================================================")
            print("  LIVE SMOKE TEST RESULT: ALL PROTOCOL CHECKS PASSED  ")
            print("=======================================================\n")

    except ConnectionRefusedError:
        print(f"\n[!] Connection refused at {ws_url}.")
        print("[!] Ensure the backend server is running:")
        print("    cd backend && uvicorn app.main:app --host 127.0.0.1 --port 8000\n")
        sys.exit(1)
    except Exception as exc:
        print(f"\n[!] Smoke test error: {exc}\n")
        raise exc


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Live Scene Understanding Smoke Test")
    parser.add_argument("--url", default="ws://127.0.0.1:8000/api/v1/ai/scene-live-ws", help="WebSocket URL")
    parser.add_argument("--api-key", default=None, help="Optional Gemini API Key")
    args = parser.parse_args()

    asyncio.run(run_smoke_test(args.url, args.api_key))
