"""
Short-lived mailbox listing cache.

Listing a mailbox is expensive against the Gmail API: one `messages.list`
(5 quota units) plus a batched `messages.get` per message (5 units each), so a
20-message inbox costs ~105 units. Gmail allows 15,000 units per user per
minute, and without caching the app blows through that quickly, because:

* every browser tab refetches inbox and sent on load,
* the realtime watcher fetches the inbox again for each change event,
* and every change event makes each tab refetch too.

Hitting the limit returns HTTP 403 and the mailbox renders empty, which is how
this was found: the end-to-end suite exhausted the quota and lists came back
blank.

A few seconds of caching collapses all of that into one fetch. Entries are
dropped as soon as the watcher sees a real change, so the cache never serves
stale mail after something actually happened.
"""
import threading
import time
from typing import Optional

from app.mail.service import EmailSummary

DEFAULT_TTL = 10.0  # seconds; long enough to absorb a burst, short enough to stay fresh


class MailboxCache:
    def __init__(self, ttl: float = DEFAULT_TTL):
        self._ttl = ttl
        self._lock = threading.Lock()
        # (account_id, box, max_results) -> (stored_at, emails)
        self._entries: dict[tuple[str, str, int], tuple[float, list[EmailSummary]]] = {}

    def get(self, account_id: str, box: str, max_results: int) -> Optional[list[EmailSummary]]:
        key = (account_id, box, max_results)
        with self._lock:
            hit = self._entries.get(key)
            if hit is None:
                return None
            stored_at, emails = hit
            if time.monotonic() - stored_at > self._ttl:
                self._entries.pop(key, None)
                return None
            return emails

    def put(self, account_id: str, box: str, max_results: int, emails: list[EmailSummary]) -> None:
        with self._lock:
            self._entries[(account_id, box, max_results)] = (time.monotonic(), emails)

    def invalidate(self, account_id: str, box: Optional[str] = None) -> None:
        """Drop cached listings for an account, or just one of its mailboxes."""
        with self._lock:
            for key in [
                k for k in self._entries
                if k[0] == account_id and (box is None or k[1] == box)
            ]:
                self._entries.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


mailbox_cache = MailboxCache()
