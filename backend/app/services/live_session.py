"""
Gemini Live Session Manager.

Encapsulates bidirectional streaming with the official Gemini Multimodal Live API
via the `google-genai` SDK (`client.aio.live.connect`).

Reuses official patterns from Google Cloud Platform:
https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/multimodal-live-api
"""

import asyncio
import logging
from typing import AsyncGenerator, Optional

from google.genai import types

from app.services.gemini import get_gemini_client

logger = logging.getLogger(__name__)


class GeminiLiveSession:
    """Manages an active bidirectional Gemini Multimodal Live session."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "gemini-3.8-live",
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.client = get_gemini_client(api_key=api_key)
        self.session = None
        self._context_manager = None
        self.is_connected = False
        self.last_error: Optional[str] = None

    async def start(self, system_instruction: Optional[str] = None) -> bool:
        """Connect to the Gemini Live server with audio/text response modality."""
        config = {
            "response_modalities": ["AUDIO"],
        }
        if system_instruction:
            config["system_instruction"] = system_instruction

        try:
            self._context_manager = self.client.aio.live.connect(
                model=self.model,
                config=config,
            )
            self.session = await self._context_manager.__aenter__()
            self.is_connected = True
            self.last_error = None
            logger.info("Gemini Live session established: model=%s", self.model)
            return True
        except Exception as exc:
            self.last_error = str(exc)
            logger.warning("Failed to establish Gemini Live connection (%s): %s", self.model, exc)
            self.session = None
            self._context_manager = None
            self.is_connected = False
            return False

    async def send_frame(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> bool:
        """Stream a real-time camera image frame to the model context."""
        if not self.session or not self.is_connected:
            logger.warning("[DIAGNOSTIC LIVE] send_frame called but session not connected.")
            return False
        try:
            blob = types.Blob(data=image_bytes, mime_type=mime_type)
            await self.session.send_realtime_input(media=blob)
            logger.debug("[DIAGNOSTIC LIVE] Frame streamed downstream to Gemini: bytes=%d, mime=%s", len(image_bytes), mime_type)
            return True
        except Exception as exc:
            logger.warning("[DIAGNOSTIC LIVE] Error streaming frame to Gemini Live: %s", exc)
            return False

    async def send_query(
        self,
        query: str,
        image_bytes: Optional[bytes] = None,
        mime_type: str = "image/jpeg",
    ) -> bool:
        """Send a user conversational turn with optional current frame image."""
        if not self.session or not self.is_connected:
            logger.warning("[DIAGNOSTIC LIVE] send_query called but session not connected.")
            return False
        try:
            parts = []
            if image_bytes:
                parts.append(
                    types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime_type))
                )
            parts.append(types.Part(text=query))
            content = types.Content(role="user", parts=parts)
            await self.session.send_client_content(turns=content, turn_complete=True)
            logger.info(
                "[DIAGNOSTIC LIVE] Dispatched turn to Gemini Live: query='%s', image_attached=%s (bytes=%d)",
                query,
                bool(image_bytes),
                len(image_bytes) if image_bytes else 0,
            )
            return True
        except Exception as exc:
            logger.warning("[DIAGNOSTIC LIVE] Error sending query to Gemini Live: %s", exc)
            return False

    async def receive_text(self, timeout_sec: float = 12.0) -> Optional[str]:
        """Receive the accumulated spoken text response for the current turn."""
        if not self.session or not self.is_connected:
            logger.warning("[DIAGNOSTIC LIVE] receive_text called but session not connected.")
            return None

        import time
        start_t = time.time()
        collected_parts = []
        try:
            async def _receive_loop():
                async for message in self.session.receive():
                    sc = message.server_content
                    if sc:
                        if sc.output_transcription and sc.output_transcription.text:
                            collected_parts.append(sc.output_transcription.text)
                        if sc.model_turn:
                            for part in sc.model_turn.parts:
                                if part.text:
                                    collected_parts.append(part.text)
                        if sc.turn_complete:
                            break

            await asyncio.wait_for(_receive_loop(), timeout=timeout_sec)
            elapsed = time.time() - start_t
            result = "".join(collected_parts).strip() if collected_parts else None
            logger.info(
                "[DIAGNOSTIC LIVE] Gemini Live response received: elapsed=%.2fs, chars=%d, text='%s'",
                elapsed,
                len(result) if result else 0,
                result or "<empty>",
            )
            return result
        except asyncio.TimeoutError:
            elapsed = time.time() - start_t
            result = "".join(collected_parts).strip() if collected_parts else None
            logger.warning("[DIAGNOSTIC LIVE] Gemini Live response timed out after %.1fs (got %d chars)", elapsed, len(result) if result else 0)
            return result
        except Exception as exc:
            logger.warning("[DIAGNOSTIC LIVE] Error receiving from Gemini Live session: %s", exc)
            return None

    async def close(self) -> None:
        """Cleanly close and terminate the Live session."""
        self.is_connected = False
        if self._context_manager and self.session:
            try:
                await self._context_manager.__aexit__(None, None, None)
            except Exception as exc:
                logger.debug("Safe ignore on live session close: %s", exc)
            self.session = None
            self._context_manager = None
            logger.info("Gemini Live session closed cleanly.")
