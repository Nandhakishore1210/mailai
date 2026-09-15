import { create } from "zustand";
import { AssistantMessage } from "@/lib/types";

interface AssistantStore {
  messages: AssistantMessage[];
  conversationId: string | undefined;
  open: boolean;
  loading: boolean;

  addMessage: (msg: AssistantMessage) => void;
  setConversationId: (id: string) => void;
  setOpen: (open: boolean) => void;
  setLoading: (v: boolean) => void;
  reset: () => void;
}

export const useAssistantStore = create<AssistantStore>((set) => ({
  messages: [],
  conversationId: undefined,
  open: false,
  loading: false,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setConversationId: (id) => set({ conversationId: id }),
  setOpen: (open) => set({ open }),
  setLoading: (v) => set({ loading: v }),
  reset: () => set({ messages: [], conversationId: undefined }),
}));
