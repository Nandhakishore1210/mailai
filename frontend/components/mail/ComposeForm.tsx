"use client";
import { useEffect, useState } from "react";
import { useUIStore } from "@/store/uiStore";
import { useMailStore } from "@/store/mailStore";
import { Send, X } from "lucide-react";
import { clsx } from "clsx";

const parseTo = (raw: string) => raw.split(",").map((t) => t.trim()).filter(Boolean);

const FIELD =
  "border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

export default function ComposeForm() {
  const { compose, setCompose, resetCompose, pendingConfirmation, setPendingConfirmation, addNotification, navigate } =
    useUIStore();
  const { sendCompose } = useMailStore();
  const [sending, setSending] = useState(false);

  // Raw text for the To field. Kept locally so the user can type commas
  // freely, but re-synced whenever the store changes (e.g. the assistant fills it).
  const [toRaw, setToRaw] = useState(compose.to.join(", "));
  useEffect(() => {
    const storeTo = compose.to.join(", ");
    if (parseTo(toRaw).join(", ") !== compose.to.join(", ")) setToRaw(storeTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose.to]);

  const handleSend = async () => {
    if (!pendingConfirmation) {
      setPendingConfirmation("SEND_EMAIL");
      return;
    }
    setSending(true);
    try {
      await sendCompose();
    } catch (err: any) {
      addNotification("error", err?.message || "Failed to send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const title = compose.replyToId ? "Reply" : compose.forwardOfId ? "Forward" : "New Message";

  return (
    <div className="flex-1 p-6 flex flex-col gap-4 max-w-2xl" data-testid="compose-form">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
        <button onClick={() => { resetCompose(); setPendingConfirmation(null); navigate("inbox"); }}>
          <X className="w-5 h-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" />
        </button>
      </div>

      <input
        className={clsx(FIELD, "disabled:bg-gray-50 dark:disabled:bg-gray-800")}
        placeholder="To (comma-separated)"
        value={toRaw}
        disabled={!!compose.replyToId}
        onChange={(e) => {
          setToRaw(e.target.value);
          setCompose({ to: parseTo(e.target.value) });
        }}
        data-testid="compose-to"
      />

      <input
        className={FIELD}
        placeholder="Subject"
        value={compose.subject}
        onChange={(e) => setCompose({ subject: e.target.value })}
        data-testid="compose-subject"
      />

      <textarea
        className={clsx(FIELD, "flex-1 min-h-[220px] resize-none")}
        placeholder="Write your message..."
        value={compose.body}
        onChange={(e) => setCompose({ body: e.target.value })}
        data-testid="compose-body"
      />

      {pendingConfirmation === "SEND_EMAIL" ? (
        <div
          className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 text-sm text-yellow-800 dark:text-yellow-200 flex items-center gap-3"
          data-testid="send-confirmation"
        >
          <span>Send this email{compose.to.length ? ` to ${compose.to.join(", ")}` : ""}?</span>
          <button
            onClick={handleSend}
            disabled={sending}
            className="bg-brand-600 hover:bg-brand-700 text-white px-3 py-1 rounded-md font-medium disabled:opacity-50"
            data-testid="confirm-send"
          >
            {sending ? "Sending..." : "Yes, send it"}
          </button>
          <button onClick={() => setPendingConfirmation(null)} className="text-yellow-700 dark:text-yellow-300 underline">
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors self-start disabled:opacity-50"
          data-testid="compose-send"
        >
          <Send className="w-4 h-4" />
          Send
        </button>
      )}
    </div>
  );
}
