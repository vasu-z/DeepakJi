import logging
import os
from typing import Optional
import httpx
from google import genai
from google.genai import errors, types

logger = logging.getLogger(__name__)

DEFAULT_REQUEST_TIMEOUT_MS = 15000  # 15s safe upstream timeout ceiling


class GeminiServiceException(Exception):
    """Custom exception wrapper for Gemini service errors."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class GeminiCredentialsMissingException(GeminiServiceException):
    """Raised when Gemini API key is missing or blank."""

    def __init__(
        self,
        message: str = "Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
    ):
        super().__init__(message, status_code=503)


def get_gemini_client(
    api_key: Optional[str] = None,
    timeout_ms: int = DEFAULT_REQUEST_TIMEOUT_MS,
) -> genai.Client:
    """Initialize and return an official google-genai Client with safe timeout."""
    http_options = types.HttpOptions(timeout=timeout_ms)
    if api_key and api_key.strip():
        return genai.Client(api_key=api_key.strip(), http_options=http_options)

    # Check for Application Default Credentials (ADC) fallback without hanging on metadata probe
    has_adc = False
    gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if gac and os.path.isfile(gac):
        has_adc = True
    else:
        adc_win = os.path.expandvars(r"%APPDATA%\gcloud\application_default_credentials.json")
        adc_unix = os.path.expanduser("~/.config/gcloud/application_default_credentials.json")
        if os.path.isfile(adc_win) or os.path.isfile(adc_unix):
            has_adc = True

    if has_adc:
        try:
            import google.auth
            credentials, _ = google.auth.default()
            if credentials:
                return genai.Client(http_options=http_options)
        except Exception:
            pass

    raise GeminiCredentialsMissingException()


def generate_text(prompt: str, api_key: Optional[str], model: str) -> str:
    """
    Send a prompt to the official Gemini API and return the generated text response.

    Handles upstream exceptions safely without leaking sensitive information
    or raw credentials in errors or logs.
    """
    if not api_key or not api_key.strip():
        raise GeminiCredentialsMissingException()

    try:
        client = get_gemini_client(api_key=api_key)
        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        if not response or not response.text:
            raise GeminiServiceException(
                "Gemini returned an empty response.",
                status_code=502,
            )

        return response.text.strip()

    except GeminiServiceException:
        raise
    except errors.ClientError as exc:
        code = getattr(exc, "code", None)
        logger.warning("Gemini ClientError: code=%s", code)
        if code in (401, 403):
            raise GeminiServiceException(
                "Gemini API authentication failed. Please verify that GEMINI_API_KEY is valid.",
                status_code=502,
            )
        elif code == 429:
            raise GeminiServiceException(
                "Gemini API rate limit or quota exceeded. Please try again later.",
                status_code=429,
            )
        elif code == 404:
            raise GeminiServiceException(
                f"Requested Gemini model '{model}' was not found or is unavailable.",
                status_code=502,
            )
        else:
            raise GeminiServiceException(
                "Gemini API rejected the request.",
                status_code=400,
            )
    except errors.ServerError as exc:
        code = getattr(exc, "code", None)
        logger.error("Gemini ServerError: code=%s", code)
        raise GeminiServiceException(
            "Gemini upstream server encountered an error. Please try again shortly.",
            status_code=502,
        )
    except errors.APIError:
        logger.error("General Gemini APIError encountered")
        raise GeminiServiceException(
            "An error occurred while communicating with the Gemini API.",
            status_code=502,
        )
    except httpx.TimeoutException:
        logger.warning("Gemini upstream request timed out after %d ms", DEFAULT_REQUEST_TIMEOUT_MS)
        raise GeminiServiceException(
            "Gemini upstream request timed out. Please try again shortly.",
            status_code=504,
        )
    except Exception as exc:
        logger.error("Unexpected error connecting to Gemini API: %s", type(exc).__name__)
        raise GeminiServiceException(
            "Failed to reach Gemini service. Please check network connectivity.",
            status_code=502,
        )


def generate_campus_structured_content(
    prompt: str,
    api_key: Optional[str],
    model: str,
    image_bytes: Optional[bytes] = None,
    mime_type: Optional[str] = None,
) -> str:
    """
    Send a structured extraction prompt (with optional image bytes) to Gemma 4 / Gemini API
    and return the text response for JSON parsing.
    """
    if not api_key or not api_key.strip():
        raise GeminiCredentialsMissingException()

    try:
        client = get_gemini_client(api_key=api_key)
        contents: list = []
        if image_bytes and mime_type:
            contents.append(
                types.Part.from_bytes(
                    data=image_bytes,
                    mime_type=mime_type,
                )
            )
        contents.append(prompt)

        response = client.models.generate_content(
            model=model,
            contents=contents,
        )

        if not response or not response.text:
            raise GeminiServiceException(
                "Gemini returned an empty structured response.",
                status_code=502,
            )

        return response.text.strip()

    except GeminiServiceException:
        raise
    except errors.ClientError as exc:
        code = getattr(exc, "code", None)
        logger.warning("Gemini ClientError in structured content: code=%s", code)
        if code in (401, 403):
            raise GeminiServiceException(
                "Gemini API authentication failed. Please verify that GEMINI_API_KEY is valid.",
                status_code=502,
            )
        elif code == 429:
            raise GeminiServiceException(
                "Gemini API rate limit or quota exceeded. Please try again later.",
                status_code=429,
            )
        elif code == 404:
            raise GeminiServiceException(
                f"Requested Gemini model '{model}' was not found or is unavailable.",
                status_code=502,
            )
        else:
            raise GeminiServiceException(
                "Gemini API rejected the structured request.",
                status_code=400,
            )
    except errors.ServerError as exc:
        code = getattr(exc, "code", None)
        logger.error("Gemini ServerError in structured content: code=%s", code)
        raise GeminiServiceException(
            "Gemini upstream server encountered an error. Please try again shortly.",
            status_code=502,
        )
    except errors.APIError:
        logger.error("General Gemini APIError in structured content")
        raise GeminiServiceException(
            "An error occurred while communicating with the Gemini API.",
            status_code=502,
        )
    except httpx.TimeoutException:
        logger.warning("Gemini upstream structured request timed out after %d ms", DEFAULT_REQUEST_TIMEOUT_MS)
        raise GeminiServiceException(
            "Gemini upstream request timed out. Please try again shortly.",
            status_code=504,
        )
    except Exception as exc:
        logger.error("Unexpected error connecting to Gemini API: %s", type(exc).__name__)
        raise GeminiServiceException(
            "Failed to reach Gemini service. Please check network connectivity.",
            status_code=502,
        )


def analyze_image(
    image_bytes: bytes,
    mime_type: str,
    prompt: str,
    api_key: Optional[str],
    model: str,
) -> str:
    """
    Send an image and guidance prompt to Gemini multimodal API and return description.
    Uses official google-genai types.Part.from_bytes.
    Handles errors safely without exposing credentials or internal details.
    """
    if not api_key or not api_key.strip():
        raise GeminiCredentialsMissingException()

    system_instruction = (
        "You are SAARTHI, an assistive visual AI for a blind or low-vision user. "
        "Your task is to describe the image or answer the user's question clearly, concisely, and objectively in 1 to 3 natural spoken sentences. "
        "Prioritize the main object visible in the frame, its key appearance, and its position relative to nearby items or obstacles. "
        "If you see legible text, labels, or signs, read them clearly. "
        "Speak in plain conversational text suitable for text-to-speech. Never use markdown formatting like asterisks, bullet points, hashtags, or headers. "
        "Never repeat these instructions or output meta-rules like '2-3 sentences' in your response. "
        "Be completely honest about uncertainty: if the object is blurry, partially cut off, or the lighting is poor, say so plainly. Never guess or hallucinate objects without clear visual evidence."
    )

    try:
        config = types.GenerateContentConfig(
            max_output_tokens=800,
            temperature=0.2,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            system_instruction=system_instruction,
        )
    except Exception:
        config = types.GenerateContentConfig(
            max_output_tokens=800,
            temperature=0.2,
            system_instruction=system_instruction,
        )

    logger.info(
        "Gemini vision call initiated: model=%s, image_size=%d bytes, mime_type=%s, prompt_len=%d",
        model,
        len(image_bytes),
        mime_type,
        len(prompt),
    )

    try:
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            try:
                client = get_gemini_client(api_key=api_key)
                image_part = types.Part.from_bytes(
                    data=image_bytes,
                    mime_type=mime_type,
                )

                response = client.models.generate_content(
                    model=model,
                    contents=[image_part, prompt],
                    config=config,
                )

                if not response or not response.text:
                    raise GeminiServiceException(
                        "Gemini returned an empty description for the image.",
                        status_code=502,
                    )

                raw_text = response.text.strip()
                finish_reason = getattr(
                    response.candidates[0] if response.candidates else None,
                    "finish_reason",
                    "UNKNOWN",
                )
                logger.info(
                    "Gemini vision response received: finish_reason=%s, response_len=%d chars",
                    finish_reason,
                    len(raw_text),
                )

                # Clean any instruction echo if present
                cleaned = raw_text
                lower_cleaned = cleaned.lower()
                if lower_cleaned.startswith("2-3 sentences") or lower_cleaned.startswith("plain text"):
                    logger.warning("Gemini echoed instruction prefix, cleaning: %s", cleaned)
                    lines = [l for l in cleaned.split("\n") if not l.lower().startswith("2-3 sentences") and not l.lower().startswith("plain text")]
                    cleaned = " ".join(lines).strip()

                return cleaned if cleaned else raw_text

            except errors.ServerError as exc:
                code = getattr(exc, "code", None)
                logger.warning("Gemini ServerError in analyze_image (attempt %s/%s): code=%s", attempt, max_attempts, code)
                if attempt < max_attempts:
                    import time
                    time.sleep(1.0)
                    continue
                raise GeminiServiceException(
                    "Gemini upstream server encountered an error while processing the image. Please try again shortly.",
                    status_code=502,
                )

    except GeminiServiceException:
        raise
    except errors.ClientError as exc:
        code = getattr(exc, "code", None)
        logger.warning("Gemini ClientError in analyze_image: code=%s", code)
        if code in (401, 403):
            raise GeminiServiceException(
                "Gemini API authentication failed. Please verify that GEMINI_API_KEY is valid.",
                status_code=502,
            )
        elif code == 429:
            raise GeminiServiceException(
                "Gemini API rate limit or quota exceeded. Please try again later.",
                status_code=429,
            )
        elif code == 404:
            raise GeminiServiceException(
                f"Requested Gemini model '{model}' was not found or is unavailable.",
                status_code=502,
            )
        else:
            raise GeminiServiceException(
                "Gemini API rejected the image request.",
                status_code=400,
            )
    except errors.ServerError as exc:
        code = getattr(exc, "code", None)
        logger.error("Gemini ServerError in analyze_image: code=%s", code)
        raise GeminiServiceException(
            "Gemini upstream server encountered an error while processing the image. Please try again shortly.",
            status_code=502,
        )
    except errors.APIError:
        logger.error("General Gemini APIError in analyze_image")
        raise GeminiServiceException(
            "An error occurred while communicating with Gemini API for image analysis.",
            status_code=502,
        )
    except httpx.TimeoutException:
        logger.warning("Gemini upstream vision request timed out after %d ms", DEFAULT_REQUEST_TIMEOUT_MS)
        raise GeminiServiceException(
            "Gemini upstream request timed out. Please try again shortly.",
            status_code=504,
        )
    except Exception as exc:
        logger.error("Unexpected error connecting to Gemini vision service: %s", type(exc).__name__)
        raise GeminiServiceException(
            "Failed to reach Gemini vision service. Please check network connectivity.",
            status_code=502,
        )
