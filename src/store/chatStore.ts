import { create } from "zustand";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getStatus, getChats, newChat, exportChatMarkdown } from "../lib/tauri-api";
import type { AppStatus, ChatSummary } from "../types";

type View = "chat" | "settings";

interface ChatStoreState {
  status: AppStatus | null;
  view: View;
  chats: ChatSummary[];
  /** Whether chats have been loaded at least once this session. */
  chatsLoaded: boolean;
  activeChatId: number | null;
  sidebarWidth: number;
  pinnedChatIds: Set<number>;
  chatSearchOpen: boolean;

  refreshStatus: () => Promise<void>;
  loadChats: () => Promise<void>;
  setView: (view: View) => void;
  setActiveChatId: (chatId: number | null) => void;
  setSidebarWidth: (width: number) => void;
  togglePin: (chatId: number) => void;
  openChatSearch: () => void;
  closeChatSearch: () => void;
  handleNewChat: () => Promise<void>;
  handleExportChat: (chatId: number) => Promise<void>;
}

function loadPinnedIds(): Set<number> {
  try {
    const raw = localStorage.getItem("rayclaw-pinned-chats");
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  status: null,
  view: "chat",
  chats: [],
  chatsLoaded: false,
  activeChatId: null,
  sidebarWidth: (() => {
    const saved = localStorage.getItem("rayclaw-sidebar-width");
    return saved ? Number(saved) : 280;
  })(),
  pinnedChatIds: loadPinnedIds(),
  chatSearchOpen: false,

  refreshStatus: async () => {
    const status = await getStatus();
    set({ status });
  },

  loadChats: async () => {
    const { status } = get();
    if (!status?.ready) return;
    const chats = await getChats();
    set({ chats, chatsLoaded: true });
  },

  setView: (view: View) => set({ view }),

  setActiveChatId: (activeChatId: number | null) => set({ activeChatId }),

  setSidebarWidth: (sidebarWidth: number) => {
    set({ sidebarWidth });
    localStorage.setItem("rayclaw-sidebar-width", String(sidebarWidth));
  },

  togglePin: (chatId: number) => {
    set((state: ChatStoreState) => {
      const next = new Set(state.pinnedChatIds);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      localStorage.setItem("rayclaw-pinned-chats", JSON.stringify([...next]));
      return { pinnedChatIds: next };
    });
  },

  openChatSearch: () => set({ chatSearchOpen: true }),

  closeChatSearch: () => set({ chatSearchOpen: false }),

  handleNewChat: async () => {
    const chatId = await newChat();
    const { loadChats } = get();
    set({ activeChatId: chatId, view: "chat" });
    await loadChats();
  },

  handleExportChat: async (chatId: number) => {
    const { chats } = get();
    try {
      const chat = chats.find((c) => c.chat_id === chatId);
      const defaultName =
        (chat?.chat_title || `chat-${chatId}`).replace(/[^a-zA-Z0-9_-]/g, "_") + ".md";
      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!filePath) return;
      const md = await exportChatMarkdown(chatId);
      await writeTextFile(filePath, md);
    } catch (err) {
      console.error("Failed to export chat:", err);
    }
  },
}));

