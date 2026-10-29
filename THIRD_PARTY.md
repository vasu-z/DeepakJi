# Third-Party Code & Dependency Audit

This document tracks all external code, libraries, and assets used in the **Saarthi** project in accordance with our standing open-source & originality rules.

## Policy
1. **Dependency First**: Always prefer using libraries as verified dependencies (`npm`, `pip`) over copy-pasting code.
2. **License Vetting**: Before incorporating code or dependencies:
   - Check and record the license.
   - Do **NOT** copy or include AGPL/GPL licensed code without explicit user approval.
3. **Tracking Requirement**: Any copied or adapted code snippet must be logged below with repository URL, author, commit/version, license type, exact files affected, and architectural rationale.

---

## Direct Dependencies Audit

### Backend (Python / FastAPI)
| Package | License | Purpose |
| :--- | :--- | :--- |
| `fastapi` | MIT | High-performance async REST API framework |
| `uvicorn` | BSD-3-Clause | ASGI server implementation |
| `pydantic` | MIT | Strict data validation and schema definitions |
| `pydantic-settings` | MIT | Typed environment configuration management |
| `google-genai` | Apache-2.0 | Official Google GenAI SDK for Gemini / Gemma models |
| `pytest` | MIT | Automated test framework |
| `httpx` | BSD-3-Clause | Async HTTP client for integration test execution |

### Mobile Client (React Native / Expo SDK 57)
| Package | License | Purpose |
| :--- | :--- | :--- |
| `expo` | MIT | Core Expo SDK runtime |
| `react` / `react-native` | MIT | Cross-platform declarative UI runtime |
| `expo-camera` | MIT | Native camera view and frame capture |
| `expo-speech` | MIT | Native Text-to-Speech (TTS) for audible responses |
| `expo-speech-recognition` | MIT | Real-time on-device voice input transcription |
| `expo-haptics` | MIT | Tactile feedback patterns for corner navigation and buttons |
| `@react-native-async-storage/async-storage` | MIT | On-device persistent key-value storage |
| `react-native-safe-area-context` | MIT | Dynamic safe area handling for notch/island |
| `@expo/vector-icons` | MIT | Accessible iconography |
| `expo-mlkit-ocr` | MIT | On-device Google ML Kit Text Recognition v2 |
| `expo-location` | MIT | Real-time GPS location tracking and accuracy reporting |
| `@maplibre/maplibre-react-native` | MIT | Interactive vector/raster campus mapping with OpenStreetMap tiles |
| `jest` / `ts-jest` | MIT | Unit testing suite for deterministic application logic |


---

## Third-Party Architectural References & Inspirations

The live scene understanding architecture in Saarthi synthesizes best practices from 4 audited reference repositories:

1. **GoogleCloudPlatform / generative-ai (`multimodal-live-api/websocket-demo-app`)**
   - **Repository**: [https://github.com/GoogleCloudPlatform/generative-ai](https://github.com/GoogleCloudPlatform/generative-ai)
   - **License**: Apache-2.0
   - **Contribution**: Bidirectional WebSocket protocol, setup handshake, realtime media chunk transmission, and server content event parsing.
   - **Affected Files**: `backend/app/services/live_session.py`, `backend/app/api/routes/ai.py`, `mobile/src/api/client.ts`.

2. **rkchellah / Nux**
   - **Repository**: [https://github.com/rkchellah/Nux](https://github.com/rkchellah/Nux)
   - **Contribution**: Long-lived single session management, client-side camera streaming loop with barge-in speech interruption.
   - **Affected Files**: `mobile/src/services/liveAssistService.ts`, `backend/app/api/routes/ai.py`.

3. **Digitalbrainstem / atlas-sight**
   - **Repository**: [https://github.com/Digitalbrainstem/atlas-sight](https://github.com/Digitalbrainstem/atlas-sight)
   - **Contribution**: Assistive navigation principles for visually impaired users: concise 1–2 sentence spoken descriptions of surroundings (doors, obstacles, stairs) without visual jargon.
   - **Affected Files**: `backend/app/services/scene_grounding.py`.

4. **nicedreamzapp / RealTimeAICam**
   - **Repository**: [https://github.com/nicedreamzapp/RealTimeAICam](https://github.com/nicedreamzapp/RealTimeAICam)
   - **License**: AGPL-3.0 (Zero code copied to strictly honor AGENTS.md license restrictions and keep Saarthi Apache-2.0 compliant).
   - **Contribution**: Conceptual cadence loop pattern: camera rotation sensing, duplicate description suppression window, and TalkBack / VoiceOver spoken announcements.
   - **Affected Files**: `mobile/src/services/liveAssistService.ts`, `mobile/src/screens/CameraAssistScreen.tsx`.

