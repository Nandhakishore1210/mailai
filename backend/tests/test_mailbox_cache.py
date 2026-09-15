"""
The mailbox cache exists to stop the app exhausting Gmail's per-minute quota.
Correctness matters as much as the saving: it must never serve mail from before
a change the user just made.
"""
import time

from app.mail.cache import MailboxCache
from app.mail.service import EmailSummary


def mail(i: str) -> EmailSummary:
    return EmailSummary(
        id=i, thread_id=f"t{i}", subject=f"Subject {i}", sender="a@b.com",
        snippet="s", date="Mon, 14 Sep 2026 09:00:00 +0530", is_unread=False,
    )


def test_returns_what_was_stored():
    c = MailboxCache(ttl=60)
    c.put("acct", "inbox", 20, [mail("1")])
    assert [e.id for e in c.get("acct", "inbox", 20)] == ["1"]


def test_miss_on_unknown_key():
    c = MailboxCache(ttl=60)
    c.put("acct", "inbox", 20, [mail("1")])
    assert c.get("other-acct", "inbox", 20) is None   # never leak across accounts
    assert c.get("acct", "sent", 20) is None          # nor across mailboxes
    assert c.get("acct", "inbox", 50) is None         # nor across page sizes


def test_entry_expires():
    c = MailboxCache(ttl=0.05)
    c.put("acct", "inbox", 20, [mail("1")])
    time.sleep(0.08)
    assert c.get("acct", "inbox", 20) is None


def test_invalidate_clears_one_account_only():
    c = MailboxCache(ttl=60)
    c.put("a", "inbox", 20, [mail("1")])
    c.put("b", "inbox", 20, [mail("2")])

    c.invalidate("a")

    assert c.get("a", "inbox", 20) is None
    assert c.get("b", "inbox", 20) is not None


def test_invalidate_can_target_a_single_mailbox():
    c = MailboxCache(ttl=60)
    c.put("a", "inbox", 20, [mail("1")])
    c.put("a", "sent", 20, [mail("2")])

    c.invalidate("a", box="inbox")

    assert c.get("a", "inbox", 20) is None
    assert c.get("a", "sent", 20) is not None


def test_put_replaces_and_refreshes_the_clock():
    c = MailboxCache(ttl=60)
    c.put("a", "inbox", 20, [mail("old")])
    c.put("a", "inbox", 20, [mail("new")])
    assert [e.id for e in c.get("a", "inbox", 20)] == ["new"]
