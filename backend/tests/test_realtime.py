"""
Unit tests for the realtime push layer: Pub/Sub envelope parsing, subscriber
fan-out, and the replay buffer that lets a reconnecting browser catch up.
No network, no mailbox.
"""
import asyncio
import base64
import json

import pytest

from app.realtime.gmail_push import parse_notification
from app.realtime.watcher import AccountWatcher, WatcherRegistry


def _envelope(payload: dict) -> dict:
    return {"message": {"data": base64.b64encode(json.dumps(payload).encode()).decode()}}


def _started(account_id: str) -> AccountWatcher:
    """A watcher whose loop is pretended to be running, so subscribe() starts none."""
    w = AccountWatcher(account_id)
    w._task = asyncio.current_task()
    return w


# ── Pub/Sub envelope ─────────────────────────────────────────────────────────

def test_parse_notification_extracts_address():
    body = _envelope({"emailAddress": "User@Gmail.com", "historyId": 12345})
    assert parse_notification(body) == "user@gmail.com"


def test_parse_notification_rejects_junk():
    assert parse_notification({}) is None
    assert parse_notification({"message": {}}) is None
    assert parse_notification({"message": {"data": "not-base64!!"}}) is None
    assert parse_notification(_envelope({"historyId": 1})) is None  # no address


# ── fan-out ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_watcher_fans_out_to_every_subscriber():
    w = _started("acct-1")
    a, b = w.subscribe(), w.subscribe()

    w.notify("imap-idle")

    for q in (a, b):
        evt = await asyncio.wait_for(q.get(), 1)
        assert evt["changed"] is True
        assert evt["source"] == "imap-idle"
        assert evt["id"] == 1


@pytest.mark.asyncio
async def test_change_event_carries_the_inbox():
    """Tier 2: the client must not need a follow-up fetch."""
    w = _started("acct-1b")
    q = w.subscribe()
    inbox = [{"id": "m1", "subject": "Hello"}]

    w.notify("gmail-push", inbox=inbox)

    evt = await asyncio.wait_for(q.get(), 1)
    assert evt["inbox"] == inbox


@pytest.mark.asyncio
async def test_unsubscribed_queue_stops_receiving():
    w = _started("acct-2")
    q = w.subscribe()
    w.unsubscribe(q)
    w.notify("gmail-push")
    assert q.empty()


@pytest.mark.asyncio
async def test_notify_never_blocks_on_a_full_queue():
    """A tab that stopped reading must not stall delivery to healthy tabs."""
    w = _started("acct-3")
    slow, fast = w.subscribe(), w.subscribe()
    for _ in range(slow.maxsize):
        slow.put_nowait({"filler": True})

    w.notify("imap-idle")  # must not raise or hang
    assert (await asyncio.wait_for(fast.get(), 1))["source"] == "imap-idle"


# ── replay (Tier 3) ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_event_ids_increase_monotonically():
    w = _started("acct-r1")
    assert [w.notify("s")["id"] for _ in range(3)] == [1, 2, 3]


@pytest.mark.asyncio
async def test_replay_returns_only_what_was_missed():
    w = _started("acct-r2")
    for _ in range(5):
        w.notify("gmail-history")

    missed = w.replay_since(2)
    assert [e["id"] for e in missed] == [3, 4, 5]


@pytest.mark.asyncio
async def test_replay_is_empty_when_client_is_current():
    w = _started("acct-r3")
    w.notify("gmail-history")
    assert w.replay_since(1) == []
    assert w.replay_since(None) == []      # a fresh connection
    assert w.replay_since(99) == []        # stale id after a server restart


@pytest.mark.asyncio
async def test_replay_signals_resync_when_too_far_behind():
    """Past the buffer the client cannot be caught up and must refetch."""
    w = _started("acct-r4")
    for _ in range(w._recent.maxlen + 10):
        w.notify("gmail-history")

    assert w.replay_since(1) is None       # evicted from the buffer
    assert w.replay_since(w._seq - 1) is not None   # still replayable


# ── registry ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_registry_notify_is_a_noop_without_listeners():
    reg = WatcherRegistry()
    assert reg.notify("unknown-account", "gmail-push") is False

    w = reg.get("acct-4")
    w._task = asyncio.current_task()
    q = w.subscribe()
    assert reg.notify("acct-4", "gmail-push") is True
    assert (await asyncio.wait_for(q.get(), 1))["changed"] is True


@pytest.mark.asyncio
async def test_wake_shortens_the_sleep_and_resets_backoff():
    """A Pub/Sub push or a tab regaining focus must trigger an immediate check."""
    w = AccountWatcher("acct-5")
    w._quiet_checks = 999          # fully backed off
    assert not w._wake.is_set()

    w.wake()

    assert w._wake.is_set(), "wake() must release the loop's sleep"
    assert w._quiet_checks == 0, "wake() must restore the fast interval"
    await asyncio.wait_for(w._wake.wait(), 0.1)


@pytest.mark.asyncio
async def test_registry_wake_reports_whether_anyone_is_watching():
    reg = WatcherRegistry()
    assert reg.wake("never-seen") is False

    w = reg.get("acct-6")
    assert reg.wake("acct-6") is True
    assert w._wake.is_set()


@pytest.mark.asyncio
async def test_wake_distinguishes_a_real_push_from_a_focus_check():
    """The reported source is evidence, so it must track the real trigger."""
    w = AccountWatcher("acct-7")

    w.wake()                       # tab regained focus
    assert w._push_pending is False

    w.wake(pushed=True)            # genuine Pub/Sub delivery
    assert w._push_pending is True

    # A later focus check must not clear a push that is still unreported.
    w.wake()
    assert w._push_pending is True


@pytest.mark.asyncio
async def test_registry_wake_forwards_the_push_flag():
    reg = WatcherRegistry()
    w = reg.get("acct-8")
    reg.wake("acct-8", pushed=True)
    assert w._push_pending is True
