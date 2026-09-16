from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

MAILBOXES = ("inbox", "sent", "spam", "trash")


class MailPermissionError(Exception):
    """The provider refused because the granted scopes do not cover the action."""


@dataclass
class EmailSummary:
    id: str
    thread_id: str
    subject: str
    sender: str
    snippet: str
    date: str
    is_unread: bool


@dataclass
class EmailDetail(EmailSummary):
    body_html: str
    body_text: str
    to: list[str]
    cc: list[str]


@dataclass
class MailFilters:
    sender: Optional[str] = None
    keyword: Optional[str] = None
    unread: Optional[bool] = None
    from_date: Optional[str] = None      # YYYY-MM-DD or YYYY/MM/DD
    to_date: Optional[str] = None        # YYYY-MM-DD or YYYY/MM/DD
    newer_than_days: Optional[int] = None  # relative range, e.g. 7 for "this week"
    scope: Optional[str] = None          # "inbox" | "sent" | "spam" | "trash" | "all" (None = all mail)


class MailService(ABC):
    """
    Provider-neutral mailbox interface. The API layer and the AI assistant only
    ever talk to this; GmailMailService (OAuth + Gmail API) and ImapMailService
    (email + app password over IMAP/SMTP) are the two implementations.
    """

    # ── reading ──────────────────────────────────────────────────────────

    @abstractmethod
    async def list_mailbox(self, box: str, max_results: int = 20) -> list[EmailSummary]:
        """box is one of MAILBOXES."""

    async def list_inbox(self, max_results: int = 20) -> list[EmailSummary]:
        return await self.list_mailbox("inbox", max_results)

    async def list_sent(self, max_results: int = 20) -> list[EmailSummary]:
        return await self.list_mailbox("sent", max_results)

    @abstractmethod
    async def get_message(self, message_id: str) -> EmailDetail: ...

    @abstractmethod
    async def get_thread(self, thread_id: str) -> list[EmailDetail]: ...

    @abstractmethod
    async def search_messages(self, filters: MailFilters) -> list[EmailSummary]: ...

    # ── writing ──────────────────────────────────────────────────────────

    @abstractmethod
    async def send_message(self, to: list[str], subject: str, body: str) -> str: ...

    @abstractmethod
    async def reply(self, message_id: str, body: str) -> str: ...

    @abstractmethod
    async def forward(self, message_id: str, to: list[str], note: str) -> str: ...

    @abstractmethod
    async def set_read(self, message_id: str, read: bool = True) -> None:
        """Mark a message read (True) or unread (False)."""

    @abstractmethod
    async def trash_message(self, message_id: str) -> None:
        """Move a message to the bin (recoverable)."""

    @abstractmethod
    async def mark_spam(self, message_id: str) -> None:
        """Move a message to the spam folder."""

    @abstractmethod
    async def restore_message(self, message_id: str) -> None:
        """Move a message out of spam/bin back to the inbox."""

    @abstractmethod
    async def delete_forever(self, message_id: str) -> None:
        """Permanently delete a message. Not recoverable."""

    # ── realtime ─────────────────────────────────────────────────────────

    @abstractmethod
    async def check_changes(self, cursor: Optional[int]) -> tuple[bool, int]:
        """Return (changed_since_cursor, new_cursor). Used by the realtime poll."""

    @abstractmethod
    async def get_history_id(self) -> int: ...
