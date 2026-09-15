import { create } from "zustand";
import { CurrentView, ComposeState, PendingAction } from "@/lib/types";

interface Notification {
  id: string;
  level: "info" | "success" | "error";
  message: string;
}

type Theme = "light" | "dark";

interface UIStore {
  currentView: CurrentView;
  selectedEmailId: string | undefined;
  compose: ComposeState;
  pendingConfirmation: "SEND_EMAIL" | null;
  /** Destructive operation (bin / spam / permanent delete) awaiting approval. */
  pendingAction: PendingAction | null;
  notifications: Notification[];
  theme: Theme;

  navigate: (view: CurrentView) => void;
  openEmail: (id: string) => void;
  setCompose: (patch: Partial<ComposeState>) => void;
  resetCompose: () => void;
  setPendingConfirmation: (op: "SEND_EMAIL" | null) => void;
  setPendingAction: (action: PendingAction | null) => void;
  addNotification: (level: Notification["level"], message: string) => void;
  removeNotification: (id: string) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const defaultCompose: ComposeState = { to: [], subject: "", body: "" };

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* storage unavailable */
  }
}

export const useUIStore = create<UIStore>((set, get) => ({
  currentView: "inbox",
  selectedEmailId: undefined,
  compose: defaultCompose,
  pendingConfirmation: null,
  pendingAction: null,
  notifications: [],
  theme: "light",

  navigate: (view) => set({ currentView: view, selectedEmailId: undefined }),
  openEmail: (id) => set({ currentView: "detail", selectedEmailId: id }),
  setCompose: (patch) => set((s) => ({ compose: { ...s.compose, ...patch } })),
  resetCompose: () => set({ compose: defaultCompose }),
  setPendingConfirmation: (op) => set({ pendingConfirmation: op }),
  setPendingAction: (action) => set({ pendingAction: action }),
  addNotification: (level, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({ notifications: [...s.notifications, { id, level, message }] }));
    setTimeout(() => get().removeNotification(id), 4000);
  },
  removeNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
}));
