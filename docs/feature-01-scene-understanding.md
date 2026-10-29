# Feature 01: Live Scene Understanding

## 1. Overview & Objective

Saarthi is an AI navigation and reading assistant for visually impaired university students. Feature 01 delivers a voice-first, live-camera scene-understanding experience inspired by Gemini Live / Project Astra, integrated natively into the existing Saarthi React Native + Expo mobile application and FastAPI backend.

### Key Tenets
1. **Safety First**: Blind users cannot verify visual claims. Under no circumstances does Saarthi invent room numbers, physical distances (e.g. "it is 2.3 meters away"), or unseen objects.
2. **Tactile Four-Corner Interaction**: Users cannot reliably locate tiny floating shutter buttons. The interface provides 4 large corner targets (78dp x 78dp, minimum 56dp required) with distinct haptic feedback per corner and WCAG AAA contrast ratios.
3. **Voice-First Lifecycle**: Explicit spoken announcements guide every phase without visual feedback dependencies:
   - Activation: *"Saarthi scene understanding is on. Point your camera around; ask me anything."*
   - Stop: *"Scene understanding stopped."*
   - Pause: *"Scene understanding paused."*
   - Resume: *"Scene understanding resumed."*
4. **Grounded Object Search**: Supports queries like *"Where are my keys?"* with frame-relative natural language locations (e.g., *"near the lower-left side of the table"*) or camera sweep guidance when not visible (*"I can't see the keys clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking."*). Bounded to 5 sweeps to avoid infinite loops.
5. **Hybrid Architecture with Honest Fallback**: Streaming bidirectional WebSocket (`/api/v1/ai/scene-live-ws`) backed by Gemini / Gemma Live API with automatic, transparent fallback to the validated REST endpoint (`/api/v1/ai/scene-assist`).

---

## 2. Architecture & Data Flow

```
[Mobile App (React Native / Expo)]
   │
   ├─► Camera Preview (Live frame capture, JPEG Base64, 1 FPS)
   ├─► Voice Recognition / Speech Dispatcher
   ├─► 4-Corner Tactile Interface (Top-L, Top-R, Bot-L, Bot-R)
   │
   ▼
[Transport Layer]
   │
   ├── Primary: WebSocket ws://<host>:8000/api/v1/ai/scene-live-ws
   │     ├── Stream frames (sequence_number, timestamp)
   │     ├── Asynchronous user queries ("Where are my keys?")
   │     └── Barge-in cancellation & session state
   │
   └── Fallback: HTTP POST http://<host>:8000/api/v1/ai/scene-assist
         └── One-shot analysis with shared grounding logic
   │
   ▼
[FastAPI Backend]
   │
   ├── [Live Session Manager] (Rate limits: 1 Hz, Frame size: <= 5MB)
   ├── [Shared Scene Grounding] (app.services.scene_grounding)
   └── [Google GenAI / Gemma Live Service] (client.aio.live.connect)
```

---

## 3. Client / Server Session Protocol

### Client → Server Messages

| Type | Payload Fields | Purpose |
| :--- | :--- | :--- |
| `activate` | `target_object?: string`, `client_id?: string` | User explicitly starts scene assistance. Frames sent prior to activation are rejected. |
| `frame` | `data: string` (Base64), `mime_type: string`, `timestamp: number`, `sequence_number: number` | Recent camera frame. Minimum 1.0s interval enforced on server. Max size 5 MB. |
| `query` | `query: string`, `target_object?: string` | Spoken user question (e.g. "Where are my keys?" or "What changed?"). |
| `pause` | _none_ | Pauses streaming without tearing down the session. |
| `resume` | _none_ | Resumes streaming and analysis. |
| `stop` | _none_ | Terminates session, releases model channels, and purges in-memory frame buffer. |
| `ping` | `timestamp?: number` | Heartbeat keep-alive (server replies with pong). |

### Server → Client Messages

| Type | Payload Fields | Purpose |
| :--- | :--- | :--- |
| `session_state` | `state: "connected" \| "active" \| "paused" \| "stopped"`, `spoken_description?: string` | Handshake acknowledgment or state transition announcement. |
| `description` | `spoken_description: string`, `confidence: number`, `image_quality: string`, `objects?: array` | Spoken natural language description of the current visual field. |
| `search_result` | `is_found: bool`, `target_object: string`, `relative_frame_position: string \| null`, `confidence: number`, `spoken_description: string`, `sweep_guidance: string \| null`, `next_action: string` | Grounded visual search outcome for targeted objects. |
| `error` | `message: string`, `code: string` | Actionable error information. Server logs internally and speaks audible guidance. |
| `pong` | `timestamp?: number` | Keepalive response. |

---

## 4. Grounded Object Search Policy

When asked *"Where are my keys?"*, the visual grounding engine strictly enforces safety invariants:

1. **Deterministic Bounding Box Quantization**:
   The frame is divided into 9 canonical sectors:
   - `upper-left`, `top-center`, `upper-right`
   - `center-left`, `center`, `center-right`
   - `lower-left`, `bottom-center`, `lower-right`
2. **Natural Relative Descriptions**:
   If keys are detected in sector `lower-left`:
   - Returns: `"I found your keys near the lower-left side of the table."`
   - `is_found: true`, `relative_frame_position: "lower-left"`.
3. **No Speculative Physical Distance**:
   Never generates statements like "the keys are 5 feet in front of you" or "reach out 30cm".
4. **Honest Absence & Sweep Guidance**:
   If keys are not visible in the frame:
   - Returns: `"I can't see the keys clearly yet. Slowly sweep the camera across the nearby surfaces and I'll keep checking."`
   - `is_found: false`, `next_action: "sweep_camera"`.
5. **Bounded Sweep Window**:
   Camera sweeps are bounded to a maximum of 5 attempts. If the object remains absent after 5 sweeps, Saarthi speaks:
   *"I still can't see the keys in this area. Move to another surface and ask again."* and resets searching state.

---

## 5. Four-Corner Tactile Interface

The interface follows the project-wide tactile design specified in `AGENTS.md`:

```
┌─────────────────────────────────┬─────────────────────────────────┐
│           TOP-LEFT              │           TOP-RIGHT             │
│   Describe Now (Tap)            │   Pause / Resume (Tap)          │
│   What Changed? (Long Press)    │   Accessible Emerald (#059669)  │
│   Accessible Blue (#2563EB)     │   Haptic: Medium Impact         │
│   Haptic: Light Impact          │                                 │
├─────────────────────────────────┼─────────────────────────────────┤
│                                 │                                 │
│          LIVE CAMERA            │         STATUS HUD              │
│       RETICLE & PREVIEW         │   Confidence, Quality, Audio    │
│                                 │                                 │
├─────────────────────────────────┼─────────────────────────────────┤
│          BOTTOM-LEFT            │          BOTTOM-RIGHT           │
│   Stop / Silence (Tap)          │   Find Keys (Tap)               │
│   Exit Assist (Long Press)      │   Push-to-Talk (Long Press)     │
│   Accessible Red (#DC2626)      │   Accessible Purple (#7C3AED)   │
│   Haptic: Warning Pulse         │   Haptic: Heavy Impact          │
└─────────────────────────────────┴─────────────────────────────────┘
```

### Accessibility Invariants
- **Minimum 56dp Touch Target**: Actual button dimensions are 78dp x 78dp with an additional 12dp `hitSlop` (102dp effective touch area).
- **TalkBack & VoiceOver**: Every button has `accessibilityRole="button"`, explicit `accessibilityLabel`, and contextual `accessibilityHint`.
- **WCAG AAA Contrast**: Labels rendered in pure white `#FFFFFF` on dark vibrant saturated backgrounds (contrast ratio > 7:1 against dark backdrop).
- **Audible & Haptic Feedback**: Every corner triggers a distinct tactile frequency (`expo-haptics`) and immediately speaks its action status.

---

## 6. Barge-In Interruption & Resource Cleanup

1. **Instant Speech Cutoff**: Tapping Bottom-Left (Stop) or pressing any active query immediately halts audio playback via `speechService.stop()`.
2. **In-Flight Cancellation**: An active `AbortController` aborts any network request in progress. Responses arriving after cancellation are discarded and never spoken.
3. **Session Teardown**:
   - WebSocket sends `stop` frame and cleanly closes connection.
   - Background sampling timers (`setInterval`, `setTimeout`) are cleared.
   - In-memory frame buffers are purged (zero frame retention).
   - Camera and microphone hardware streams are paused or released.
4. **Lifecycle Hooks**: `useEffect` cleanup handlers in `CameraAssistScreen` guarantee full release on screen unmount, route changes, or app backgrounding.

---

## 7. Verification Evidence & Test Results

### 1. Backend Automated Tests (Pytest)
```
72 passed in 7.99s (increased from 66 baseline)
```
- Handshake and initial connection state (`test_scene_live_ws_handshake`).
- Explicit activation requirement (`test_scene_live_ws_requires_activation`).
- Grounded query search with frame (`test_scene_live_ws_query_search`).
- Pause and resume protocol state transitions (`test_scene_live_ws_pause_resume`).
- REST grounding logic for found vs. absent objects (`test_scene_analysis_grounded_object_search_found`, `test_scene_analysis_grounded_object_search_not_found`).

### 2. Mobile Automated Tests (Jest)
```
Test Suites: 15 passed, 15 total
Tests:       216 passed, 216 total (increased from 210 baseline)
```
- Spoken activation greeting (*"Saarthi scene understanding is on. Point your camera around; ask me anything."*).
- Spoken stop confirmation (*"Scene understanding stopped."*).
- Spoken pause and resume transitions.
- Grounded visual search reporting relative positions (`lower-left`).
- Sweep guidance generation on absent objects.
- Bounded 5-sweep limit termination.
- Single-request-in-flight concurrency gating.
- Duplicate announcement suppression.
- Barge-in stop and in-flight cancellation.

### 3. Mobile TypeScript Type Check
```bash
npm run type-check
# tsc --noEmit: Exited with code 0 (0 errors)
```

---

## 8. Reproducible Run & Live Verification Instructions

### Step 1: Start the Backend Server
```bash
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

### Step 2: Run Automated Pytest Suite
```bash
cd backend
python -m pytest tests
```

### Step 3: Run Mobile Tests and Type Check
```bash
cd mobile
npm run type-check
npm test
```

### Step 4: Opt-In Real WebSocket Smoke Test
```bash
cd backend
# With optional Gemini API Key:
python scripts/smoke_test_live_scene.py --api-key YOUR_GEMINI_KEY
# Or using local server defaults:
python scripts/smoke_test_live_scene.py --url ws://127.0.0.1:8000/api/v1/ai/scene-live-ws
```

### Step 5: Run Mobile Application on Physical Device
```bash
cd mobile
npx expo start
```
- Scan QR code using Expo Go on Android or iOS.
- Grant camera and audio permissions when prompted.
- Double-tap or announce *"Open Scene Understanding"*.
- Hear greeting: *"Saarthi scene understanding is on. Point your camera around; ask me anything."*
- Tap Bottom-Right to search for keys, or tap Top-Left to describe what is visibly ahead.
- Tap Bottom-Left at any moment to instantly silence speech and stop the session.
