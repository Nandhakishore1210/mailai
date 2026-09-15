import asyncio
import base64
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials
from app.mail.service import MailService, EmailSummary, EmailDetail, MailFilters

METADATA_HEADERS = ["Subject", "From", "Date"]
BOX_LABELS = {"inbox": ["INBOX"], "sent": ["SENT"], "spam": ["SPAM"], "trash": ["TRASH"]}


def _gmail_date(value: str) -> str:
    """Gmail wants YYYY/MM/DD; accept YYYY-MM-DD from the UI/model too."""
    return value.replace("-", "/")


def _inclusive_end(value: str) -> str:
    """Gmail's before: is exclusive; shift the end date by one day so a
    'to' date chosen in a date picker includes that whole day."""
    try:
        d = datetime.strptime(value.replace("/", "-"), "%Y-%m-%d") + timedelta(days=1)
        return d.strftime("%Y/%m/%d")
    except ValueError:
        return _gmail_date(value)


def _build_query(filters: MailFilters) -> str:
    parts = []
    if filters.scope in ("inbox", "sent", "spam", "trash"):
        parts.append(f"in:{filters.scope}")
    if filters.sender:
        parts.append(f"from:{filters.sender}")
    if filters.keyword:
        parts.append(filters.keyword)
    if filters.unread is True:
        parts.append("is:unread")
    if filters.newer_than_days:
        parts.append(f"newer_than:{int(filters.newer_than_days)}d")
    if filters.from_date:
        parts.append(f"after:{_gmail_date(filters.from_date)}")
    if filters.to_date:
        parts.append(f"before:{_inclusive_end(filters.to_date)}")
    return " ".join(parts)


def _parse_headers(headers: list[dict]) -> dict:
    return {h["name"].lower(): h["value"] for h in headers}


def _decode_body(payload: dict) -> tuple[str, str]:
    html, text = "", ""

    def walk(part):
        nonlocal html, text
        mime = part.get("mimeType", "")
        body_data = part.get("body", {}).get("data", "")
        if mime == "text/html" and body_data:
            html = base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
        elif mime == "text/plain" and body_data:
            text = base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="replace")
        for sub in part.get("parts", []):
            walk(sub)

    walk(payload)
    return html, text


class GmailMailService(MailService):
    """
    Gmail-backed MailService.

    The Google client is synchronous, so every call is pushed to a worker
    thread with asyncio.to_thread; otherwise one slow Gmail request would
    block the whole FastAPI event loop. List views fetch message metadata
    with a single batched HTTP request instead of one request per message.
    """

    def __init__(self, credentials: Credentials):
        self._credentials = credentials
        self._service = build("gmail", "v1", credentials=credentials, cache_discovery=False)

    # ── parsing ──────────────────────────────────────────────────────────

    def _msg_to_summary(self, msg: dict) -> EmailSummary:
        h = _parse_headers(msg.get("payload", {}).get("headers", []))
        return EmailSummary(
            id=msg["id"],
            thread_id=msg.get("threadId", ""),
            subject=h.get("subject", "(no subject)"),
            sender=h.get("from", ""),
            snippet=msg.get("snippet", ""),
            date=h.get("date", ""),
            is_unread="UNREAD" in msg.get("labelIds", []),
        )

    # ── sync helpers (run in threads) ────────────────────────────────────

    def _fetch_summaries_sync(self, ids: list[str]) -> list[EmailSummary]:
        if not ids:
            return []
        found: dict[str, EmailSummary] = {}

        def on_result(request_id, response, exception):
            if exception is None and response:
                found[request_id] = self._msg_to_summary(response)

        # Gmail allows up to 100 calls per batch; keep chunks small for latency.
        for start in range(0, len(ids), 50):
            batch = self._service.new_batch_http_request(callback=on_result)
            for mid in ids[start:start + 50]:
                batch.add(
                    self._service.users().messages().get(
                        userId="me", id=mid, format="metadata", metadataHeaders=METADATA_HEADERS
                    ),
                    request_id=mid,
                )
            batch.execute()
        return [found[i] for i in ids if i in found]

    def _list_sync(self, label_ids: list[str] | None, query: str | None, max_results: int) -> list[EmailSummary]:
        kwargs = {"userId": "me", "maxResults": max_results}
        if label_ids:
            kwargs["labelIds"] = label_ids
        if query:
            kwargs["q"] = query
        res = self._service.users().messages().list(**kwargs).execute()
        ids = [m["id"] for m in res.get("messages", [])]
        return self._fetch_summaries_sync(ids)

    def _msg_to_detail(self, msg: dict) -> EmailDetail:
        h = _parse_headers(msg.get("payload", {}).get("headers", []))
        html, text = _decode_body(msg.get("payload", {}))
        to_raw = h.get("to", "")
        cc_raw = h.get("cc", "")
        return EmailDetail(
            id=msg["id"],
            thread_id=msg.get("threadId", ""),
            subject=h.get("subject", "(no subject)"),
            sender=h.get("from", ""),
            snippet=msg.get("snippet", ""),
            date=h.get("date", ""),
            is_unread="UNREAD" in msg.get("labelIds", []),
            body_html=html,
            body_text=text,
            to=[a.strip() for a in to_raw.split(",") if a.strip()],
            cc=[a.strip() for a in cc_raw.split(",") if a.strip()],
        )

    def _get_sync(self, message_id: str) -> EmailDetail:
        msg = self._service.users().messages().get(userId="me", id=message_id, format="full").execute()
        return self._msg_to_detail(msg)

    def _thread_sync(self, thread_id: str) -> list[EmailDetail]:
        thread = self._service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        return [self._msg_to_detail(m) for m in thread.get("messages", [])]

    def _send_raw_sync(self, mime, thread_id: str | None = None) -> str:
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        body = {"raw": raw}
        if thread_id:
            body["threadId"] = thread_id
        result = self._service.users().messages().send(userId="me", body=body).execute()
        return result["id"]

    # ── MailService interface ────────────────────────────────────────────

    async def list_mailbox(self, box: str, max_results: int = 20) -> list[EmailSummary]:
        labels = BOX_LABELS.get(box)
        if labels is None:
            raise ValueError(f"Unknown mailbox {box}")
        return await asyncio.to_thread(self._list_sync, labels, None, max_results)

    async def get_message(self, message_id: str) -> EmailDetail:
        return await asyncio.to_thread(self._get_sync, message_id)

    async def search_messages(self, filters: MailFilters) -> list[EmailSummary]:
        query = _build_query(filters)
        return await asyncio.to_thread(self._list_sync, None, query or None, 30)

    async def send_message(self, to: list[str], subject: str, body: str) -> str:
        msg = MIMEMultipart("alternative")
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain"))
        return await asyncio.to_thread(self._send_raw_sync, msg)

    async def reply(self, message_id: str, body: str) -> str:
        original = await self.get_message(message_id)
        msg = MIMEText(body, "plain")
        msg["To"] = original.sender
        subject = original.subject
        msg["Subject"] = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        msg["In-Reply-To"] = message_id
        msg["References"] = message_id
        return await asyncio.to_thread(self._send_raw_sync, msg, original.thread_id)

    async def forward(self, message_id: str, to: list[str], note: str) -> str:
        original = await self.get_message(message_id)
        text = note if "---------- Forwarded message ----------" in note else (
            f"{note}\n\n---------- Forwarded message ----------\n{original.body_text}"
        )
        msg = MIMEText(text, "plain")
        msg["To"] = ", ".join(to)
        msg["Subject"] = f"Fwd: {original.subject}"
        return await asyncio.to_thread(self._send_raw_sync, msg)

    async def get_thread(self, thread_id: str) -> list[EmailDetail]:
        return await asyncio.to_thread(self._thread_sync, thread_id)

    def _modify_sync(self, message_id: str, add: list[str] | None = None, remove: list[str] | None = None) -> None:
        body = {}
        if add:
            body["addLabelIds"] = add
        if remove:
            body["removeLabelIds"] = remove
        self._service.users().messages().modify(userId="me", id=message_id, body=body).execute()

    async def trash_message(self, message_id: str) -> None:
        await asyncio.to_thread(
            lambda: self._service.users().messages().trash(userId="me", id=message_id).execute()
        )

    async def mark_spam(self, message_id: str) -> None:
        await asyncio.to_thread(self._modify_sync, message_id, ["SPAM"], ["INBOX"])

    async def restore_message(self, message_id: str) -> None:
        def _restore():
            try:
                self._service.users().messages().untrash(userId="me", id=message_id).execute()
            except Exception:
                pass  # not in trash; fine
            self._modify_sync(message_id, ["INBOX"], ["SPAM", "TRASH"])
        await asyncio.to_thread(_restore)

    async def delete_forever(self, message_id: str) -> None:
        await asyncio.to_thread(
            lambda: self._service.users().messages().delete(userId="me", id=message_id).execute()
        )

    def _set_read_sync(self, message_id: str, read: bool) -> None:
        body = {"removeLabelIds": ["UNREAD"]} if read else {"addLabelIds": ["UNREAD"]}
        self._service.users().messages().modify(userId="me", id=message_id, body=body).execute()

    async def set_read(self, message_id: str, read: bool = True) -> None:
        await asyncio.to_thread(self._set_read_sync, message_id, read)

    async def check_changes(self, cursor):
        if cursor is None:
            return False, await self.get_history_id()
        from app.realtime.poll import check_history
        return await check_history(self._credentials, cursor)

    async def get_history_id(self) -> int:
        def _profile():
            return int(self._service.users().getProfile(userId="me").execute().get("historyId", 0))
        return await asyncio.to_thread(_profile)
