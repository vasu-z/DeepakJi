from functools import lru_cache
import json
import os
from typing import Any, List, Optional
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables or .env file."""

    PROJECT_NAME: str = "SAARTHI API"
    VERSION: str = "0.1.0"
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = "development"

    # CORS configuration
    CORS_ORIGINS: List[str] = [
        "*",
        "http://localhost:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8081",
    ]
    CORS_ALLOW_CREDENTIALS: bool = False

    # Gemini / Gemma API configuration
    GEMINI_API_KEY: Optional[str] = None
    GEMINI_MODEL: str = "gemini-3-flash-preview"
    GEMINI_LIVE_MODEL: str = "gemini-3.8-live"
    ENABLE_AI_MOCK: bool = False

    # Valhalla Open-Source Routing Engine configuration
    VALHALLA_API_URL: str = "https://valhalla1.openstreetmap.de/route"
    VALHALLA_TIMEOUT_SECONDS: float = 12.0

    @property
    def is_gemini_configured(self) -> bool:
        """Check if a non-empty Gemini API key or Google Cloud ADC is configured."""
        if bool(self.GEMINI_API_KEY and self.GEMINI_API_KEY.strip()):
            return True
        gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if gac and os.path.isfile(gac):
            return True
        adc_win = os.path.expandvars(r"%APPDATA%\gcloud\application_default_credentials.json")
        if os.path.isfile(adc_win):
            return True
        adc_unix = os.path.expanduser("~/.config/gcloud/application_default_credentials.json")
        if os.path.isfile(adc_unix):
            return True
        return False

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> List[str]:
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("[") and value.endswith("]"):
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, list):
                        return [str(item).strip() for item in parsed]
                except json.JSONDecodeError:
                    pass
            # Comma-separated fallback
            return [item.strip() for item in value.split(",") if item.strip()]
        if isinstance(value, (list, tuple, set)):
            return [str(item).strip() for item in value]
        return value

    @model_validator(mode="before")
    @classmethod
    def resolve_gemini_key_fallback(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # Fall back to GOOGLE_API_KEY or GEMINI_KEY only if GEMINI_API_KEY is not explicitly set
            if data.get("GEMINI_API_KEY") is None and "GEMINI_API_KEY" not in os.environ:
                google_key = (
                    data.get("GOOGLE_API_KEY")
                    or os.getenv("GOOGLE_API_KEY")
                    or data.get("GEMINI_KEY")
                    or os.getenv("GEMINI_KEY")
                )
                if google_key:
                    data["GEMINI_API_KEY"] = google_key
        return data

    @model_validator(mode="after")
    def validate_cors_credentials(self) -> "Settings":
        if self.CORS_ALLOW_CREDENTIALS and "*" in self.CORS_ORIGINS:
            raise ValueError(
                "Wildcard origin '*' cannot be used when CORS_ALLOW_CREDENTIALS is True."
            )
        return self

    model_config = SettingsConfigDict(
        env_file=(
            ".env",
            "backend/.env",
            os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env"),
        ),
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """Return a cached instance of the application settings."""
    return Settings()
