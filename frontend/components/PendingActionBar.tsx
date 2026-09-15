"use client";
import { useState } from "react";
import { AlertTriangle, Trash2, ShieldAlert } from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { describePending, confirmPendingAction, cancelPendingAction } from "@/assistant/executeAction";

/** Approval prompt for bin / spam / permanent-delete requests (human-in-the-loop). */
export default function PendingActionBar() {
  const pending = useUIStore((s) => s.pendingAction);
  const [busy, setBusy] = useState(false);
  if (!pending) return null;

  const danger = pending.kind === "delete_forever";
  const Icon = pending.kind === "spam" ? ShieldAlert : pending.kind === "trash" ? Trash2 : AlertTriangle;

  const confirm = async () => {
    setBusy(true);
    try {
      await confirmPendingAction();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={
        "mx-6 mt-4 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm " +
        (danger
          ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200"
          : "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200")
      }
      data-testid="pending-action-bar"
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1">{describePending(pending)}</span>
      <button
        onClick={confirm}
        disabled={busy}
        className={
          "px-3 py-1 rounded-md font-medium text-white disabled:opacity-50 " +
          (danger ? "bg-red-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-700")
        }
        data-testid="pending-action-confirm"
      >
        {busy ? "Working…" : "Confirm"}
      </button>
      <button onClick={cancelPendingAction} className="underline opacity-80 hover:opacity-100">
        Cancel
      </button>
    </div>
  );
}
