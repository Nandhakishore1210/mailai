import json
import re
from dataclasses import asdict
from datetime import datetime
from anthropic import AsyncAnthropic
from app.config import settings
from app.assistant.prompt import SYSTEM_PROMPT
from app.assistant.tools import MODEL_TOOLS
from app.mail.service import MailService, MailFilters

client = AsyncAnthropic(api_key=settings.anthropic_api_key)
MODEL = "claude-sonnet-4-6"
MAX_TOOL_ROUNDS = 5


def _extract_actions(text: str) -> list[dict]:
    match = re.search(r"```json\s*(\[.*?\])\s*```", text, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    return [a for a in parsed if isinstance(a, dict) and "type" in a]


def _summary_dict(obj) -> dict:
    """Reduce an EmailSummary/EmailDetail to the summary fields only."""
    d = asdict(obj)
    return {k: d[k] for k in ("id", "thread_id", "subject", "sender", "snippet", "date", "is_unread")}


async def run_assistant(
    messages: list[dict],
    ui_context: dict,
    mail_service: MailService,
) -> dict:
    """
    Returns {"reply": str, "actions": list[dict], "emails": list[dict]}.
    `emails` are every summary the model saw via tools during this turn, so the
    frontend can render results the model refers to by ID.
    """
    today = datetime.now().strftime("%A %Y-%m-%d")
    context_note = f"\n\n[Today is {today}. Current UI context: {json.dumps(ui_context)}]"
    patched = messages[:-1] + [
        {**messages[-1], "content": messages[-1]["content"] + context_note}
    ]

    collected: dict[str, dict] = {}

    response = await client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        tools=MODEL_TOOLS,
        messages=patched,
    )

    loop_messages = list(patched)
    rounds = 0
    while response.stop_reason == "tool_use" and rounds < MAX_TOOL_ROUNDS:
        rounds += 1
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            result = await _dispatch_tool(block.name, block.input, mail_service, collected)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result),
            })

        loop_messages = loop_messages + [
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": tool_results},
        ]
        response = await client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            tools=MODEL_TOOLS,
            messages=loop_messages,
        )

    reply_text = "".join(getattr(b, "text", "") for b in response.content)
    actions = _extract_actions(reply_text)

    # Attach full summaries to search-result actions so the UI can render them
    for action in actions:
        if action.get("type") == "SET_SEARCH_RESULTS":
            ids = action.get("emailIds") or []
            action["emails"] = [collected[i] for i in ids if i in collected]

    return {"reply": reply_text, "actions": actions, "emails": list(collected.values())}


async def _dispatch_tool(name: str, args: dict, mail: MailService, collected: dict) -> dict:
    try:
        if name == "search_mail":
            filters = MailFilters(
                sender=args.get("sender"),
                keyword=args.get("keyword"),
                unread=args.get("unread"),
                from_date=args.get("from_date"),
                to_date=args.get("to_date"),
                newer_than_days=args.get("newer_than_days"),
                scope=args.get("scope") or "inbox",
            )
            results = await mail.search_messages(filters)
            limit = int(args.get("max_results") or 10)
            summaries = [_summary_dict(r) for r in results[:limit]]
            for s in summaries:
                collected[s["id"]] = s
            return {"count": len(summaries), "emails": summaries}

        if name == "get_mail":
            detail = await mail.get_message(args["message_id"])
            collected[detail.id] = _summary_dict(detail)
            d = asdict(detail)
            d["body_text"] = (d.get("body_text") or "")[:4000]
            d.pop("body_html", None)
            return d

        return {"error": f"unknown tool {name}"}
    except Exception as exc:
        return {"error": str(exc)}
