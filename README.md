# MailAI — AI-Powered Gmail Client

A full-stack mail client where an AI assistant controls the visible UI through natural language.

**Stack:** Next.js 14 · FastAPI · PostgreSQL · Gmail API · Claude (Anthropic)

---

## Architecture

```
Natural-language instruction
        |
        v
AI assistant receives compact UI context (view, selected email, active filters)
        |
        +--> if mailbox data needed: call mail tool --> Gmail API
        |
        v
Structured UIAction(s)   e.g. SET_COMPOSE, SET_FILTERS, OPEN_EMAIL
        |
        v
Frontend action executor --> Zustand stores --> React re-renders
        |
        v
User visibly sees compose fill, filter update, navigation, or detail view
```

### Why mail tools and UI actions are separate

| Category | Examples | What it touches |
|---|---|---|
| Mail tools | `search_mail`, `get_mail`, `send_email` | Gmail API — real provider data |
| UI actions | `NAVIGATE`, `SET_COMPOSE`, `SET_FILTERS` | Zustand store — visible app state |

`OPEN_EMAIL` is a UI action (changes the view). `get_mail` is a provider operation (fetches body content). They are never conflated. The AI never invents message IDs — IDs only come from tool call results or the UI context it receives.

### UIAction protocol

```ts
type UIAction =
  | { type: "NAVIGATE"; view: "inbox" | "sent" | "compose" }
  | { type: "OPEN_EMAIL"; emailId: string }
  | { type: "SET_COMPOSE"; to?; subject?; body?; replyToId?; forwardOfId? }
  | { type: "SET_FILTERS"; filters: MailFilters }
  | { type: "SET_SEARCH_RESULTS"; emailIds: string[] }
  | { type: "START_REPLY"; emailId: string }
  | { type: "START_FORWARD"; emailId: string }
  | { type: "ASK_CONFIRMATION"; operation: "SEND_EMAIL" }
  | { type: "SHOW_NOTIFICATION"; level; message }
```

The model emits these as a JSON block in its response. The frontend parses and validates them before execution — no generic DOM commands are ever given to the model.

### Context awareness

The frontend sends a compact `UIContext` with every assistant request:

```json
{
  "currentView": "detail",
  "selectedEmailId": "1929abc...",
  "selectedEmail": { "subject": "Project Update", "sender": "david@example.com" },
  "filters": {}
}
```

When the user says "reply to this", the model reads `selectedEmailId` and emits `START_REPLY(emailId="1929abc...")`. If no email is selected, the model asks for clarification — it never guesses.

### Realtime sync

The browser **never polls**. It opens one Server-Sent Events stream
(`GET /mail/sync/stream`) and the backend pushes when the mailbox changes.

How the provider reaches the backend depends on the account:

| Account type | Mechanism | Measured latency |
|---|---|---|
| Email + app password | **IMAP IDLE** on a dedicated connection | Not yet measured against a live mailbox |
| Gmail OAuth, `GMAIL_PUBSUB_TOPIC` set | **Gmail `watch()` + Cloud Pub/Sub** push to `POST /webhook/gmail` | 3.6 to 4.3 s |
| Gmail OAuth, no topic | Server-side `history.list`, 3 s while active, easing to 20 s when quiet | ~3 s while active |

A note on those Gmail numbers, because they are counter-intuitive. `history.list`
reflects a change about 1.5 s after it happens, so a 3 s poll averages roughly
3 s end to end. Pub/Sub push measures ~4 s, because Gmail's own publish step is
slow; the tunnel and webhook add almost nothing. **Push is therefore not faster
than tight polling for Gmail.** Its value is different:

- Polling stops. With push configured the poll drops to a 60 s safety net,
  removing roughly 1,200 needless API calls per active hour per account.
- An idle mailbox stays live. Without push the poll eases to 20 s after two
  quiet minutes, so a message arriving into a long-idle inbox waits up to 20 s.
  Push still delivers in ~4 s.

Two properties beyond latency:

- **Events carry the mail.** A change event includes the current inbox, so the
  browser renders the new message with no follow-up request. One fetch on the
  server replaces one fetch per connected client.
- **Events are replayable.** Each carries a monotonic `id`, and the last 50 are
  buffered per account. A browser reconnecting after sleep or a dropped network
  sends `Last-Event-ID` and is given exactly what it missed; if it has fallen
  past the buffer it receives a `resync` event and refetches.

Returning to a background tab also calls `POST /mail/sync/wake`, which makes the
watcher check at once instead of waiting out its interval.

`account.history_id` has exactly one writer: the running watcher. An endpoint
that also advanced it would make the watcher skip or replay changes, so
`/mail/send` leaves it alone and the fallback poll declines to persist while a
watcher owns the account.

Setup steps for Gmail push, including the `GMAIL_PUSH_TOKEN` that protects the
public webhook, are at the top of `backend/app/realtime/gmail_push.py`.

One watcher runs per account, shared by every open tab, and shuts down 30
seconds after the last tab disconnects. If the stream cannot connect after
three attempts (a proxy that buffers, say) the client falls back to the old
15-second poll, so sync degrades rather than breaking.

Enabling true Gmail push needs a public HTTPS URL, so it activates on
deployment. Setup steps are documented at the top of
`backend/app/realtime/gmail_push.py`.

---

## Local Setup

### Prerequisites

- **Python 3.12** specifically. 3.13+ has no prebuilt wheels for some
  dependencies yet and will try to compile them from source.
- Node.js 20+
- Docker, for Postgres
- A Google Cloud project with the Gmail API enabled
- An Anthropic API key with credit on it

### 1. Google Cloud / Gmail OAuth

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services
   → Library → enable **Gmail API**.
2. APIs & Services → Credentials → **Create OAuth 2.0 Client ID**, type
   *Web application*.
3. Under *Authorised redirect URIs* add
   `http://localhost:8000/auth/google/callback`.
4. Copy the Client ID and Client Secret.
5. OAuth consent screen → add your Google account under **Test users**.

That last step is not optional. Gmail's read and modify scopes are *restricted*,
so Google blocks any account that is not a listed test user until the app passes
verification. See [Sign-in options](#sign-in-options) for the alternative that
works for any mailbox.

### 2. Database

```bash
docker run -d --name mailai-db \
  -e POSTGRES_DB=mailai -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=password \
  -p 5435:5432 postgres:16-alpine
```

Port 5435 rather than the default 5432, so this does not collide with any
Postgres already running on the machine.

### 3. Environment variables

Create `backend/.env` with the following. Never commit it; `.env` is
git-ignored.

```bash
# Database (matches the docker run above)
DATABASE_URL=postgresql+psycopg2://postgres:password@127.0.0.1:5435/mailai

# Generate these two yourself:
#   python -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY=
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
TOKEN_ENCRYPTION_KEY=

# From step 1
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback

# From console.anthropic.com → API Keys
ANTHROPIC_API_KEY=

FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:8000

# Optional: real Gmail push instead of server-side polling.
# Leave empty to use polling. Setup: backend/app/realtime/gmail_push.py
GMAIL_PUBSUB_TOPIC=
#   python -c "import secrets; print(secrets.token_urlsafe(24))"
GMAIL_PUSH_TOKEN=
```

The frontend reads `NEXT_PUBLIC_API_URL`, so either put the same value in
`frontend/.env.local` or export it before `npm run dev`.

### 4. Backend

```bash
cd backend
py -3.12 -m venv .venv          # macOS/Linux: python3.12 -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Tables are created on startup, so there is no migration step.

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 6. Docker (alternative)

```bash
docker-compose up --build
```

Reads the same variables; put them in a `.env` at the repository root.

## Running Tests

```
backend:   39 tests   (pytest)
frontend:  17 tests   (vitest)
end-to-end: 12 tests  (playwright, against a real mailbox)
```

### Backend

```bash
cd backend
.venv/Scripts/activate      # source .venv/bin/activate on macOS/Linux
pytest
```

Covers the Gmail and IMAP query builders, MIME parsing, the assistant's action
extraction, the realtime fan-out and replay buffer, and the mailbox cache.

### Frontend

```bash
cd frontend
npm test
```

Covers the UIAction executor, which is the only path from the assistant's output
to visible UI change, including the approval gate for destructive actions.

### End-to-end

These drive a real browser against a real mailbox, so the app must be running
(frontend on :3000, backend on :8000) and you need a session cookie. Signing in
for real would mean driving Google's consent screen, so the session is injected.

```bash
# 1. mint a session token
cd backend
.venv/Scripts/python -c "from app.auth.sessions import create_session_token;     from app.db.session import SessionLocal; from app.db.models import User;     db=SessionLocal(); print(create_session_token(db.query(User).first().id))"

# 2. run the suite
cd ../frontend
MAILAI_SESSION_TOKEN=<token> npm run test:e2e
```

`e2e/mail-ui.spec.ts` covers deterministic UI flows and makes no AI calls.
`e2e/assistant-ui.spec.ts` drives the assistant with real model calls, so it is
slower and costs a little; each test asserts the **main interface** changed, not
merely that the chat replied.

## Sign-in options

| Method | Who can use it | How it works |
|---|---|---|
| **Continue with Google** | Accounts listed as *test users* on the Google Cloud OAuth consent screen (max 100) | OAuth 2.0 + Gmail API. The app requests Gmail *restricted* scopes, which Google only unlocks for everyone after a multi-week verification and paid security assessment, so it stays in Testing mode for this submission. |
| **Email + app password** | **Any** Gmail account (and most IMAP providers) | The backend talks IMAP/SMTP directly. Gmail users create an App Password at myaccount.google.com/apppasswords (2-Step Verification required). Gmail's IMAP extensions give the same search syntax and threading as the API. |

Both paths sit behind the same `MailService` interface, so the UI, the realtime poll and the AI assistant are provider-agnostic.

## Security decisions

- **Secrets never reach the frontend or the AI model.** OAuth refresh tokens and IMAP app passwords are encrypted at rest with Fernet (AES-128-CBC) and stored server-side. Access tokens are obtained server-side on demand.
- **Minimal OAuth scopes:** `gmail.readonly`, `gmail.send`, `gmail.modify` — no `gmail.compose`, no `mail.google.com` (full access).
- **Session cookies** are `HttpOnly`, `Secure`, `SameSite=Lax` — not accessible from JavaScript.
- **Send is gated by confirmation.** The assistant emits `ASK_CONFIRMATION` before any `send_email` tool call. The user must explicitly confirm in the UI.
- **No mail cache table.** Gmail is always the source of truth for message content — no risk of stale cached data or reconciliation bugs.

---

## Trade-offs & what would improve with more time

| Area | Current | Improvement |
|---|---|---|
| Realtime | SSE + IMAP IDLE; Gmail falls back to an 8 s server-side check until a public URL exists | Enable the Pub/Sub topic on deploy so Gmail is push too |
| Attachments | Not surfaced | Download and attach files |
| Gmail quota | 10 s mailbox cache, invalidated on every change | Persist summaries so a cold load costs nothing |
| Search | Gmail query string | Full Elasticsearch for cross-field faceted search |
| Assistant history | Stored in DB per conversation | Vector search over history for long-term memory |
| Token refresh | Eager on each request | Background refresh with Redis cache to avoid latency spikes |
| E2E tests | Auth manual session setup | Playwright `storageState` + fixture for reliable test auth |

---

## Demo sequence

1. Open Inbox → real Gmail data loads.
2. "Show unread emails from this week." → main list filters.
3. "Find the email from David about the project update." → filtered results.
4. "Open the latest email from David." → detail view navigates.
5. "Reply to this saying I'll send the update tomorrow." → compose fills.
6. Confirm send → email sent via Gmail API.
7. "Send John an email about tomorrow's meeting." → compose fields fill, confirmation prompt.
8. Edit a compose field manually → assistant and UI share state.
9. New email arrives in connected account → inbox updates within ~15s without refresh.
