from datetime import datetime, timedelta
from cryptography.fernet import Fernet
from jose import jwt, JWTError
from app.config import settings

SESSION_TTL_DAYS = 7
fernet = Fernet(settings.token_encryption_key.encode())


def encrypt_token(token: str) -> str:
    return fernet.encrypt(token.encode()).decode()


def decrypt_token(encrypted: str) -> str:
    return fernet.decrypt(encrypted.encode()).decode()


def create_session_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)
    return jwt.encode(
        {"sub": user_id, "exp": expire},
        settings.secret_key,
        algorithm="HS256",
    )


def decode_session_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        return payload.get("sub")
    except JWTError:
        return None
