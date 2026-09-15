"use client";
import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { EmailDetail as Detail, MailBox } from "@/lib/types";
import {
  Reply, Forward, ChevronDown, ChevronRight, MessagesSquare, Mail, MailOpen,
  Trash2, ShieldAlert, Undo2, AlertTriangle,
} from "lucide-react";
import { clsx } from "clsx";
import { format } from "date-fns";

interface Props {
  email: Detail;
  thread: Detail[];
  box: MailBox | null;
  onReply: () => void;
  onForward: () => void;
  onToggleRead: () => void;
  onTrash: () => void;
  onSpam: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  loading?: boolean;
}

function displayName(sender: string): string {
  const name = sender.replace(/<.*>/, "").replace(/"/g, "").trim();
  return name || sender.replace(/[<>]/g, "");
}

function initials(sender: string): string {
  const parts = displayName(sender).split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function fmtDate(raw: string): string {
  const d = new Date(raw);
  return isNaN(d.getTime()) ? raw : format(d, "EEE, MMM d, yyyy 'at' h:mm a");
}

function bodyHtml(m: Detail): string {
  return m.body_html
    ? DOMPurify.sanitize(m.body_html)
    : DOMPurify.sanitize(m.body_text).replace(/\n/g, "<br/>");
}

const BTN =
  "flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:text-brand-600 dark:hover:text-brand-400 hover:border-brand-300";
const BTN_DANGER =
  "flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300";

export default function EmailDetailView({
  email, thread, box, onReply, onForward, onToggleRead, onTrash, onSpam, onRestore, onDeleteForever, loading = false,
}: Props) {
  // Conversation = the whole thread when loaded, otherwise just the opened message.
  const messages = useMemo(() => (thread.length ? thread : [email]), [thread, email]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([email.id]));

  useEffect(() => {
    setExpanded(new Set([email.id]));
  }, [email.id]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const unwanted = box === "spam" || box === "trash";

  return (
    <div className="flex-1 overflow-y-auto" data-testid="email-detail">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 truncate" data-testid="detail-subject">{email.subject}</h1>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              {messages.length > 1 && (
                <span className="flex items-center gap-1">
                  <MessagesSquare className="w-3.5 h-3.5" /> {messages.length} messages in this conversation
                </span>
              )}
              {box === "spam" && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="w-3.5 h-3.5" /> In Spam
                </span>
              )}
              {box === "trash" && (
                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" /> In Bin
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0 justify-end">
            <button onClick={onToggleRead} className={BTN} title={email.is_unread ? "Mark as read" : "Mark as unread"} data-testid="detail-toggle-read">
              {email.is_unread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
              {email.is_unread ? "Mark read" : "Mark unread"}
            </button>
            {!unwanted && (
              <>
                <button onClick={onReply} className={BTN} data-testid="detail-reply">
                  <Reply className="w-4 h-4" /> Reply
                </button>
                <button onClick={onForward} className={BTN} data-testid="detail-forward">
                  <Forward className="w-4 h-4" /> Forward
                </button>
                <button onClick={onSpam} className={BTN_DANGER} title="Report spam" data-testid="detail-spam">
                  <ShieldAlert className="w-4 h-4" /> Spam
                </button>
                <button onClick={onTrash} className={BTN_DANGER} title="Move to bin" data-testid="detail-trash">
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </>
            )}
            {unwanted && (
              <>
                <button onClick={onRestore} className={BTN} title="Move back to inbox" data-testid="detail-restore">
                  <Undo2 className="w-4 h-4" /> Restore
                </button>
                <button onClick={onDeleteForever} className={BTN_DANGER} title="Delete permanently" data-testid="detail-delete-forever">
                  <AlertTriangle className="w-4 h-4" /> Delete forever
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Conversation */}
      <div className="p-6 space-y-3">
        {messages.map((m) => {
          const open = expanded.has(m.id);
          const isCurrent = m.id === email.id;
          return (
            <div
              key={m.id}
              className={clsx(
                "rounded-xl border bg-white dark:bg-gray-900 transition-colors",
                isCurrent ? "border-brand-200 dark:border-brand-900" : "border-gray-200 dark:border-gray-800"
              )}
              data-testid="thread-message"
            >
              <button onClick={() => toggle(m.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
                <div className="w-9 h-9 rounded-full bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-400 flex items-center justify-center text-xs font-semibold shrink-0">
                  {initials(m.sender)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {displayName(m.sender)}
                    </span>
                    <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(m.date)}</span>
                  </div>
                  {open ? (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      To: {m.to.join(", ") || "…"}
                      {m.cc.length > 0 && ` · Cc: ${m.cc.join(", ")}`}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{m.snippet}</p>
                  )}
                </div>
                {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
              </button>

              {open && (
                <div className="px-4 pb-4">
                  {loading && isCurrent && !m.body_html && !m.body_text ? (
                    <div className="rounded-lg p-4 border border-gray-100 dark:border-gray-700 space-y-2 animate-pulse" data-testid="body-skeleton">
                      <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-11/12" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-4/5" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-3/5" />
                      <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-2/3" />
                    </div>
                  ) : (
                    <div
                      className="email-body bg-white rounded-lg p-4 border border-gray-100 dark:border-gray-700"
                      dangerouslySetInnerHTML={{ __html: bodyHtml(m) }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
