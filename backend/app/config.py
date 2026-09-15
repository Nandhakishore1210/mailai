from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    google_client_id: str
    google_client_secret: str
    google_redirect_uri: str
    anthropic_api_key: str
    frontend_url: str = "http://localhost:3000"
    token_encryption_key: str  # 32-byte URL-safe base64
    # Optional: enables true Gmail push. projects/<id>/topics/<topic>.
    # Unset (local dev) -> server-side history polling fallback.
    gmail_pubsub_topic: Optional[str] = None
    # Shared secret appended to the Pub/Sub push URL. The webhook is public,
    # so without this anyone could trigger mailbox checks.
    gmail_push_token: Optional[str] = None

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
