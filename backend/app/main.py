from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response, HTTPException, Depends, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
import asyncio
import json
import time
import httpx
import anthropic
from fastapi.responses import StreamingResponse

from app.config import settings
from app.db.init_db import init_db
from app.db.session import get_db
from app.db.models import User, MailAccount, AssistantConversation, AssistantMessage
from app.auth.google_oauth import build_auth_url, exchange_code, refresh_credentials
from app.auth.sessions import encrypt_token, decrypt_token, create_session_token, decode_session_token
from app.mail.gmail import GmailMailService
from app.mail.imap import verify_login, detect_hosts, MailAuthError
from app.mail.registry import get_mail_service, forget as forget_mail_service
from app.mail.service import MailFilters, MAILBOXES
from app.mail.cache import mailbox_cache
from app.realtime.watcher import watchers
from app.realtime.gmail_push import register_watch, parse_notification, push_enabled
from app.assistant.agent import run_assistant
from dataclasses import asdict


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield
    watchers.shutdown()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── helpers ──────────────────────────────────────────────────────────────────

def get_current_user(
    session_token: Optional[str] = Cookie(None),
    db: Session = Depends(get_db),
) -> tuple[User, MailAccount]:
    if not session_token:
        raise HTTPException(401, "Not authenticated")
    user_id = decode_session_token(session_token)
    if not user_id:
        raise HTTPException(401, "Invalid session")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(401, "User not found")
    account = db.query(MailAccount).filter(MailAccount.user_id == user_id).first()
    if not account:
        raise HTTPException(403, "No Gmail account connected")
    return user, account


def _set_session_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        "session_token", create_session_token(user_id),
        httponly=True, secure=False, samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )


# ── auth routes ───────────────────────────────────────────────────────────────

@app.get("/auth/google")
def google_auth():
    url, _ = build_auth_url()
    return {"url": url}


@app.get("/auth/google/callback")
async def google_callback(code: str, state: str, db: Session = Depends(get_db)):
    token_data = exchange_code(code, state)
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {token_data['access_token']}"},
        )
    info = resp.json()
    email = info["email"]
    name = info.get("name", email)

    user = db.query(User).filter(User.email == email).first()
    if not user:
        user = User(email=email, name=name)
        db.add(user)
        db.flush()

    account = db.query(MailAccount).filter(MailAccount.user_id == user.id).first()
    encrypted = encrypt_token(token_data["refresh_token"])
    if account:
        account.provider = "gmail"
        account.provider_email = email
        account.encrypted_refresh_token = encrypted
        account.history_id = None
    else:
        account = MailAccount(
            user_id=user.id,
            provider_email=email,
            encrypted_refresh_token=encrypted,
        )
        db.add(account)

    db.commit()
    forget_mail_service(account.id)
    # Register Gmail push (no-op unless GMAIL_PUBSUB_TOPIC is configured).
    if push_enabled():
        creds = refresh_credentials(account.encrypted_refresh_token, decrypt_token)
        start_history = await register_watch(creds)
        if start_history:
            account.history_id = start_history
            db.commit()
    response = RedirectResponse(url=f"{settings.frontend_url}/inbox")
    _set_session_cookie(response, user.id)
    return response


@app.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie("session_token")
    return {"ok": True}


class PasswordLogin(BaseModel):
    email: str
    password: str
    imap_host: Optional[str] = None
    smtp_host: Optional[str] = None


@app.post("/auth/password")
async def password_login(body: PasswordLogin, response: Response, db: Session = Depends(get_db)):
    """
    Sign in with an email address and password (Gmail: an App Password) over
    IMAP/SMTP. Works for any mailbox, no Google OAuth verification needed.
    """
    email_addr = body.email.strip().lower()
    if "@" not in email_addr or not body.password:
        raise HTTPException(400, "Enter an email address and password.")
    default_imap, default_smtp = detect_hosts(email_addr)
    imap_host = (body.imap_host or "").strip() or default_imap
    smtp_host = (body.smtp_host or "").strip() or default_smtp

    try:
        await asyncio.to_thread(verify_login, email_addr, body.password, imap_host)
    except MailAuthError as exc:
        raise HTTPException(401, str(exc))

    user = db.query(User).filter(User.email == email_addr).first()
    if not user:
        user = User(email=email_addr, name=email_addr.split("@")[0])
        db.add(user)
        db.flush()

    account = db.query(MailAccount).filter(MailAccount.user_id == user.id).first()
    encrypted = encrypt_token(body.password)
    if account:
        account.provider = "imap"
        account.provider_email = email_addr
        account.encrypted_refresh_token = encrypted
        account.imap_host = imap_host
        account.smtp_host = smtp_host
        account.history_id = None
    else:
        db.add(MailAccount(
            user_id=user.id, provider="imap", provider_email=email_addr,
            encrypted_refresh_token=encrypted, imap_host=imap_host, smtp_host=smtp_host,
        ))
    db.commit()
    acct = db.query(MailAccount).filter(MailAccount.user_id == user.id).first()
    if acct:
        forget_mail_service(acct.id)
    _set_session_cookie(response, user.id)
    return {"ok": True, "email": email_addr, "provider": "imap"}


@app.get("/auth/me")
def me(auth=Depends(get_current_user)):
    user, account = auth
    return {
        "id": user.id, "email": user.email, "name": user.name,
        "gmail": account.provider_email, "provider": account.provider,
    }


# ── mail routes ───────────────────────────────────────────────────────────────

@app.get("/mail/inbox")
async def inbox(max_results: int = 20, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    emails = await svc.list_inbox(max_results)
    return [asdict(e) for e in emails]


@app.get("/mail/sent")
async def sent(max_results: int = 20, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    emails = await svc.list_sent(max_results)
    return [asdict(e) for e in emails]


@app.get("/mail/box/{box}")
async def list_box(box: str, max_results: int = 20, auth=Depends(get_current_user)):
    if box not in MAILBOXES:
        raise HTTPException(404, "Unknown mailbox")
    _, account = auth
    cached = mailbox_cache.get(account.id, box, max_results)
    if cached is not None:
        return [asdict(e) for e in cached]
    svc = await get_mail_service(account)
    emails = await svc.list_mailbox(box, max_results)
    mailbox_cache.put(account.id, box, max_results, emails)
    return [asdict(e) for e in emails]


@app.get("/mail/sync/status")
async def sync_status(auth=Depends(get_current_user)):
    """
    Is realtime healthy? Shows whether Gmail push is configured and when a
    push last arrived. `seconds_since_last_push` staying None on a Gmail
    account with the topic set usually means the tunnel URL changed and the
    Pub/Sub subscription is pointing at a dead address.
    """
    _, account = auth
    watcher = watchers.find(account.id)
    return {
        "provider": account.provider,
        "push_configured": push_enabled(),
        "push_token_required": bool(getattr(settings, "gmail_push_token", None)),
        "watching": watcher is not None,
        "subscribers": len(watcher._subscribers) if watcher else 0,
        "events_emitted": watcher._seq if watcher else 0,
        "seconds_since_last_push": (
            round(time.time() - watcher.last_push_at, 1)
            if watcher and watcher.last_push_at else None
        ),
        "seconds_since_last_event": (
            round(time.time() - watcher.last_event_at, 1)
            if watcher and watcher.last_event_at else None
        ),
    }


@app.get("/mail/sync/stream")
async def sync_stream(request: Request, auth=Depends(get_current_user)):
    """
    Server-Sent Events. The browser opens this once and is pushed to when the
    mailbox changes; it never polls.

    Each event carries an `id` and the current inbox, so the client renders new
    mail with no follow-up request. A browser reconnecting after sleep or a
    dropped network replays what it missed via `Last-Event-ID`, or is told to
    resync if it has fallen past the buffer.
    """
    _, account = auth
    watcher = watchers.get(account.id)

    raw_last = request.headers.get("last-event-id")
    try:
        last_id = int(raw_last) if raw_last else None
    except ValueError:
        last_id = None

    missed = watcher.replay_since(last_id)
    queue = watcher.subscribe()

    def frame(payload: dict) -> str:
        return f"id: {payload['id']}\nevent: change\ndata: {json.dumps(payload)}\n\n"

    async def events():
        yield ": connected\n\n"
        try:
            if missed is None:
                # Too far behind to replay: tell the client to refetch everything.
                yield f"event: resync\ndata: {json.dumps({'reason': 'gap'})}\n\n"
            else:
                for payload in missed:
                    yield frame(payload)

            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                    yield frame(payload)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"   # keep proxies from closing the stream
        finally:
            watcher.unsubscribe(queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/webhook/gmail")
async def gmail_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Pub/Sub push endpoint for Gmail notifications. Wakes the account's SSE
    subscribers immediately. Always returns 200 so Pub/Sub does not retry.
    """
    expected = getattr(settings, "gmail_push_token", None)
    if expected and request.query_params.get("token") != expected:
        # Public endpoint: reject anything that is not our subscription.
        raise HTTPException(403, "Bad push token")
    try:
        address = parse_notification(await request.json())
    except Exception:
        return {"ok": True}
    if not address:
        return {"ok": True}
    account = db.query(MailAccount).filter(MailAccount.provider_email == address).first()
    if account:
        # Wake rather than notify: the watcher confirms what changed and
        # attaches the inbox, so the browser needs no follow-up request.
        watchers.wake(account.id, pushed=True)
    return {"ok": True}


@app.post("/mail/sync/wake")
async def sync_wake(auth=Depends(get_current_user)):
    """Ask the watcher to check right now (called when a tab regains focus)."""
    _, account = auth
    watchers.wake(account.id)
    return {"ok": True}


@app.get("/mail/sync/poll")
async def poll_sync(auth=Depends(get_current_user), db: Session = Depends(get_db)):
    _, account = auth
    svc = await get_mail_service(account)
    changed, new_cursor = await svc.check_changes(account.history_id)
    # Only persist when no watcher owns this account, otherwise two writers
    # fight over the cursor and changes get consumed twice or lost.
    if new_cursor != account.history_id and watchers.find(account.id) is None:
        account.history_id = new_cursor
        db.commit()
    return {"changed": changed}


class ReadRequest(BaseModel):
    read: bool = True


async def _message_op(op: str, message_id: str, account) -> dict:
    svc = await get_mail_service(account)
    try:
        await getattr(svc, op)(message_id)
    except Exception as exc:
        raise HTTPException(404, f"Could not {op.replace('_', ' ')}: {exc}")
    mailbox_cache.invalidate(account.id)
    return {"ok": True, "id": message_id, "op": op}


@app.post("/mail/{message_id}/trash")
async def trash_message(message_id: str, auth=Depends(get_current_user)):
    return await _message_op("trash_message", message_id, auth[1])


@app.post("/mail/{message_id}/spam")
async def spam_message(message_id: str, auth=Depends(get_current_user)):
    return await _message_op("mark_spam", message_id, auth[1])


@app.post("/mail/{message_id}/restore")
async def restore_message(message_id: str, auth=Depends(get_current_user)):
    return await _message_op("restore_message", message_id, auth[1])


@app.delete("/mail/{message_id}")
async def delete_message_forever(message_id: str, auth=Depends(get_current_user)):
    return await _message_op("delete_forever", message_id, auth[1])


@app.post("/mail/{message_id}/read")
async def mark_read(message_id: str, body: ReadRequest, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    try:
        await svc.set_read(message_id, body.read)
    except Exception:
        raise HTTPException(404, "Message not found")
    mailbox_cache.invalidate(account.id)
    return {"ok": True, "id": message_id, "read": body.read}


@app.get("/mail/thread/{thread_id}")
async def get_thread(thread_id: str, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    try:
        messages = await svc.get_thread(thread_id)
    except Exception:
        raise HTTPException(404, "Thread not found")
    return [asdict(m) for m in messages]


@app.get("/mail/{message_id}")
async def get_email(message_id: str, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    try:
        detail = await svc.get_message(message_id)
    except Exception:
        raise HTTPException(404, "Message not found")
    return asdict(detail)


class SearchRequest(BaseModel):
    sender: Optional[str] = None
    keyword: Optional[str] = None
    unread: Optional[bool] = None
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    newer_than_days: Optional[int] = None
    scope: Optional[str] = None


@app.post("/mail/search")
async def search(body: SearchRequest, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    filters = MailFilters(**body.model_dump())
    results = await svc.search_messages(filters)
    return [asdict(e) for e in results]


class SendRequest(BaseModel):
    to: list[str]
    subject: str
    body: str


@app.post("/mail/send")
async def send_mail(body: SendRequest, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    msg_id = await svc.send_message(body.to, body.subject, body.body)
    mailbox_cache.invalidate(account.id)
    # The realtime watcher owns account.history_id. Writing it here too would
    # make the watcher skip or replay changes, so we leave it alone; the
    # watcher notices the new Sent message on its next check.
    return {"sent_id": msg_id}


class ReplyRequest(BaseModel):
    message_id: str
    body: str


@app.post("/mail/reply")
async def reply_mail(body: ReplyRequest, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    msg_id = await svc.reply(body.message_id, body.body)
    mailbox_cache.invalidate(account.id)
    return {"sent_id": msg_id}


class ForwardRequest(BaseModel):
    message_id: str
    to: list[str]
    note: str = ""


@app.post("/mail/forward")
async def forward_mail(body: ForwardRequest, auth=Depends(get_current_user)):
    _, account = auth
    svc = await get_mail_service(account)
    msg_id = await svc.forward(body.message_id, body.to, body.note)
    mailbox_cache.invalidate(account.id)
    return {"sent_id": msg_id}


# ── assistant routes ──────────────────────────────────────────────────────────

class AssistantRequest(BaseModel):
    message: str
    ui_context: dict
    conversation_id: Optional[str] = None


@app.post("/assistant/chat")
async def assistant_chat(
    body: AssistantRequest,
    auth=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    user, account = auth
    svc = await get_mail_service(account)

    conv_id = body.conversation_id
    conv = None
    if conv_id:
        conv = db.query(AssistantConversation).filter(
            AssistantConversation.id == conv_id,
            AssistantConversation.user_id == user.id,
        ).first()

    if not conv:
        conv = AssistantConversation(user_id=user.id)
        db.add(conv)
        db.flush()

    history_rows = db.query(AssistantMessage).filter(
        AssistantMessage.conversation_id == conv.id
    ).order_by(AssistantMessage.created_at).all()

    messages = [{"role": r.role, "content": r.content} for r in history_rows]
    messages.append({"role": "user", "content": body.message})

    db.add(AssistantMessage(conversation_id=conv.id, role="user", content=body.message))

    try:
        result = await run_assistant(messages, body.ui_context, svc)
    except anthropic.APIStatusError as exc:
        db.rollback()
        detail = exc.body.get("error", {}).get("message") if isinstance(exc.body, dict) else str(exc)
        raise HTTPException(502, f"AI provider error: {detail}")
    except anthropic.APIConnectionError:
        db.rollback()
        raise HTTPException(502, "Could not reach the AI provider. Check network and API key.")

    db.add(AssistantMessage(conversation_id=conv.id, role="assistant", content=result["reply"]))
    db.commit()

    return {
        "conversation_id": conv.id,
        "reply": result["reply"],
        "actions": result["actions"],
        "emails": result.get("emails", []),
    }
