"""
Gmail push notifications via Google Cloud Pub/Sub.

Gmail cannot POST to an arbitrary URL. It publishes to a Pub/Sub topic, and
that topic push-subscribes to our webhook. Setup needs a public HTTPS URL, so
locally that means a tunnel:

    cloudflared tunnel --url http://localhost:8000

Then, in the Google Cloud console for the same project as the OAuth client:

1. APIs & Services > Library > enable "Cloud Pub/Sub API".
2. Pub/Sub > Topics > Create topic, id `gmail-push`.
3. On that topic: Permissions > Grant access.
   Principal `gmail-api-push@system.gserviceaccount.com`,
   role `Pub/Sub Publisher`. (Gmail publishes as this account; without it
   users.watch() fails with a permission error.)
4. Pub/Sub > Subscriptions > Create subscription on `gmail-push`.
   Delivery type "Push", endpoint:
       https://<tunnel-host>/webhook/gmail?token=<GMAIL_PUSH_TOKEN>
5. In .env set GMAIL_PUBSUB_TOPIC=projects/<project-id>/topics/gmail-push
   and restart the backend. Sign in again so a watch is registered.

The webhook is publicly reachable, so GMAIL_PUSH_TOKEN gates it; requests
without the matching token are rejected with 403.

A watch lasts 7 days and is re-registered on every sign-in. Without the topic
configured the account simply falls back to server-side history polling (see
watcher.py) and everything still works, just a few seconds slower.
"""
import asyncio
import base64
import json
import logging
from typing import Optional

from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

from app.config import settings

log = logging.getLogger(__name__)


def push_enabled() -> bool:
    return bool(getattr(settings, "gmail_pubsub_topic", None))


def _watch_sync(credentials: Credentials, topic: str) -> dict:
    service = build("gmail", "v1", credentials=credentials, cache_discovery=False)
    return service.users().watch(
        userId="me",
        body={"topicName": topic, "labelIds": ["INBOX"], "labelFilterAction": "include"},
    ).execute()


async def register_watch(credentials: Credentials) -> Optional[int]:
    """
    Ask Gmail to publish this mailbox's changes to our topic.
    Returns the historyId to start from, or None when push is not configured.
    A watch lasts 7 days; re-registering on each sign-in keeps it alive.
    """
    topic = getattr(settings, "gmail_pubsub_topic", None)
    if not topic:
        return None
    try:
        result = await asyncio.to_thread(_watch_sync, credentials, topic)
        return int(result.get("historyId", 0)) or None
    except Exception:
        log.warning("Gmail watch registration failed; falling back to polling", exc_info=True)
        return None


def parse_notification(body: dict) -> Optional[str]:
    """
    Pull the mailbox address out of a Pub/Sub push envelope.

    The payload looks like:
      {"message": {"data": "<base64 of {emailAddress, historyId}>", ...}}
    Returns the email address, or None if the envelope is not one of ours.
    """
    try:
        raw = body.get("message", {}).get("data")
        if not raw:
            return None
        decoded = json.loads(base64.b64decode(raw).decode("utf-8"))
        address = decoded.get("emailAddress")
        return address.lower() if address else None
    except Exception:
        return None
