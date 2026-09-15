"""
Per-account service cache.

Without this, every request paid for a Google token refresh (a network round
trip, and it ran on the event loop) or a fresh IMAP TLS login (1-2 s on
Gmail). Now:
- Gmail: the refreshed Credentials are cached until shortly before expiry.
  A new GmailMailService is still built per request (cheap, and keeps the
  underlying httplib2 client per-request, which is required for thread safety).
- IMAP: one ImapMailService instance per account, holding a persistent,
  lock-protected IMAP connection that reconnects on demand.
"""
import asyncio
import threading
from datetime import datetime, timedelta
from typing import Optional

from app.auth.google_oauth import refresh_credentials
from app.auth.sessions import decrypt_token
from app.db.models import MailAccount
from app.mail.gmail import GmailMailService
from app.mail.imap import ImapMailService
from app.mail.service import MailService

_gmail_creds: dict[str, object] = {}
_imap_services: dict[str, ImapMailService] = {}
_lock = threading.Lock()
_REFRESH_MARGIN = timedelta(minutes=3)


def _creds_fresh(creds) -> bool:
    if creds is None or not getattr(creds, "token", None):
        return False
    expiry: Optional[datetime] = getattr(creds, "expiry", None)
    if expiry is None:
        return True
    return expiry - datetime.utcnow() > _REFRESH_MARGIN


async def get_mail_service(account: MailAccount) -> MailService:
    if account.provider == "imap":
        password = decrypt_token(account.encrypted_refresh_token)
        with _lock:
            svc = _imap_services.get(account.id)
            stale = (
                svc is None
                or svc.email != account.provider_email
                or svc.password != password
                or (account.imap_host and svc.imap_host != account.imap_host)
            )
            if stale:
                if svc is not None:
                    svc.close()
                svc = ImapMailService(account.provider_email, password, account.imap_host, account.smtp_host)
                _imap_services[account.id] = svc
        return svc

    creds = _gmail_creds.get(account.id)
    if not _creds_fresh(creds):
        creds = await asyncio.to_thread(refresh_credentials, account.encrypted_refresh_token, decrypt_token)
        _gmail_creds[account.id] = creds
    return GmailMailService(creds)


def forget(account_id: str) -> None:
    """Drop cached state for an account (call after re-login or credential change)."""
    with _lock:
        _gmail_creds.pop(account_id, None)
        svc = _imap_services.pop(account_id, None)
    if svc is not None:
        svc.close()
