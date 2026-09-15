import { create } from "zustand";
import { EmailSummary, EmailDetail, MailFilters, MailBox, MAILBOXES } from "@/lib/types";
import { mailApi } from "@/lib/api";
import { useUIStore } from "@/store/uiStore";

type BoxLists = Record<MailBox, EmailSummary[]>;

interface MailStore {
  boxes: BoxLists;
  /** Convenience aliases kept for existing callers. */
  inboxEmails: EmailSummary[];
  sentEmails: EmailSummary[];
  selectedEmail: EmailDetail | null;
  /** True while the body of the selected email is still being fetched. */
  detailLoading: boolean;
  thread: EmailDetail[]; // all messages in the selected email's conversation
  filters: MailFilters;
  searchResults: EmailSummary[] | null; // null = no active search/filter
  loading: boolean;
  error: string | null;

  fetchBox: (box: MailBox) => Promise<void>;
  fetchInbox: () => Promise<void>;
  fetchSent: () => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
  /** Warm the detail cache (e.g. on row hover) so opening feels instant. */
  prefetchDetail: (id: string) => void;
  applyFilters: (filters: MailFilters) => Promise<void>;
  setSearchResults: (emails: EmailSummary[]) => void;
  clearSearch: () => void;
  setFilters: (filters: MailFilters) => void;
  /** Sends whatever is in the compose form (used by the Send button and by the assistant). */
  sendCompose: () => Promise<void>;
  /** Optimistically flips read state everywhere it is shown, then persists it. */
  markRead: (id: string, read: boolean) => Promise<void>;
  /** Which mailbox list an id currently lives in (null if unknown). */
  boxOf: (id: string) => MailBox | null;
  /**
   * Called by the realtime stream. `pushedInbox` is the inbox the server sent
   * with the event; when present no network request is needed at all.
   */
  syncNow: (pushedInbox?: EmailSummary[]) => Promise<void>;
  moveToTrash: (ids: string[]) => Promise<void>;
  reportSpam: (ids: string[]) => Promise<void>;
  restoreEmails: (ids: string[]) => Promise<void>;
  deleteForever: (ids: string[]) => Promise<void>;
}

// Caches live outside the store: they never need to trigger a re-render.
const detailCache = new Map<string, EmailDetail>();
const threadCache = new Map<string, EmailDetail[]>();
const inflight = new Map<string, Promise<EmailDetail>>();

function loadDetail(id: string): Promise<EmailDetail> {
  const cached = detailCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = mailApi
    .detail(id)
    .then((d) => {
      detailCache.set(id, d);
      return d;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

function loadThread(threadId: string): Promise<EmailDetail[]> {
  const cached = threadCache.get(threadId);
  if (cached) return Promise.resolve(cached);
  return mailApi.thread(threadId).then((t) => {
    threadCache.set(threadId, t);
    return t;
  });
}

const isSelected = (id: string) => useUIStore.getState().selectedEmailId === id;
const emptyBoxes = (): BoxLists => ({ inbox: [], sent: [], spam: [], trash: [] });

export const useMailStore = create<MailStore>((set, get) => ({
  boxes: emptyBoxes(),
  inboxEmails: [],
  sentEmails: [],
  selectedEmail: null,
  detailLoading: false,
  thread: [],
  filters: {},
  searchResults: null,
  loading: false,
  error: null,

  fetchBox: async (box) => {
    set({ loading: true, error: null });
    try {
      const emails = await mailApi.box(box);
      set((s) => {
        const boxes = { ...s.boxes, [box]: emails };
        return { boxes, inboxEmails: boxes.inbox, sentEmails: boxes.sent, loading: false };
      });
    } catch {
      set({ error: `Failed to load ${box}`, loading: false });
    }
  },
  fetchInbox: () => get().fetchBox("inbox"),
  fetchSent: () => get().fetchBox("sent"),

  fetchDetail: async (id: string) => {
    const s = get();
    const summary = [...Object.values(s.boxes).flat(), ...(s.searchResults ?? [])].find((e) => e.id === id);
    const cached = detailCache.get(id);

    // 1. Paint immediately: cached body if we have it, otherwise the header from the list.
    if (cached) {
      set({ selectedEmail: cached, detailLoading: false, thread: threadCache.get(cached.thread_id) ?? [], error: null });
    } else {
      set({
        selectedEmail: summary ? { ...summary, body_html: "", body_text: "", to: [], cc: [] } : null,
        detailLoading: true,
        thread: [],
        error: null,
      });
    }

    // 2. Opening marks it read, like any mail client (optimistic, in the background).
    if ((cached ?? summary)?.is_unread) get().markRead(id, true);

    // 3. Fetch the body (no-op when cached) and then the conversation.
    try {
      const detail = await loadDetail(id);
      if (!isSelected(id)) return;
      const readNow = get().selectedEmail?.id === id ? get().selectedEmail!.is_unread : detail.is_unread;
      set({ selectedEmail: { ...detail, is_unread: readNow }, detailLoading: false });
      if (detail.thread_id) {
        loadThread(detail.thread_id)
          .then((msgs) => {
            if (isSelected(id)) set({ thread: msgs });
          })
          .catch(() => {});
      }
    } catch {
      if (isSelected(id)) set({ error: "Message not found", detailLoading: false });
    }
  },

  prefetchDetail: (id: string) => {
    if (detailCache.has(id) || inflight.has(id)) return;
    loadDetail(id).catch(() => {});
  },

  applyFilters: async (filters: MailFilters) => {
    set({ filters, loading: true, error: null });
    try {
      const results = await mailApi.search(filters);
      set({ searchResults: results, loading: false });
    } catch {
      set({ error: "Search failed", loading: false });
    }
  },

  setSearchResults: (emails) => set({ searchResults: emails }),
  clearSearch: () => set({ searchResults: null, filters: {} }),
  setFilters: (filters) => set({ filters }),

  markRead: async (id, read) => {
    const flip = <T extends EmailSummary>(list: T[]) => list.map((e) => (e.id === id ? { ...e, is_unread: !read } : e));
    const cachedDetail = detailCache.get(id);
    if (cachedDetail) detailCache.set(id, { ...cachedDetail, is_unread: !read });
    set((s) => {
      const boxes = Object.fromEntries(MAILBOXES.map((b) => [b, flip(s.boxes[b])])) as BoxLists;
      return {
        boxes,
        inboxEmails: boxes.inbox,
        sentEmails: boxes.sent,
        searchResults: s.searchResults ? flip(s.searchResults) : s.searchResults,
        selectedEmail: s.selectedEmail?.id === id ? { ...s.selectedEmail, is_unread: !read } : s.selectedEmail,
        thread: flip(s.thread),
      };
    });
    try {
      await mailApi.markRead(id, read);
    } catch {
      useUIStore.getState().addNotification("error", "Could not update read state");
    }
  },

  syncNow: async (pushedInbox) => {
    const view = useUIStore.getState().currentView;
    const box: MailBox = (MAILBOXES as string[]).includes(view) ? (view as MailBox) : "inbox";

    const before = new Set(get().boxes.inbox.map((e) => e.id));

    if (pushedInbox) {
      // The event carried the mail: render it with no round trip.
      set((s) => {
        const boxes = { ...s.boxes, inbox: pushedInbox };
        return { boxes, inboxEmails: pushedInbox, sentEmails: boxes.sent };
      });
    } else {
      await get().fetchBox("inbox");
    }

    // Whatever else is on screen still needs its own refresh.
    const s = get();
    if (s.searchResults && Object.keys(s.filters).length) {
      await s.applyFilters(s.filters);
    } else if (box !== "inbox") {
      await get().fetchBox(box);
    }

    const arrived = get().boxes.inbox.filter((e) => !before.has(e.id));
    if (before.size && arrived.length) {
      const first = arrived[0];
      const who = first.sender.replace(/<.*>/, "").trim() || first.sender;
      useUIStore.getState().addNotification(
        "info",
        arrived.length === 1 ? `New email from ${who}` : `${arrived.length} new emails`
      );
    }
  },

  boxOf: (id) => {
    const { boxes } = get();
    for (const b of MAILBOXES) if (boxes[b].some((e) => e.id === id)) return b;
    // IMAP ids carry their folder: "SPAM:12", "TRASH:7", "INBOX:4", "SENT:9"
    const prefix = id.split(":")[0].toLowerCase();
    return (MAILBOXES as string[]).includes(prefix) ? (prefix as MailBox) : null;
  },

  moveToTrash: (ids) => runBulk(get, set, ids, mailApi.trash, "Moved to bin", ["trash"]),
  reportSpam: (ids) => runBulk(get, set, ids, mailApi.spam, "Reported as spam", ["spam"]),
  restoreEmails: (ids) => runBulk(get, set, ids, mailApi.restore, "Restored to inbox", ["inbox"]),
  deleteForever: (ids) => runBulk(get, set, ids, mailApi.deleteForever, "Deleted permanently", []),

  sendCompose: async () => {
    const ui = useUIStore.getState();
    const { compose } = ui;
    const tos = compose.to.map((t) => t.trim()).filter(Boolean);

    if (compose.replyToId) {
      await mailApi.reply(compose.replyToId, compose.body);
    } else if (compose.forwardOfId) {
      if (!tos.length) throw new Error("Add at least one recipient before sending.");
      await mailApi.forward(compose.forwardOfId, tos, compose.body);
    } else {
      if (!tos.length) throw new Error("Add at least one recipient before sending.");
      await mailApi.send({ to: tos, subject: compose.subject, body: compose.body });
    }

    // A sent reply changes its conversation; forget the cached thread.
    if (compose.replyToId) {
      const d = detailCache.get(compose.replyToId);
      if (d) threadCache.delete(d.thread_id);
    }

    const after = useUIStore.getState();
    after.addNotification("success", "Email sent");
    after.resetCompose();
    after.setPendingConfirmation(null);
    after.navigate("inbox");
    get().clearSearch();
    get().fetchInbox();
    get().fetchSent();
  },
}));

/**
 * Remove ids from every list right away, run the server op for each, then
 * refresh the destination boxes so the moved messages appear there with
 * their new ids.
 */
async function runBulk(
  get: () => MailStore,
  set: (partial: Partial<MailStore> | ((s: MailStore) => Partial<MailStore>)) => void,
  ids: string[],
  op: (id: string) => Promise<unknown>,
  successMessage: string,
  refreshBoxes: MailBox[]
) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const drop = <T extends EmailSummary>(list: T[]) => list.filter((e) => !idSet.has(e.id));
  const touched = new Set<MailBox>(refreshBoxes);
  for (const id of ids) {
    const b = get().boxOf(id);
    if (b) touched.add(b);
    detailCache.delete(id);
  }
  set((s) => {
    const boxes = Object.fromEntries(MAILBOXES.map((b) => [b, drop(s.boxes[b])])) as BoxLists;
    const selectedGone = s.selectedEmail && idSet.has(s.selectedEmail.id);
    return {
      boxes,
      inboxEmails: boxes.inbox,
      sentEmails: boxes.sent,
      searchResults: s.searchResults ? drop(s.searchResults) : s.searchResults,
      selectedEmail: selectedGone ? null : s.selectedEmail,
      thread: selectedGone ? [] : drop(s.thread),
    };
  });
  const ui = useUIStore.getState();
  if (ui.currentView === "detail" && ui.selectedEmailId && idSet.has(ui.selectedEmailId)) {
    ui.navigate(get().boxOf(ui.selectedEmailId) ?? "inbox");
  }

  const results = await Promise.allSettled(ids.map((id) => op(id)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) {
    useUIStore.getState().addNotification("error", `${failed} of ${ids.length} failed`);
  } else {
    useUIStore.getState().addNotification("success", `${successMessage} (${ids.length})`);
  }
  for (const b of touched) get().fetchBox(b);
}
