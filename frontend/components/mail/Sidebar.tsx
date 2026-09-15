"use client";
import { Inbox, Send, PenSquare, LogOut, Sun, Moon, ShieldAlert, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { useUIStore } from "@/store/uiStore";
import { useMailStore } from "@/store/mailStore";
import { authApi } from "@/lib/api";
import { useRouter } from "next/navigation";
import { MailBox, isMailBox } from "@/lib/types";

const NAV: { view: MailBox | "compose"; label: string; icon: typeof Inbox }[] = [
  { view: "inbox", label: "Inbox", icon: Inbox },
  { view: "sent", label: "Sent", icon: Send },
  { view: "spam", label: "Spam", icon: ShieldAlert },
  { view: "trash", label: "Bin", icon: Trash2 },
  { view: "compose", label: "Compose", icon: PenSquare },
];

export default function Sidebar() {
  const { currentView, navigate, theme, toggleTheme } = useUIStore();
  const unreadInbox = useMailStore((s) => s.boxes.inbox.filter((e) => e.is_unread).length);
  const router = useRouter();

  const go = (view: MailBox | "compose") => {
    const mail = useMailStore.getState();
    mail.clearSearch();
    navigate(view);
    if (isMailBox(view)) mail.fetchBox(view);
  };

  const handleLogout = async () => {
    await authApi.logout();
    router.replace("/login");
  };

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 h-screen">
      <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800">
        <span className="text-xl font-bold text-brand-600 dark:text-brand-400">MailAI</span>
      </div>
      <nav className="flex-1 py-4 space-y-1 px-2">
        {NAV.map(({ view, label, icon: Icon }) => (
          <button
            key={view}
            onClick={() => go(view)}
            className={clsx(
              "w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors",
              view === "compose" && "mt-3 border border-dashed border-gray-200 dark:border-gray-700",
              currentView === view
                ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-400"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            )}
            data-testid={`nav-${view}`}
          >
            <Icon className="w-4 h-4" />
            <span className="flex-1 text-left">{label}</span>
            {view === "inbox" && unreadInbox > 0 && (
              <span className="text-[10px] font-semibold bg-brand-600 text-white rounded-full px-1.5 py-0.5">
                {unreadInbox}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="p-3 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
          data-testid="theme-toggle"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
