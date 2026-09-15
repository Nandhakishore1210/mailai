"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";
import { useMailStore } from "@/store/mailStore";
import { useUIStore } from "@/store/uiStore";
import Sidebar from "@/components/mail/Sidebar";
import EmailList from "@/components/mail/EmailList";
import EmailDetailView from "@/components/mail/EmailDetail";
import ComposeForm from "@/components/mail/ComposeForm";
import FilterBar from "@/components/mail/FilterBar";
import AssistantPanel from "@/components/assistant/AssistantPanel";
import Notifications from "@/components/Notifications";
import PendingActionBar from "@/components/PendingActionBar";
import { startRealtime, stopRealtime } from "@/lib/realtime";
import { requestDestructive } from "@/assistant/executeAction";
import { MailBox, isMailBox } from "@/lib/types";
import { MailOpen } from "lucide-react";

const TITLES: Record<MailBox, string> = { inbox: "Inbox", sent: "Sent", spam: "Spam", trash: "Bin" };
const EMPTY: Record<MailBox, string> = {
  inbox: "Your inbox is empty",
  sent: "No sent emails",
  spam: "No spam. Nice.",
  trash: "The bin is empty",
};

export default function InboxPage() {
  const router = useRouter();
  const {
    boxes, selectedEmail, thread, searchResults, loading, detailLoading,
    fetchBox, fetchDetail, prefetchDetail, markRead, restoreEmails, boxOf,
  } = useMailStore();
  const { currentView, lastBox, selectedEmailId, openEmail, navigate, setCompose } = useUIStore();

  useEffect(() => {
    authApi.me().catch(() => router.replace("/login"));
    fetchBox("inbox");
    fetchBox("sent");
    // Realtime: the backend pushes over SSE (IMAP IDLE / Gmail Pub/Sub), so the
    // browser holds one connection and never polls. State is read at event time.
    startRealtime((info) => useMailStore.getState().syncNow(info.inbox));
    return () => stopRealtime();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectEmail = (id: string) => {
    openEmail(id);
    fetchDetail(id);
  };

  const handleReply = () => {
    if (!selectedEmail) return;
    navigate("compose");
    setCompose({
      to: [selectedEmail.sender],
      subject: `Re: ${selectedEmail.subject}`,
      body: "",
      replyToId: selectedEmail.id,
      forwardOfId: undefined,
    });
  };

  const handleForward = () => {
    if (!selectedEmail) return;
    navigate("compose");
    setCompose({
      to: [],
      subject: `Fwd: ${selectedEmail.subject}`,
      body: `\n\n---------- Forwarded message ----------\n${selectedEmail.body_text}`,
      forwardOfId: selectedEmail.id,
      replyToId: undefined,
    });
  };

  // The list shows the mailbox the user is browsing. While a message or the
  // compose form is open the view is not a mailbox, so fall back to the last
  // one they were in. Deriving this from the message instead would jump to
  // Inbox for anything listed in two places, such as mail sent to yourself.
  const listBox: MailBox = isMailBox(currentView) ? currentView : lastBox;
  const visibleEmails = searchResults ?? boxes[listBox];
  const showDetail = currentView === "detail" && selectedEmail;
  const selectedBox = selectedEmail ? boxOf(selectedEmail.id) : null;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      <Sidebar />

      <div className="flex flex-col w-[400px] shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 dark:text-gray-100" data-testid="list-title">
            {searchResults ? `Results (${searchResults.length})` : TITLES[listBox]}
          </h2>
          {searchResults && (
            <button
              className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
              onClick={() => useMailStore.getState().clearSearch()}
            >
              Clear
            </button>
          )}
        </div>
        <FilterBar />
        <EmailList
          emails={visibleEmails}
          selectedId={selectedEmailId}
          onSelect={handleSelectEmail}
          loading={loading && !showDetail}
          emptyMessage={searchResults ? "No emails match these filters" : EMPTY[listBox]}
          onToggleRead={(id, read) => markRead(id, read)}
          onPrefetch={prefetchDetail}
          onTrash={(id) => requestDestructive("trash", [id])}
        />
      </div>

      <main className="flex-1 overflow-hidden flex flex-col bg-gray-50 dark:bg-gray-950">
        <PendingActionBar />
        {showDetail && (
          <EmailDetailView
            email={selectedEmail}
            thread={thread}
            box={selectedBox}
            onReply={handleReply}
            onForward={handleForward}
            onToggleRead={() => markRead(selectedEmail.id, selectedEmail.is_unread)}
            onTrash={() => requestDestructive("trash", [selectedEmail.id])}
            onSpam={() => requestDestructive("spam", [selectedEmail.id])}
            onRestore={() => restoreEmails([selectedEmail.id])}
            onDeleteForever={() => requestDestructive("delete_forever", [selectedEmail.id])}
            loading={detailLoading}
          />
        )}
        {currentView === "compose" && <ComposeForm />}
        {isMailBox(currentView) && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-300 dark:text-gray-700 text-sm gap-2">
            <MailOpen className="w-10 h-10" />
            Select an email to read
          </div>
        )}
      </main>

      <AssistantPanel />
      <Notifications />
    </div>
  );
}
