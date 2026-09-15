"use client";
import { useRef, useEffect, useState } from "react";
import { Bot, Send, ChevronDown, Mail, PenLine } from "lucide-react";
import { clsx } from "clsx";
import { useAssistantStore } from "@/store/assistantStore";
import { useUIStore } from "@/store/uiStore";
import { useMailStore } from "@/store/mailStore";
import { assistantApi } from "@/lib/api";
import { UIAction, UIContext, EmailSummary, AssistantMessage, isMailBox } from "@/lib/types";
import { executeAction } from "@/assistant/executeAction";
import { displayName, initials, avatarColor, formatListDate } from "@/components/mail/EmailList";

const SUGGESTIONS = [
  "Show unread emails from this week",
  "Show emails from the last 10 days",
  "Open the latest email",
  "Send an email to someone@example.com about tomorrow's meeting",
  "Show my spam folder",
];

const ACTION_LABEL: Record<UIAction["type"], string> = {
  NAVIGATE: "navigated",
  OPEN_EMAIL: "opened email",
  SET_COMPOSE: "filled compose",
  SET_FILTERS: "applied filters",
  SET_SEARCH_RESULTS: "showed results",
  START_REPLY: "started reply",
  START_FORWARD: "started forward",
  ASK_CONFIRMATION: "awaiting confirmation",
  SEND_COMPOSE: "sent",
  MARK_READ: "marked read",
  DELETE_EMAIL: "delete requested",
  MARK_SPAM: "spam requested",
  RESTORE_EMAIL: "restored",
  CONFIRM_ACTION: "confirmed",
  CANCEL_ACTION: "cancelled",
  SHOW_NOTIFICATION: "notice",
};

const DRAFT_ACTIONS = new Set<UIAction["type"]>(["SET_COMPOSE", "START_REPLY", "START_FORWARD"]);

function buildUIContext(): UIContext {
  const { currentView, selectedEmailId, compose, pendingConfirmation, pendingAction } = useUIStore.getState();
  const { selectedEmail, filters, searchResults, boxes } = useMailStore.getState();
  const visible = searchResults ?? (isMailBox(currentView) ? boxes[currentView] : boxes.inbox);
  return {
    currentView,
    selectedEmailId,
    selectedEmail: selectedEmail
      ? {
          id: selectedEmail.id,
          subject: selectedEmail.subject,
          sender: selectedEmail.sender,
          date: selectedEmail.date,
          snippet: selectedEmail.snippet.slice(0, 200),
        }
      : undefined,
    visibleEmails: visible.slice(0, 20).map((e) => ({
      id: e.id,
      sender: e.sender,
      subject: e.subject,
      date: e.date,
      is_unread: e.is_unread,
    })),
    compose: { ...compose, body: compose.body.slice(0, 600) },
    filters,
    pendingConfirmation,
    pendingAction: pendingAction ? { kind: pendingAction.kind, count: pendingAction.emailIds.length } : null,
  };
}

function stripActionBlock(text: string): string {
  return text.replace(/```json[\s\S]*?```/g, "").trim();
}

/** Emails a message should render as preview cards. */
function cardsFor(msg: AssistantMessage, pool: EmailSummary[]): EmailSummary[] {
  const actions = msg.actions ?? [];
  const byId = new Map([...(msg.emails ?? []), ...pool].map((e) => [e.id, e]));
  const sr = actions.find((a) => a.type === "SET_SEARCH_RESULTS");
  if (sr && sr.type === "SET_SEARCH_RESULTS") {
    const list = sr.emails?.length ? sr.emails : sr.emailIds.map((id) => byId.get(id)).filter(Boolean) as EmailSummary[];
    if (list.length) return list.slice(0, 5);
  }
  const open = actions.find((a) => a.type === "OPEN_EMAIL");
  if (open && open.type === "OPEN_EMAIL") {
    const e = byId.get(open.emailId);
    if (e) return [e];
  }
  return [];
}

function EmailCard({ email, onOpen }: { email: EmailSummary; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left flex gap-2.5 items-start bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-brand-300 dark:hover:border-brand-700 rounded-lg px-2.5 py-2 transition-colors"
      data-testid="assistant-email-card"
    >
      <div
        className={clsx(
          "w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold",
          avatarColor(email.sender)
        )}
      >
        {initials(email.sender)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">
            {displayName(email.sender)}
          </span>
          <span className="text-[10px] text-gray-400 shrink-0">{formatListDate(email.date)}</span>
        </div>
        <div className="text-xs text-gray-700 dark:text-gray-300 truncate">{email.subject}</div>
        <div className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{email.snippet}</div>
      </div>
    </button>
  );
}

/** Live view of the compose form with confirm/discard controls. */
function DraftCard() {
  const { compose, pendingConfirmation, setPendingConfirmation, resetCompose, navigate, addNotification } = useUIStore();
  const sendCompose = useMailStore((s) => s.sendCompose);
  const [sending, setSending] = useState(false);

  const kind = compose.replyToId ? "Reply" : compose.forwardOfId ? "Forward" : "Draft";

  const send = async () => {
    setSending(true);
    try {
      await sendCompose();
    } catch (err: any) {
      addNotification("error", err?.message || "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  const discard = () => {
    resetCompose();
    setPendingConfirmation(null);
    navigate("inbox");
  };

  return (
    <div
      className="bg-white dark:bg-gray-800 border border-brand-200 dark:border-brand-900 rounded-lg px-3 py-2.5 space-y-1.5"
      data-testid="assistant-draft-card"
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-brand-600 dark:text-brand-400 font-semibold">
        <PenLine className="w-3 h-3" /> {kind}
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-300 truncate">
        <span className="text-gray-400">To:</span> {compose.to.join(", ") || "—"}
      </div>
      <div className="text-xs text-gray-800 dark:text-gray-100 font-medium truncate">{compose.subject || "(no subject)"}</div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-3 whitespace-pre-wrap">{compose.body}</div>
      {pendingConfirmation === "SEND_EMAIL" && (
        <div className="flex gap-2 pt-1">
          <button
            onClick={send}
            disabled={sending}
            className="flex-1 text-xs font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-md py-1.5 disabled:opacity-50"
            data-testid="assistant-confirm-send"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            onClick={discard}
            className="text-xs px-3 rounded-md border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

export default function AssistantPanel() {
  const { messages, conversationId, open, loading, addMessage, setConversationId, setOpen, setLoading } =
    useAssistantStore();
  const { boxes, searchResults } = useMailStore();
  const currentView = useUIStore((s) => s.currentView);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const pool = [...Object.values(boxes).flat(), ...(searchResults ?? [])];
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || loading) return;
    setInput("");
    addMessage({ role: "user", content: text });
    setLoading(true);

    try {
      const ctx = buildUIContext();
      const res = await assistantApi.chat(text, ctx, conversationId);
      setConversationId(res.conversation_id);
      const actions = (res.actions ?? []) as UIAction[];
      const emails = (res.emails ?? []) as EmailSummary[];
      addMessage({ role: "assistant", content: res.reply, actions, emails });
      for (const action of actions) {
        await executeAction(action, emails);
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      addMessage({
        role: "assistant",
        content: typeof detail === "string" ? detail : "Sorry, something went wrong. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  };

  const openEmail = (id: string) => executeAction({ type: "OPEN_EMAIL", emailId: id });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 bg-brand-600 hover:bg-brand-700 text-white rounded-full p-4 shadow-lg transition-colors z-50"
        data-testid="assistant-toggle"
      >
        <Bot className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 right-0 w-96 h-[600px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-tl-xl shadow-xl flex flex-col z-50">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-brand-600 rounded-tl-xl">
        <div className="flex items-center gap-2 text-white font-semibold">
          <Bot className="w-5 h-5" /> AI Assistant
        </div>
        <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-gray-400 text-center">
              I can search, filter, open, compose and reply for you. Try:
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="w-full text-left text-xs bg-gray-50 dark:bg-gray-800 hover:bg-brand-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 hover:text-brand-700 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((msg, i) => {
          const isAssistant = msg.role === "assistant";
          const cards = isAssistant ? cardsFor(msg, pool) : [];
          const showDraft =
            isAssistant &&
            i === lastAssistantIdx &&
            currentView === "compose" &&
            (msg.actions ?? []).some((a) => DRAFT_ACTIONS.has(a.type));
          return (
            <div key={i} className={clsx("space-y-2", !isAssistant && "flex justify-end")}>
              <div
                className={clsx(
                  "max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap",
                  isAssistant
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100"
                    : "bg-brand-600 text-white"
                )}
                data-testid={isAssistant ? "assistant-message" : "user-message"}
              >
                {stripActionBlock(msg.content)}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {msg.actions.map((a, j) => (
                      <span
                        key={j}
                        className="text-[10px] uppercase tracking-wide bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 rounded"
                      >
                        {ACTION_LABEL[a.type] ?? a.type}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {cards.length > 0 && (
                <div className="max-w-[85%] space-y-1.5">
                  {cards.map((e) => (
                    <EmailCard key={e.id} email={e} onOpen={() => openEmail(e.id)} />
                  ))}
                  {msg.actions?.some((a) => a.type === "SET_SEARCH_RESULTS" && a.emailIds.length > cards.length) && (
                    <p className="text-[11px] text-gray-400 flex items-center gap-1 px-1">
                      <Mail className="w-3 h-3" /> More results are shown in the main list
                    </p>
                  )}
                </div>
              )}
              {showDraft && (
                <div className="max-w-[85%]">
                  <DraftCard />
                </div>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="bg-gray-100 dark:bg-gray-800 text-gray-500 text-sm px-3 py-2 rounded-xl w-16 animate-pulse">...</div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 px-3 py-3 border-t border-gray-100 dark:border-gray-800">
        <input
          className="flex-1 text-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500"
          placeholder="Ask your assistant..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          data-testid="assistant-input"
        />
        <button
          onClick={() => send()}
          disabled={loading}
          className="bg-brand-600 hover:bg-brand-700 text-white p-2 rounded-lg transition-colors disabled:opacity-50"
          data-testid="assistant-send"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
