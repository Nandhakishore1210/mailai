"""
Tool definitions passed to the Claude API.

Only READ tools are exposed to the model. Sending, replying and forwarding are
never performed by the model directly: the model emits UI actions
(SET_COMPOSE / START_REPLY / START_FORWARD / ASK_CONFIRMATION / SEND_COMPOSE) and
the frontend performs the send through the normal mail endpoints after the user
confirms. This keeps a human in the loop structurally, not just by prompt.
"""

SEARCH_MAIL_TOOL = {
    "name": "search_mail",
    "description": (
        "Search the user's mailbox and return email summaries (id, sender, subject, date, snippet). "
        "Use it whenever you need real message IDs or content: 'find the email from Sarah about X', "
        "'open the latest email from David', 'emails from the last 10 days'. "
        "Prefer newer_than_days for relative ranges. Default scope is the inbox."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "sender": {"type": "string", "description": "Filter by sender name or email (partial match ok)"},
            "keyword": {"type": "string", "description": "Free-text query matched against subject and body"},
            "unread": {"type": "boolean", "description": "Only unread messages"},
            "newer_than_days": {"type": "integer", "description": "Only messages from the last N days (7 = this week, 10 = last 10 days)"},
            "from_date": {"type": "string", "description": "Absolute start date YYYY-MM-DD"},
            "to_date": {"type": "string", "description": "Absolute end date YYYY-MM-DD (exclusive)"},
            "scope": {"type": "string", "enum": ["inbox", "sent", "spam", "trash", "all"], "description": "Which mailbox to search. Default inbox."},
            "max_results": {"type": "integer", "default": 10},
        },
    },
}

GET_MAIL_TOOL = {
    "name": "get_mail",
    "description": "Fetch the full content of one email by its ID. Use only with an ID from search_mail or from the UI context.",
    "input_schema": {
        "type": "object",
        "required": ["message_id"],
        "properties": {"message_id": {"type": "string"}},
    },
}

# Tools the model is allowed to call.
MODEL_TOOLS = [SEARCH_MAIL_TOOL, GET_MAIL_TOOL]

# Kept for reference / tests. Not passed to the model.
MAIL_TOOLS = MODEL_TOOLS
