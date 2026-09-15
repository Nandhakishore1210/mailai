import { UIAction, EmailSummary, PendingAction, isMailBox } from "@/lib/types";
import { useUIStore } from "@/store/uiStore";
import { useMailStore } from "@/store/mailStore";
import { mailApi } from "@/lib/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Progressively writes text into a compose field so the user can *see* the
 * assistant filling the form (the PDF's "fields visibly fill in").
 */
async function typeInto(field: "subject" | "body", text: string) {
  const ui = useUIStore.getState();
  if (!text) {
    ui.setCompose({ [field]: "" });
    return;
  }
  const frames = 30;
  const step = Math.max(1, Math.ceil(text.length / frames));
  ui.setCompose({ [field]: "" });
  for (let i = step; i < text.length; i += step) {
    useUIStore.getState().setCompose({ [field]: text.slice(0, i) });
    await sleep(18);
  }
  useUIStore.getState().setCompose({ [field]: text });
}

function ensureListView() {
  const ui = useUIStore.getState();
  if (ui.currentView === "detail" || ui.currentView === "compose") {
    ui.navigate("inbox");
  }
}

// ── destructive actions go through an approval gate ─────────────────────────

export function describePending(p: PendingAction): string {
  const n = p.emailIds.length;
  const noun = n === 1 ? "email" : `${n} emails`;
  if (p.kind === "trash") return `Move ${noun} to the bin?`;
  if (p.kind === "spam") return `Report ${noun} as spam?`;
  return `Permanently delete ${noun}? This cannot be undone.`;
}

/** Ask for approval, or run directly when the message is already unwanted (spam/bin). */
export function requestDestructive(kind: PendingAction["kind"], emailIds: string[]) {
  const mail = useMailStore.getState();
  const ui = useUIStore.getState();
  if (!emailIds.length) return;
  const allUnwanted = emailIds.every((id) => {
    const b = mail.boxOf(id);
    return b === "spam" || b === "trash";
  });
  if (kind !== "spam" && allUnwanted) {
    // Already in spam/bin: no approval needed, delete permanently.
    void mail.deleteForever(emailIds);
    return;
  }
  ui.setPendingAction({ kind, emailIds });
}

export async function confirmPendingAction() {
  const ui = useUIStore.getState();
  const p = ui.pendingAction;
  if (!p) return;
  ui.setPendingAction(null);
  const mail = useMailStore.getState();
  if (p.kind === "trash") await mail.moveToTrash(p.emailIds);
  else if (p.kind === "spam") await mail.reportSpam(p.emailIds);
  else await mail.deleteForever(p.emailIds);
}

export function cancelPendingAction() {
  useUIStore.getState().setPendingAction(null);
}

/**
 * Executes one validated UIAction against the Zustand stores.
 * `knownEmails` are summaries the assistant saw during this turn (from tool
 * results) so ID-only actions can be rendered without another round trip.
 */
export async function executeAction(action: UIAction, knownEmails: EmailSummary[] = []): Promise<void> {
  const ui = useUIStore.getState();
  const mail = useMailStore.getState();

  switch (action.type) {
    case "NAVIGATE":
      mail.clearSearch();
      ui.navigate(action.view);
      if (isMailBox(action.view)) mail.fetchBox(action.view);
      break;

    case "OPEN_EMAIL":
      ui.openEmail(action.emailId);
      await mail.fetchDetail(action.emailId);
      break;

    case "SET_COMPOSE": {
      if (ui.currentView !== "compose") ui.navigate("compose");
      const patch: Record<string, unknown> = {};
      if (action.to) patch.to = action.to;
      if (action.replyToId !== undefined) patch.replyToId = action.replyToId;
      if (action.forwardOfId !== undefined) patch.forwardOfId = action.forwardOfId;
      useUIStore.getState().setCompose(patch);
      if (action.subject !== undefined) await typeInto("subject", action.subject);
      if (action.body !== undefined) await typeInto("body", action.body);
      break;
    }

    case "SET_FILTERS": {
      ensureListView();
      const view = useUIStore.getState().currentView;
      const scope = action.filters.scope ?? (isMailBox(view) ? view : "inbox");
      if (isMailBox(scope) && view !== scope) useUIStore.getState().navigate(scope);
      await mail.applyFilters({ ...action.filters, scope });
      break;
    }

    case "SET_SEARCH_RESULTS": {
      ensureListView();
      const pool = [
        ...(action.emails ?? []),
        ...knownEmails,
        ...Object.values(mail.boxes).flat(),
        ...(mail.searchResults ?? []),
      ];
      const byId = new Map(pool.map((e) => [e.id, e]));
      const results = action.emailIds
        .map((id) => byId.get(id))
        .filter(Boolean) as EmailSummary[];
      mail.setSearchResults(results);
      break;
    }

    case "START_REPLY": {
      const detail = await mailApi.detail(action.emailId);
      ui.navigate("compose");
      useUIStore.getState().setCompose({
        to: [detail.sender],
        subject: `Re: ${detail.subject}`,
        body: "",
        replyToId: action.emailId,
        forwardOfId: undefined,
      });
      if (action.body) await typeInto("body", action.body);
      break;
    }

    case "START_FORWARD": {
      const detail = await mailApi.detail(action.emailId);
      ui.navigate("compose");
      useUIStore.getState().setCompose({
        to: action.to ?? [],
        subject: `Fwd: ${detail.subject}`,
        body: "",
        forwardOfId: action.emailId,
        replyToId: undefined,
      });
      const note = action.body ?? "";
      await typeInto("body", `${note}\n\n---------- Forwarded message ----------\n${detail.body_text}`);
      break;
    }

    case "ASK_CONFIRMATION":
      ui.setPendingConfirmation(action.operation);
      break;

    case "SEND_COMPOSE":
      try {
        await mail.sendCompose();
      } catch (err: any) {
        useUIStore.getState().addNotification("error", err?.message || "Failed to send email");
      }
      break;

    case "MARK_READ":
      for (const id of action.emailIds) await mail.markRead(id, action.read ?? true);
      break;

    case "DELETE_EMAIL":
      requestDestructive(action.permanent ? "delete_forever" : "trash", action.emailIds);
      break;

    case "MARK_SPAM":
      requestDestructive("spam", action.emailIds);
      break;

    case "RESTORE_EMAIL":
      await mail.restoreEmails(action.emailIds);
      break;

    case "CONFIRM_ACTION":
      await confirmPendingAction();
      break;

    case "CANCEL_ACTION":
      cancelPendingAction();
      break;

    case "SHOW_NOTIFICATION":
      ui.addNotification(action.level, action.message);
      break;
  }
}
