"use client";
import { EmailSummary } from "@/lib/types";
import { clsx } from "clsx";
import { format, isToday, isThisYear } from "date-fns";
import { Mail, MailOpen, Trash2 } from "lucide-react";

interface Props {
  emails: EmailSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading: boolean;
  emptyMessage?: string;
  onToggleRead?: (id: string, read: boolean) => void;
  onPrefetch?: (id: string) => void;
  onTrash?: (id: string) => void;
}

export function formatListDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  if (isToday(d)) return format(d, "h:mm a");
  if (isThisYear(d)) return format(d, "MMM d");
  return format(d, "dd/MM/yy");
}

export function displayName(sender: string): string {
  const name = sender.replace(/<.*>/, "").replace(/"/g, "").trim();
  return name || sender.replace(/[<>]/g, "");
}

export function initials(sender: string): string {
  const parts = displayName(sender).split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
];
export function avatarColor(sender: string): string {
  let h = 0;
  for (const ch of sender) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Skeleton() {
  return (
    <ul className="flex-1 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="px-4 py-3 flex gap-3">
          <div className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-800 shrink-0" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-2/3" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800/60 rounded w-5/6" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function EmailList({ emails, selectedId, onSelect, loading, emptyMessage, onToggleRead, onPrefetch, onTrash }: Props) {
  if (loading && emails.length === 0) return <Skeleton />;

  if (!emails.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm px-6 text-center">
        {emptyMessage ?? "No emails"}
      </div>
    );
  }

  return (
    <ul
      className={clsx("flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800", loading && "opacity-60")}
      data-testid="email-list"
    >
      {emails.map((email) => {
        const selected = selectedId === email.id;
        return (
          <li
            key={email.id}
            onClick={() => onSelect(email.id)}
            onMouseEnter={() => onPrefetch?.(email.id)}
            className={clsx(
              "group px-4 py-3 cursor-pointer flex gap-3 transition-colors border-l-2",
              selected
                ? "bg-brand-50 dark:bg-brand-900/30 border-brand-500"
                : "border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60"
            )}
            data-testid="email-row"
          >
            <div
              className={clsx(
                "w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold",
                avatarColor(email.sender)
              )}
            >
              {initials(email.sender)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-baseline gap-2">
                <span
                  className={clsx(
                    "text-sm truncate",
                    email.is_unread
                      ? "font-semibold text-gray-900 dark:text-gray-100"
                      : "text-gray-700 dark:text-gray-300"
                  )}
                >
                  {displayName(email.sender)}
                </span>
                <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                  {formatListDate(email.date)}
                </span>
              </div>
              <div
                className={clsx(
                  "text-sm truncate mt-0.5",
                  email.is_unread
                    ? "font-medium text-gray-800 dark:text-gray-200"
                    : "text-gray-600 dark:text-gray-400"
                )}
                data-testid="row-subject"
              >
                {email.subject}
              </div>
              <div className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">{email.snippet}</div>
            </div>
            <div className="flex flex-col items-center gap-1.5 shrink-0 mt-1">
              {email.is_unread && <span className="w-2 h-2 rounded-full bg-brand-500" title="Unread" />}
              {onToggleRead && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRead(email.id, email.is_unread);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 transition-opacity"
                  title={email.is_unread ? "Mark as read" : "Mark as unread"}
                  data-testid="row-toggle-read"
                >
                  {email.is_unread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
                </button>
              )}
              {onTrash && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrash(email.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-opacity"
                  title="Delete"
                  data-testid="row-trash"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
