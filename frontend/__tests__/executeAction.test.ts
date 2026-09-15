/**
 * The UIAction executor is the heart of the app: it is the only thing that
 * turns the assistant's output into visible UI change. These tests pin down
 * that contract, including the approval gate that stops the assistant
 * deleting mail on its own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EmailSummary, EmailDetail } from "@/lib/types";

const api = vi.hoisted(() => ({
  box: vi.fn(async () => [] as EmailSummary[]),
  detail: vi.fn(),
  thread: vi.fn(async () => [] as EmailDetail[]),
  search: vi.fn(async () => [] as EmailSummary[]),
  send: vi.fn(async () => ({ sent_id: "s1" })),
  reply: vi.fn(async () => ({ sent_id: "s2" })),
  forward: vi.fn(async () => ({ sent_id: "s3" })),
  markRead: vi.fn(async () => ({ ok: true })),
  trash: vi.fn(async () => ({ ok: true })),
  spam: vi.fn(async () => ({ ok: true })),
  restore: vi.fn(async () => ({ ok: true })),
  deleteForever: vi.fn(async () => ({ ok: true })),
  wake: vi.fn(async () => ({ ok: true })),
  poll: vi.fn(async () => ({ changed: false })),
}));

vi.mock("@/lib/api", () => ({
  mailApi: api,
  authApi: { me: vi.fn(), googleAuthUrl: vi.fn(), passwordLogin: vi.fn(), logout: vi.fn() },
  assistantApi: { chat: vi.fn() },
}));

import { executeAction, requestDestructive, confirmPendingAction, cancelPendingAction } from "@/assistant/executeAction";
import { useUIStore } from "@/store/uiStore";
import { useMailStore } from "@/store/mailStore";

const email = (id: string, over: Partial<EmailSummary> = {}): EmailSummary => ({
  id,
  thread_id: `t-${id}`,
  subject: `Subject ${id}`,
  sender: `Someone <s${id}@example.com>`,
  snippet: "snippet",
  date: "Mon, 14 Sep 2026 09:00:00 +0530",
  is_unread: false,
  ...over,
});

const detail = (id: string, over: Partial<EmailDetail> = {}): EmailDetail => ({
  ...email(id),
  body_html: "",
  body_text: "body text",
  to: ["me@example.com"],
  cc: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({
    currentView: "inbox",
    selectedEmailId: undefined,
    compose: { to: [], subject: "", body: "" },
    pendingConfirmation: null,
    pendingAction: null,
    notifications: [],
  });
  useMailStore.setState({
    boxes: { inbox: [email("m1"), email("m2", { is_unread: true })], sent: [], spam: [email("sp1")], trash: [email("tr1")] },
    inboxEmails: [],
    sentEmails: [],
    selectedEmail: null,
    thread: [],
    filters: {},
    searchResults: null,
    loading: false,
    error: null,
  });
});

describe("navigation and opening", () => {
  it("NAVIGATE switches view and loads that mailbox", async () => {
    await executeAction({ type: "NAVIGATE", view: "spam" });
    expect(useUIStore.getState().currentView).toBe("spam");
    expect(api.box).toHaveBeenCalledWith("spam");
  });

  it("OPEN_EMAIL shows the detail view for that message", async () => {
    api.detail.mockResolvedValue(detail("m1"));
    await executeAction({ type: "OPEN_EMAIL", emailId: "m1" });
    expect(useUIStore.getState().currentView).toBe("detail");
    expect(useUIStore.getState().selectedEmailId).toBe("m1");
  });
});

describe("compose", () => {
  it("SET_COMPOSE opens compose and fills every supplied field", async () => {
    await executeAction({
      type: "SET_COMPOSE",
      to: ["john@example.com"],
      subject: "Meeting Tomorrow",
      body: "Let's meet at 3pm",
    });
    const { currentView, compose } = useUIStore.getState();
    expect(currentView).toBe("compose");
    expect(compose.to).toEqual(["john@example.com"]);
    expect(compose.subject).toBe("Meeting Tomorrow");
    expect(compose.body).toBe("Let's meet at 3pm");
  });

  it("START_REPLY pre-fills recipient, Re: subject and the drafted body", async () => {
    api.detail.mockResolvedValue(detail("m1", { sender: "Sarah <sarah@example.com>", subject: "Project Update" }));
    await executeAction({ type: "START_REPLY", emailId: "m1", body: "Sending it tomorrow." });
    const { compose } = useUIStore.getState();
    expect(compose.to).toEqual(["Sarah <sarah@example.com>"]);
    expect(compose.subject).toBe("Re: Project Update");
    expect(compose.body).toBe("Sending it tomorrow.");
    expect(compose.replyToId).toBe("m1");
  });

  it("ASK_CONFIRMATION arms the send gate without sending", async () => {
    await executeAction({ type: "ASK_CONFIRMATION", operation: "SEND_EMAIL" });
    expect(useUIStore.getState().pendingConfirmation).toBe("SEND_EMAIL");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("SEND_COMPOSE sends what is in the form", async () => {
    useUIStore.setState({ compose: { to: ["a@b.com"], subject: "Hi", body: "There" } });
    await executeAction({ type: "SEND_COMPOSE" });
    expect(api.send).toHaveBeenCalledWith({ to: ["a@b.com"], subject: "Hi", body: "There" });
  });

  it("SEND_COMPOSE surfaces a missing recipient instead of throwing", async () => {
    useUIStore.setState({ compose: { to: [], subject: "Hi", body: "There" } });
    await executeAction({ type: "SEND_COMPOSE" });
    expect(api.send).not.toHaveBeenCalled();
    expect(useUIStore.getState().notifications.at(-1)?.level).toBe("error");
  });
});

describe("search results", () => {
  it("SET_SEARCH_RESULTS renders emails the server pushed with the action", async () => {
    const found = email("x9", { subject: "Project Update" });
    await executeAction({ type: "SET_SEARCH_RESULTS", emailIds: ["x9"], emails: [found] }, []);
    expect(useMailStore.getState().searchResults).toEqual([found]);
  });

  it("falls back to emails the assistant saw during the turn", async () => {
    const found = email("y7");
    await executeAction({ type: "SET_SEARCH_RESULTS", emailIds: ["y7"] }, [found]);
    expect(useMailStore.getState().searchResults).toEqual([found]);
  });
});

describe("the destructive-action approval gate", () => {
  it("deleting from the inbox asks first and touches nothing", async () => {
    await executeAction({ type: "DELETE_EMAIL", emailIds: ["m1"] });
    expect(useUIStore.getState().pendingAction).toEqual({ kind: "trash", emailIds: ["m1"] });
    expect(api.trash).not.toHaveBeenCalled();
  });

  it("confirming performs the move", async () => {
    requestDestructive("trash", ["m1"]);
    await confirmPendingAction();
    expect(api.trash).toHaveBeenCalledWith("m1");
    expect(useUIStore.getState().pendingAction).toBeNull();
  });

  it("cancelling performs nothing", async () => {
    requestDestructive("trash", ["m1"]);
    cancelPendingAction();
    expect(api.trash).not.toHaveBeenCalled();
    expect(useUIStore.getState().pendingAction).toBeNull();
  });

  it("mail already in the bin is deleted outright, with no prompt", async () => {
    await executeAction({ type: "DELETE_EMAIL", emailIds: ["tr1"] });
    expect(useUIStore.getState().pendingAction).toBeNull();
    expect(api.deleteForever).toHaveBeenCalledWith("tr1");
  });

  it("reporting spam always asks, even from the spam folder", async () => {
    await executeAction({ type: "MARK_SPAM", emailIds: ["sp1"] });
    expect(useUIStore.getState().pendingAction?.kind).toBe("spam");
    expect(api.spam).not.toHaveBeenCalled();
  });

  it("RESTORE_EMAIL is not gated and applies at once", async () => {
    await executeAction({ type: "RESTORE_EMAIL", emailIds: ["sp1"] });
    expect(useUIStore.getState().pendingAction).toBeNull();
    expect(api.restore).toHaveBeenCalledWith("sp1");
  });
});

describe("read state", () => {
  it("MARK_READ clears the unread flag everywhere the message appears", async () => {
    await executeAction({ type: "MARK_READ", emailIds: ["m2"], read: true });
    expect(useMailStore.getState().boxes.inbox.find((e) => e.id === "m2")?.is_unread).toBe(false);
    expect(api.markRead).toHaveBeenCalledWith("m2", true);
  });

  it("MARK_READ can also mark unread", async () => {
    await executeAction({ type: "MARK_READ", emailIds: ["m1"], read: false });
    expect(useMailStore.getState().boxes.inbox.find((e) => e.id === "m1")?.is_unread).toBe(true);
  });
});

describe("the list stays where the user is", () => {
  it("opening a Sent message keeps the list on Sent", async () => {
    // Regression: the list used to be derived from where the message lived, so
    // anything present in two mailboxes (mail sent to yourself) sent the user
    // back to the Inbox the moment they opened it.
    useUIStore.getState().navigate("sent");
    expect(useUIStore.getState().lastBox).toBe("sent");

    api.detail.mockResolvedValue(detail("m1"));
    await executeAction({ type: "OPEN_EMAIL", emailId: "m1" });

    expect(useUIStore.getState().currentView).toBe("detail");
    expect(useUIStore.getState().lastBox).toBe("sent");
  });

  it("composing does not move the list either", async () => {
    useUIStore.getState().navigate("spam");
    await executeAction({ type: "SET_COMPOSE", subject: "Draft" });

    expect(useUIStore.getState().currentView).toBe("compose");
    expect(useUIStore.getState().lastBox).toBe("spam");
  });

  it("lastBox follows every mailbox the user visits", () => {
    for (const box of ["inbox", "sent", "spam", "trash"] as const) {
      useUIStore.getState().navigate(box);
      expect(useUIStore.getState().lastBox).toBe(box);
    }
  });
});
