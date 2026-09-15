export interface EmailSummary {
  id: string;
  thread_id: string;
  subject: string;
  sender: string;
  snippet: string;
  date: string;
  is_unread: boolean;
}

export interface EmailDetail extends EmailSummary {
  body_html: string;
  body_text: string;
  to: string[];
  cc: string[];
}

export type MailBox = "inbox" | "sent" | "spam" | "trash";
export const MAILBOXES: MailBox[] = ["inbox", "sent", "spam", "trash"];
export const isMailBox = (v: string): v is MailBox => (MAILBOXES as string[]).includes(v);

export type MailScope = MailBox | "all";

export interface MailFilters {
  sender?: string;
  keyword?: string;
  unread?: boolean;
  from_date?: string; // YYYY-MM-DD
  to_date?: string; // YYYY-MM-DD
  newer_than_days?: number;
  scope?: MailScope;
}

export interface ComposeState {
  to: string[];
  subject: string;
  body: string;
  replyToId?: string;
  forwardOfId?: string;
}

export type CurrentView = MailBox | "detail" | "compose";

/** A destructive operation waiting for the user's approval. */
export interface PendingAction {
  kind: "trash" | "spam" | "delete_forever";
  emailIds: string[];
}

// UI Action protocol — the only way the assistant changes the screen.
export type UIAction =
  | { type: "NAVIGATE"; view: MailBox | "compose" }
  | { type: "OPEN_EMAIL"; emailId: string }
  | { type: "SET_COMPOSE"; to?: string[]; subject?: string; body?: string; replyToId?: string; forwardOfId?: string }
  | { type: "SET_FILTERS"; filters: MailFilters }
  | { type: "SET_SEARCH_RESULTS"; emailIds: string[]; emails?: EmailSummary[] }
  | { type: "START_REPLY"; emailId: string; body?: string }
  | { type: "START_FORWARD"; emailId: string; to?: string[]; body?: string }
  | { type: "ASK_CONFIRMATION"; operation: "SEND_EMAIL" }
  | { type: "SEND_COMPOSE" }
  | { type: "MARK_READ"; emailIds: string[]; read?: boolean }
  | { type: "DELETE_EMAIL"; emailIds: string[]; permanent?: boolean }
  | { type: "MARK_SPAM"; emailIds: string[] }
  | { type: "RESTORE_EMAIL"; emailIds: string[] }
  | { type: "CONFIRM_ACTION" }
  | { type: "CANCEL_ACTION" }
  | { type: "SHOW_NOTIFICATION"; level: "info" | "success" | "error"; message: string };

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  actions?: UIAction[];
  emails?: EmailSummary[];
}

/** Compact snapshot of the UI sent with every assistant request. */
export interface UIContext {
  currentView: CurrentView;
  selectedEmailId?: string;
  selectedEmail?: { id: string; subject: string; sender: string; date: string; snippet: string };
  visibleEmails: Array<Pick<EmailSummary, "id" | "sender" | "subject" | "date" | "is_unread">>;
  compose: ComposeState;
  filters: MailFilters;
  pendingConfirmation: "SEND_EMAIL" | null;
  pendingAction: { kind: PendingAction["kind"]; count: number } | null;
}
