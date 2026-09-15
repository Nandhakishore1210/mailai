"""
Realtime change detection: one watcher per mail account, many browser subscribers.

The browser never polls. It holds a single Server-Sent Events connection and is
pushed to. Behind that, how the *provider* reaches us depends on the account:

* IMAP accounts use real IMAP IDLE on a dedicated connection. The mail server
  tells us the instant a message arrives.
* Gmail API accounts use Pub/Sub push when a public webhook URL is configured
  (see gmail_push.py). The webhook calls wake() and the watcher checks at once.
  Without a public URL (local dev) the watcher falls back to server-side
  history polling on a short interval, which costs the browser nothing.

Two properties beyond raw latency:

* **Events carry the mail.** A change event includes the current inbox
  summaries, so the browser renders the new message without a follow-up
  request. One fetch here replaces one fetch per connected client.
* **Events are replayable.** Each carries a monotonic id and recent ones are
  buffered. A browser that reconnects after a sleep or a dropped network sends
  `Last-Event-ID` and gets exactly what it missed. If it has fallen too far
  behind, it is told to resync instead.
"""
import asyncio
import contextlib
import logging
import time
from collections import deque
from dataclasses import asdict
from typing import Optional

from app.db.models import MailAccount
from app.db.session import SessionLocal
from app.mail.imap import ImapMailService
from app.mail.cache import mailbox_cache
from app.mail.registry import get_mail_service
from app.realtime.gmail_push import push_enabled

log = logging.getLogger(__name__)

# Polling cadence for Gmail accounts.
#
# Without Pub/Sub this polling IS the liveness mechanism, so it starts tight and
# eases off while the mailbox is quiet. Measured: history.list reflects a change
# ~1.5 s after it happens, so a 3 s tick averages ~3 s end to end.
#
# With Pub/Sub configured the webhook provides liveness (measured ~4 s from
# change to delivery, dominated by Gmail's own publish delay, not by us), so
# polling drops to a slow safety net that only covers a missed notification.
# That removes ~1200 needless API calls per active hour per account.
GMAIL_POLL_FAST = 3
GMAIL_POLL_SLOW = 20
GMAIL_POLL_WITH_PUSH = 60          # safety net only; the webhook does the work
QUIET_CHECKS_BEFORE_BACKOFF = 40   # ~2 minutes of silence
IDLE_SECONDS = 240          # re-issue IDLE well inside the RFC's 29-minute limit
IDLE_ERROR_BACKOFF = 15
STOP_GRACE_SECONDS = 30     # keep watching briefly after the last tab closes
SNAPSHOT_SIZE = 20          # inbox summaries carried on each change event
EVENT_BUFFER = 50           # how many past events stay replayable


class AccountWatcher:
    """Watches one mailbox and fans changes out to subscribed SSE streams."""

    def __init__(self, account_id: str):
        self.account_id = account_id
        self._subscribers: set[asyncio.Queue] = set()
        self._task: Optional[asyncio.Task] = None
        self._stop_timer: Optional[asyncio.TimerHandle] = None
        self._service = None
        self._cursor: Optional[int] = None
        self._wake = asyncio.Event()      # set to force an immediate check
        self._push_pending = False        # a Pub/Sub push is what woke us
        self.last_push_at: Optional[float] = None   # for the health endpoint
        self.last_event_at: Optional[float] = None
        self._quiet_checks = 0
        self._seq = 0                     # monotonic event id
        self._recent: deque[dict] = deque(maxlen=EVENT_BUFFER)

    # ── subscriptions ────────────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._subscribers.add(q)
        if self._stop_timer:
            self._stop_timer.cancel()
            self._stop_timer = None
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        return q

    def wake(self, pushed: bool = False) -> None:
        """
        Force an immediate change check. `pushed` marks a genuine Pub/Sub
        delivery, as opposed to a tab regaining focus, so the event we emit
        reports honestly which mechanism found the change.
        """
        self._quiet_checks = 0
        if pushed:
            self._push_pending = True
            self.last_push_at = time.time()
        self._wake.set()

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)
        if not self._subscribers and self._stop_timer is None:
            loop = asyncio.get_running_loop()
            self._stop_timer = loop.call_later(STOP_GRACE_SECONDS, self._stop_if_idle)

    def _stop_if_idle(self) -> None:
        self._stop_timer = None
        if not self._subscribers:
            self.stop()

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        svc = self._service
        if isinstance(svc, ImapMailService):
            svc.stop_idle()
        self._service = None

    # ── fan-out and replay ───────────────────────────────────────────────

    def notify(self, source: str, inbox: Optional[list[dict]] = None) -> dict:
        """Publish a change to every subscriber and keep it replayable."""
        self._seq += 1
        payload = {"id": self._seq, "changed": True, "source": source}
        self.last_event_at = time.time()
        if inbox is not None:
            payload["inbox"] = inbox
        self._recent.append(payload)

        for q in list(self._subscribers):
            if q.full():
                continue  # a stalled client already has a pending change
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(payload)
        return payload

    def replay_since(self, last_id: Optional[int]) -> Optional[list[dict]]:
        """
        Events a reconnecting client missed.

        Returns [] when it is already current, a list when it can be caught up,
        and None when it has fallen past the buffer and needs a full resync.
        """
        if last_id is None:
            return []
        if last_id >= self._seq:
            return []                      # nothing missed (or a stale id after restart)
        if not self._recent or last_id < self._recent[0]["id"] - 1:
            return None                    # too far behind to replay
        return [e for e in self._recent if e["id"] > last_id]

    # ── the loop ─────────────────────────────────────────────────────────

    async def _load(self):
        db = SessionLocal()
        try:
            account = db.query(MailAccount).filter(MailAccount.id == self.account_id).first()
            if account is None:
                return None
            self._cursor = account.history_id
            return await get_mail_service(account)
        finally:
            db.close()

    def _persist_cursor(self, cursor: int) -> None:
        db = SessionLocal()
        try:
            db.query(MailAccount).filter(MailAccount.id == self.account_id).update({"history_id": cursor})
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()

    async def _inbox_snapshot(self) -> Optional[list[dict]]:
        """
        Current inbox summaries to ride along with a change event.

        The mailbox just changed, so stale listings are dropped first. The
        result then warms the cache, meaning this single fetch serves both the
        push payload and any tab that asks for the inbox afterwards.
        """
        mailbox_cache.invalidate(self.account_id)
        try:
            emails = await self._service.list_mailbox("inbox", SNAPSHOT_SIZE)
            mailbox_cache.put(self.account_id, "inbox", SNAPSHOT_SIZE, emails)
            return [asdict(e) for e in emails]
        except Exception:
            log.debug("inbox snapshot failed for %s", self.account_id, exc_info=True)
            return None   # client falls back to fetching for itself

    async def _announce(self, source: str) -> None:
        self.notify(source, inbox=await self._inbox_snapshot())

    async def _announce_gmail(self) -> None:
        """Report push vs poll based on what actually woke this check."""
        source = "gmail-push" if self._push_pending else "gmail-history"
        self._push_pending = False
        await self._announce(source)

    async def _run(self) -> None:
        try:
            self._service = await self._load()
            if self._service is None:
                return
            if isinstance(self._service, ImapMailService):
                await self._run_imap_idle(self._service)
            else:
                await self._run_gmail_poll(self._service)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("watcher %s crashed", self.account_id)

    async def _run_imap_idle(self, svc: ImapMailService) -> None:
        """Block on IMAP IDLE; the server pushes the moment mail arrives."""
        while True:
            try:
                changed = await asyncio.to_thread(svc.idle_once, IDLE_SECONDS)
            except Exception:
                log.warning("IDLE failed for %s, retrying", self.account_id, exc_info=True)
                await asyncio.sleep(IDLE_ERROR_BACKOFF)
                continue
            if changed:
                await self._announce("imap-idle")

    async def _run_gmail_poll(self, svc) -> None:
        """
        History polling. A Pub/Sub push calls wake(), so this loop reacts at once
        when push is configured and falls back to a short interval when it is not.
        """
        if self._cursor is None:
            with contextlib.suppress(Exception):
                self._cursor = await svc.get_history_id()
                self._persist_cursor(self._cursor)

        # Check first, then sleep. The opening check catches up on anything that
        # arrived while no tab was connected, so the app is fresh on load.
        while True:
            self._wake.clear()

            try:
                changed, cursor = await svc.check_changes(self._cursor)
            except Exception:
                log.debug("history check failed for %s", self.account_id, exc_info=True)
                changed, cursor = False, self._cursor

            if cursor != self._cursor:
                self._cursor = cursor
                self._persist_cursor(cursor)

            if changed:
                self._quiet_checks = 0
                await self._announce_gmail()
            else:
                self._quiet_checks += 1

            if push_enabled():
                interval = GMAIL_POLL_WITH_PUSH
            elif self._quiet_checks < QUIET_CHECKS_BEFORE_BACKOFF:
                interval = GMAIL_POLL_FAST
            else:
                interval = GMAIL_POLL_SLOW
            # Sleep, but cut it short if someone calls wake().
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=interval)


class WatcherRegistry:
    """Account id -> AccountWatcher, created on demand."""

    def __init__(self):
        self._watchers: dict[str, AccountWatcher] = {}

    def get(self, account_id: str) -> AccountWatcher:
        w = self._watchers.get(account_id)
        if w is None:
            w = AccountWatcher(account_id)
            self._watchers[account_id] = w
        return w

    def find(self, account_id: str) -> Optional[AccountWatcher]:
        return self._watchers.get(account_id)

    def notify(self, account_id: str, source: str) -> bool:
        """Push to an account's subscribers. Returns False if nobody is listening."""
        w = self._watchers.get(account_id)
        if w is None:
            return False
        w.notify(source)
        return True

    def wake(self, account_id: str, pushed: bool = False) -> bool:
        """Force an immediate check. Returns False if the account is not watched."""
        w = self._watchers.get(account_id)
        if w is None:
            return False
        w.wake(pushed=pushed)
        return True

    def snapshot(self) -> list[dict]:
        """Health view of every live watcher, for the status endpoint."""
        now = time.time()
        out = []
        for w in self._watchers.values():
            out.append({
                "account_id": w.account_id,
                "subscribers": len(w._subscribers),
                "running": bool(w._task and not w._task.done()),
                "events_emitted": w._seq,
                "seconds_since_last_push": round(now - w.last_push_at, 1) if w.last_push_at else None,
                "seconds_since_last_event": round(now - w.last_event_at, 1) if w.last_event_at else None,
            })
        return out

    def shutdown(self) -> None:
        for w in self._watchers.values():
            w.stop()
        self._watchers.clear()


watchers = WatcherRegistry()
