"""
IMAP/SMTP-backed MailService.

Lets ANY mailbox sign in with an email address and password (for Gmail an
App Password) without going through Google OAuth verification. When the host
is Gmail, its IMAP extensions are used: X-GM-RAW (Gmail search syntax) and
X-GM-THRID (conversation threads). Other providers fall back to standard
IMAP SEARCH and Message-ID/References threading.

Message IDs are "<MAILBOX>:<UID>", e.g. "INBOX:4521" or "SENT:88".

Performance: an instance keeps ONE persistent IMAP connection guarded by a
lock (IMAP sessions are not concurrent-safe). Calls run in worker threads and
are serialised per account, which is still far faster than paying a TLS
handshake plus login for every request. The connection is health-checked and
re-opened when the server drops it.
"""
import asyncio
import email
import html as html_lib
import imaplib
import re
import smtplib
import threading
import time
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta
from email.header import decode_header, make_header
from email.message import Message
from email.mime.text import MIMEText
from email.utils import formatdate, getaddresses, make_msgid, parsedate_to_datetime
from typing import Optional

from app.mail.service import MailService, EmailSummary, EmailDetail, MailFilters
from app.mail.gmail import _build_query

PROVIDER_HOSTS = {
    "gmail.com": ("imap.gmail.com", "smtp.gmail.com"),
    "googlemail.com": ("imap.gmail.com", "smtp.gmail.com"),
    "outlook.com": ("outlook.office365.com", "smtp.office365.com"),
    "hotmail.com": ("outlook.office365.com", "smtp.office365.com"),
    "live.com": ("outlook.office365.com", "smtp.office365.com"),
    "yahoo.com": ("imap.mail.yahoo.com", "smtp.mail.yahoo.com"),
    "icloud.com": ("imap.mail.me.com", "smtp.mail.me.com"),
}
PARTIAL_BYTES = 6000  # enough for headers + a snippet of the first text part
SEARCH_LIMIT = 30
FORWARD_MARKER = "---------- Forwarded message ----------"
HEALTHCHECK_AFTER_SECONDS = 45  # skip NOOP when the connection was used very recently


class MailAuthError(Exception):
    """Raised when the mailbox rejects the credentials."""


# ── pure helpers (unit-tested) ────────────────────────────────────────────────

def detect_hosts(email_addr: str) -> tuple[str, str]:
    domain = email_addr.rsplit("@", 1)[-1].lower().strip()
    return PROVIDER_HOSTS.get(domain, (f"imap.{domain}", f"smtp.{domain}"))


def decode_header_value(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _part_text(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def extract_bodies(msg: Message) -> tuple[str, str]:
    """Return (html, text) of the first non-attachment parts of each type."""
    html, text = "", ""
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.is_multipart():
            continue
        if "attachment" in str(part.get("Content-Disposition", "")).lower():
            continue
        ctype = part.get_content_type()
        if ctype == "text/html" and not html:
            html = _part_text(part)
        elif ctype == "text/plain" and not text:
            text = _part_text(part)
    return html, text


def html_to_text(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return html_lib.unescape(s)


def make_snippet(text: str, html: str, limit: int = 140) -> str:
    src = text or html_to_text(html)
    return re.sub(r"\s+", " ", src).strip()[:limit]


def parse_fetch_meta(meta: bytes) -> dict:
    """Pull UID, \\Seen and X-GM-THRID out of an IMAP FETCH response line."""
    out: dict = {}
    m = re.search(rb"UID (\d+)", meta)
    if m:
        out["uid"] = int(m.group(1))
    m = re.search(rb"FLAGS \(([^)]*)\)", meta)
    out["seen"] = b"\\Seen" in (m.group(1) if m else b"")
    m = re.search(rb"X-GM-THRID (\d+)", meta)
    if m:
        out["thrid"] = m.group(1).decode()
    return out


def split_id(message_id: str) -> tuple[str, int]:
    box, _, uid = message_id.partition(":")
    if not box or not uid.isdigit():
        raise ValueError(f"Bad message id: {message_id}")
    return box, int(uid)


def address_list(values: Optional[list[str]]) -> list[str]:
    if not values:
        return []
    decoded = [decode_header_value(v) for v in values]
    return [f"{name} <{addr}>" if name else addr for name, addr in getaddresses(decoded) if addr]


def _q(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _imap_date(value: str, shift_days: int = 0) -> str:
    d = datetime.strptime(value.replace("/", "-"), "%Y-%m-%d") + timedelta(days=shift_days)
    return d.strftime("%d-%b-%Y")


def build_imap_criteria(f: MailFilters, today: Optional[datetime] = None) -> list[str]:
    """Standard IMAP SEARCH criteria for non-Gmail servers."""
    now = today or datetime.now()
    crit: list[str] = []
    if f.unread:
        crit.append("UNSEEN")
    if f.sender:
        crit += ["FROM", _q(f.sender)]
    if f.keyword:
        crit += ["TEXT", _q(f.keyword)]
    if f.newer_than_days:
        crit += ["SINCE", (now - timedelta(days=int(f.newer_than_days))).strftime("%d-%b-%Y")]
    if f.from_date:
        crit += ["SINCE", _imap_date(f.from_date)]
    if f.to_date:
        crit += ["BEFORE", _imap_date(f.to_date, shift_days=1)]
    return crit or ["ALL"]


def parse_list_line(line: bytes | str) -> tuple[list[str], str]:
    """Parse one IMAP LIST response into (flags, folder name)."""
    s = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
    m = re.match(r'\((?P<flags>[^)]*)\)\s+"?(?P<delim>[^"\s]*)"?\s+(?P<name>.+)$', s.strip())
    if not m:
        return [], ""
    name = m.group("name").strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    return m.group("flags").split(), name


def _to_summary(d: EmailDetail) -> EmailSummary:
    return EmailSummary(
        id=d.id, thread_id=d.thread_id, subject=d.subject, sender=d.sender,
        snippet=d.snippet, date=d.date, is_unread=d.is_unread,
    )


def _logout(conn) -> None:
    try:
        conn.logout()
    except Exception:
        pass


def _friendly_auth_error(host: str) -> str:
    if "gmail" in host:
        return (
            "Gmail rejected the sign-in. Use an App Password (Google Account → Security → "
            "2-Step Verification → App passwords), not your normal password."
        )
    return "The mail server rejected the email address or password."


def verify_login(email_addr: str, password: str, imap_host: str) -> None:
    """Open and close an IMAP session; raises MailAuthError on bad credentials."""
    try:
        conn = imaplib.IMAP4_SSL(imap_host, 993, timeout=20)
    except OSError as exc:
        raise MailAuthError(f"Could not reach {imap_host}: {exc}") from exc
    try:
        conn.login(email_addr, password)
    except imaplib.IMAP4.error as exc:
        raise MailAuthError(_friendly_auth_error(imap_host)) from exc
    finally:
        _logout(conn)


# ── the service ──────────────────────────────────────────────────────────────

class ImapMailService(MailService):
    def __init__(self, email_addr: str, password: str, imap_host: Optional[str] = None, smtp_host: Optional[str] = None):
        self.email = email_addr
        self.password = password
        default_imap, default_smtp = detect_hosts(email_addr)
        self.imap_host = imap_host or default_imap
        self.smtp_host = smtp_host or default_smtp
        self.is_gmail = "gmail" in self.imap_host.lower()
        self._folders: Optional[dict[str, str]] = None
        self._lock = threading.RLock()
        self._conn: Optional[imaplib.IMAP4_SSL] = None
        self._last_used = 0.0
        self._selected: Optional[tuple[str, bool]] = None  # (folder, readonly) currently selected
        self._idle_conn: Optional[imaplib.IMAP4_SSL] = None  # dedicated IDLE session

    # ── connection management ────────────────────────────────────────────

    def _connect(self) -> imaplib.IMAP4_SSL:
        conn = imaplib.IMAP4_SSL(self.imap_host, 993, timeout=30)
        try:
            conn.login(self.email, self.password)
        except imaplib.IMAP4.error as exc:
            _logout(conn)
            raise MailAuthError(_friendly_auth_error(self.imap_host)) from exc
        return conn

    def _drop(self) -> None:
        if self._conn is not None:
            _logout(self._conn)
        self._conn = None
        self._selected = None

    def close(self) -> None:
        with self._lock:
            self._drop()
        self.stop_idle()

    @contextmanager
    def _session(self):
        """Yield the shared connection, opening or repairing it as needed."""
        with self._lock:
            if self._conn is not None and time.monotonic() - self._last_used > HEALTHCHECK_AFTER_SECONDS:
                try:
                    self._conn.noop()
                except Exception:
                    self._drop()
            if self._conn is None:
                self._conn = self._connect()
                self._selected = None
            try:
                yield self._conn
                self._last_used = time.monotonic()
            except (imaplib.IMAP4.abort, OSError, EOFError):
                self._drop()
                raise

    def _folder_map(self, conn) -> dict[str, str]:
        if self._folders:
            return self._folders
        if self.is_gmail:
            self._folders = {
                "INBOX": "INBOX", "SENT": "[Gmail]/Sent Mail", "ALL": "[Gmail]/All Mail",
                "SPAM": "[Gmail]/Spam", "TRASH": "[Gmail]/Trash",
            }
            return self._folders
        sent, spam, trash = "Sent", "Junk", "Trash"
        try:
            typ, data = conn.list()
            for line in data or []:
                flags, name = parse_list_line(line)
                if not name:
                    continue
                if r"\Sent" in flags:
                    sent = name
                elif r"\Junk" in flags:
                    spam = name
                elif r"\Trash" in flags:
                    trash = name
        except Exception:
            pass
        self._folders = {"INBOX": "INBOX", "SENT": sent, "ALL": "INBOX", "SPAM": spam, "TRASH": trash}
        return self._folders

    def _select(self, conn, folder: str, readonly: bool = True) -> None:
        if self._selected == (folder, readonly):
            return
        typ, _ = conn.select(f'"{folder}"', readonly=readonly)
        if typ != "OK":
            self._selected = None
            raise RuntimeError(f"Cannot open folder {folder}")
        self._selected = (folder, readonly)

    @staticmethod
    def _search(conn, criteria: list[str]) -> list[int]:
        needs_utf8 = any(ord(c) > 127 for c in " ".join(criteria))
        if needs_utf8:
            conn._encoding = "utf-8"  # imaplib default is ascii
            typ, data = conn.uid("SEARCH", "CHARSET", "UTF-8", *criteria)
        else:
            typ, data = conn.uid("SEARCH", None, *criteria)
        if typ != "OK" or not data or not data[0]:
            return []
        return [int(u) for u in data[0].split()]

    # ── fetch / parse ────────────────────────────────────────────────────

    def _fetch(self, conn, uids: list[int], box_key: str, full: bool) -> list[tuple[EmailDetail, Message]]:
        if not uids:
            return []
        items = "UID FLAGS"
        if self.is_gmail:
            items += " X-GM-THRID"
        items += " BODY.PEEK[]" if full else f" BODY.PEEK[]<0.{PARTIAL_BYTES}>"
        typ, data = conn.uid("FETCH", ",".join(str(u) for u in uids), f"({items})")
        out: list[tuple[EmailDetail, Message]] = []
        for item in data or []:
            if not isinstance(item, tuple) or len(item) < 2 or not item[1]:
                continue
            meta = parse_fetch_meta(item[0])
            if "uid" not in meta:
                continue
            msg = email.message_from_bytes(item[1])
            out.append((self._to_detail(msg, meta, box_key), msg))
        return out

    def _to_detail(self, msg: Message, meta: dict, box_key: str) -> EmailDetail:
        html, text = extract_bodies(msg)
        uid = meta["uid"]
        message_id_header = decode_header_value(msg.get("Message-ID", "")).strip()
        thread_id = meta.get("thrid") or message_id_header.strip("<>") or f"{box_key}:{uid}"
        return EmailDetail(
            id=f"{box_key}:{uid}",
            thread_id=thread_id,
            subject=decode_header_value(msg.get("Subject")) or "(no subject)",
            sender=decode_header_value(msg.get("From")),
            snippet=make_snippet(text, html),
            date=msg.get("Date", ""),
            is_unread=not meta.get("seen", False),
            body_html=html,
            body_text=text,
            to=address_list(msg.get_all("To")),
            cc=address_list(msg.get_all("Cc")),
        )

    # ── sync operations (run in threads, serialised by the session lock) ─

    def _list_sync(self, box_key: str, max_results: int, criteria: Optional[list[str]] = None) -> list[EmailSummary]:
        with self._session() as conn:
            self._select(conn, self._folder_map(conn)[box_key])
            uids = sorted(self._search(conn, criteria or ["ALL"]))[-max_results:]
            details = [d for d, _ in self._fetch(conn, uids, box_key, full=False)]
        details.sort(key=lambda e: split_id(e.id)[1], reverse=True)
        return [_to_summary(d) for d in details]

    def _get_raw_sync(self, message_id: str) -> tuple[EmailDetail, Message]:
        box_key, uid = split_id(message_id)
        with self._session() as conn:
            self._select(conn, self._folder_map(conn)[box_key])
            res = self._fetch(conn, [uid], box_key, full=True)
        if not res:
            raise LookupError(f"Message {message_id} not found")
        return res[0]

    def _thread_sync(self, thread_id: str) -> list[EmailDetail]:
        found: list[EmailDetail] = []
        with self._session() as conn:
            folders = self._folder_map(conn)
            if self.is_gmail and thread_id.isdigit():
                self._select(conn, folders["ALL"])
                uids = self._search(conn, ["X-GM-THRID", thread_id])
                found = [d for d, _ in self._fetch(conn, uids, "ALL", full=True)]
            else:
                ref = _q(f"<{thread_id}>")
                for key in ("INBOX", "SENT"):
                    try:
                        self._select(conn, folders[key])
                    except RuntimeError:
                        continue
                    uids = self._search(conn, ["OR", "HEADER", "Message-ID", ref, "HEADER", "References", ref])
                    found += [d for d, _ in self._fetch(conn, uids, key, full=True)]

        def sort_key(d: EmailDetail):
            try:
                return parsedate_to_datetime(d.date).timestamp()
            except Exception:
                return float(split_id(d.id)[1])

        found.sort(key=sort_key)
        return found

    def _search_sync(self, filters: MailFilters) -> list[EmailSummary]:
        box_key = {"sent": "SENT", "all": "ALL", "spam": "SPAM", "trash": "TRASH"}.get(filters.scope or "inbox", "INBOX")
        if self.is_gmail:
            q = _build_query(replace(filters, scope=None))  # folder already scopes the search
            criteria = ["X-GM-RAW", _q(q)] if q else ["ALL"]
        else:
            criteria = build_imap_criteria(filters)
        return self._list_sync(box_key, SEARCH_LIMIT, criteria)

    def _move_sync(self, message_id: str, dest_key: str) -> None:
        box_key, uid = split_id(message_id)
        with self._session() as conn:
            folders = self._folder_map(conn)
            if box_key == dest_key:
                return
            self._select(conn, folders[box_key], readonly=False)
            dest = f'"{folders[dest_key]}"'
            if "MOVE" in conn.capabilities:
                conn.uid("MOVE", str(uid), dest)
            else:
                conn.uid("COPY", str(uid), dest)
                conn.uid("STORE", str(uid), "+FLAGS", r"(\Deleted)")
                conn.expunge()

    def _delete_forever_sync(self, message_id: str) -> None:
        box_key, uid = split_id(message_id)
        with self._session() as conn:
            self._select(conn, self._folder_map(conn)[box_key], readonly=False)
            conn.uid("STORE", str(uid), "+FLAGS", r"(\Deleted)")
            conn.expunge()

    def _set_read_sync(self, message_id: str, read: bool) -> None:
        box_key, uid = split_id(message_id)
        with self._session() as conn:
            self._select(conn, self._folder_map(conn)[box_key], readonly=False)
            conn.uid("STORE", str(uid), "+FLAGS" if read else "-FLAGS", r"(\Seen)")

    def _send_sync(self, msg: Message) -> str:
        msg["From"] = self.email
        if not msg.get("Date"):
            msg["Date"] = formatdate(localtime=True)
        if not msg.get("Message-ID"):
            msg["Message-ID"] = make_msgid(domain=self.email.rsplit("@", 1)[-1])
        try:
            with smtplib.SMTP_SSL(self.smtp_host, 465, timeout=30) as smtp:
                smtp.login(self.email, self.password)
                smtp.send_message(msg)
        except smtplib.SMTPAuthenticationError as exc:
            raise MailAuthError(_friendly_auth_error(self.smtp_host)) from exc
        except (OSError, smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected):
            with smtplib.SMTP(self.smtp_host, 587, timeout=30) as smtp:
                smtp.ehlo()
                smtp.starttls()
                smtp.ehlo()
                smtp.login(self.email, self.password)
                smtp.send_message(msg)
        if not self.is_gmail:
            # Gmail files sent mail itself; other servers need an explicit copy.
            try:
                with self._session() as conn:
                    folder = self._folder_map(conn)["SENT"]
                    conn.append(f'"{folder}"', "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
            except Exception:
                pass
        return msg["Message-ID"]

    def _status_sync(self) -> int:
        with self._session() as conn:
            typ, data = conn.status('"INBOX"', "(UIDNEXT MESSAGES UNSEEN)")
        raw = data[0] if data else b""
        text = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        nums = {k: int(v) for k, v in re.findall(r"(UIDNEXT|MESSAGES|UNSEEN) (\d+)", text)}
        return int(f"{nums.get('UIDNEXT', 0)}{nums.get('MESSAGES', 0):06d}{nums.get('UNSEEN', 0):05d}")

    # ── IMAP IDLE (true push) ────────────────────────────────────────────

    def idle_once(self, timeout: int = 240) -> bool:
        """
        Block until the server reports mailbox activity, or `timeout` elapses.
        Returns True if something changed. Uses a dedicated connection because
        IDLE occupies a session for its whole duration.

        Called from a worker thread by the realtime watcher.
        """
        conn = self._idle_conn
        if conn is None:
            conn = self._connect()
            conn.select("INBOX", readonly=True)
            self._idle_conn = conn

        tag = conn._new_tag()
        conn.send(b"%s IDLE\r\n" % tag)
        if not conn.readline().startswith(b"+"):
            raise RuntimeError("server refused IDLE")

        changed = False
        sock = conn.socket()
        previous_timeout = sock.gettimeout()
        sock.settimeout(timeout)
        try:
            while True:
                line = conn.readline()
                if not line:
                    raise ConnectionError("IDLE connection closed")
                # Untagged EXISTS/EXPUNGE/FETCH mean the mailbox moved.
                if line.startswith(b"*") and any(
                    k in line for k in (b"EXISTS", b"EXPUNGE", b"FETCH")
                ):
                    changed = True
                    break
        except (TimeoutError, OSError):
            pass  # idle period elapsed with no activity
        finally:
            sock.settimeout(previous_timeout)
            try:
                conn.send(b"DONE\r\n")
                # Drain until the IDLE command completes.
                for _ in range(20):
                    if conn.readline().startswith(tag):
                        break
            except Exception:
                self.stop_idle()
        return changed

    def stop_idle(self) -> None:
        if self._idle_conn is not None:
            _logout(self._idle_conn)
            self._idle_conn = None

    # ── MailService interface ────────────────────────────────────────────

    async def list_mailbox(self, box: str, max_results: int = 20) -> list[EmailSummary]:
        key = {"inbox": "INBOX", "sent": "SENT", "spam": "SPAM", "trash": "TRASH"}.get(box)
        if key is None:
            raise ValueError(f"Unknown mailbox {box}")
        return await asyncio.to_thread(self._list_sync, key, max_results)

    async def get_message(self, message_id: str) -> EmailDetail:
        detail, _ = await asyncio.to_thread(self._get_raw_sync, message_id)
        return detail

    async def get_thread(self, thread_id: str) -> list[EmailDetail]:
        return await asyncio.to_thread(self._thread_sync, thread_id)

    async def search_messages(self, filters: MailFilters) -> list[EmailSummary]:
        return await asyncio.to_thread(self._search_sync, filters)

    async def send_message(self, to: list[str], subject: str, body: str) -> str:
        msg = MIMEText(body, "plain", "utf-8")
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject
        return await asyncio.to_thread(self._send_sync, msg)

    async def reply(self, message_id: str, body: str) -> str:
        original, raw = await asyncio.to_thread(self._get_raw_sync, message_id)
        reply = MIMEText(body, "plain", "utf-8")
        reply["To"] = decode_header_value(raw.get("Reply-To") or raw.get("From"))
        reply["Subject"] = original.subject if original.subject.lower().startswith("re:") else f"Re: {original.subject}"
        mid = raw.get("Message-ID")
        if mid:
            reply["In-Reply-To"] = mid
            reply["References"] = f"{raw.get('References', '')} {mid}".strip()
        return await asyncio.to_thread(self._send_sync, reply)

    async def forward(self, message_id: str, to: list[str], note: str) -> str:
        original = await self.get_message(message_id)
        if FORWARD_MARKER in note:
            text = note
        else:
            body = original.body_text or html_to_text(original.body_html)
            text = f"{note}\n\n{FORWARD_MARKER}\n{body}"
        msg = MIMEText(text, "plain", "utf-8")
        msg["To"] = ", ".join(to)
        msg["Subject"] = f"Fwd: {original.subject}"
        return await asyncio.to_thread(self._send_sync, msg)

    async def set_read(self, message_id: str, read: bool = True) -> None:
        await asyncio.to_thread(self._set_read_sync, message_id, read)

    async def trash_message(self, message_id: str) -> None:
        await asyncio.to_thread(self._move_sync, message_id, "TRASH")

    async def mark_spam(self, message_id: str) -> None:
        await asyncio.to_thread(self._move_sync, message_id, "SPAM")

    async def restore_message(self, message_id: str) -> None:
        await asyncio.to_thread(self._move_sync, message_id, "INBOX")

    async def delete_forever(self, message_id: str) -> None:
        await asyncio.to_thread(self._delete_forever_sync, message_id)

    async def check_changes(self, cursor: Optional[int]) -> tuple[bool, int]:
        new = await asyncio.to_thread(self._status_sync)
        return (cursor is not None and new != cursor), new

    async def get_history_id(self) -> int:
        return (await self.check_changes(None))[1]
