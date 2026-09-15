import asyncio
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials


def _check_sync(credentials: Credentials, stored_history_id: int) -> tuple[bool, int]:
    service = build("gmail", "v1", credentials=credentials, cache_discovery=False)
    try:
        result = service.users().history().list(
            userId="me",
            startHistoryId=str(stored_history_id),
            historyTypes=["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        ).execute()
        new_id = int(result.get("historyId", stored_history_id))
        changed = bool(result.get("history"))
        return changed, new_id
    except Exception:
        # 404 means the stored historyId is too old — force a refresh.
        profile = service.users().getProfile(userId="me").execute()
        new_id = int(profile.get("historyId", stored_history_id))
        return True, new_id


async def check_history(credentials: Credentials, stored_history_id: int) -> tuple[bool, int]:
    """
    Returns (has_changes, new_history_id). Runs the blocking Google call in a
    worker thread so the poll never stalls other requests.
    """
    return await asyncio.to_thread(_check_sync, credentials, stored_history_id)
