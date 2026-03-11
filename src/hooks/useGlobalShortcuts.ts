import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "../store/chatStore";
import type { ChatSummary } from "../types";

export function useGlobalShortcuts() {
  const {
    view,
    activeChatId,
    chats,
    chatSearchOpen,
    setView,
    handleNewChat,
    handleExportChat,
    openChatSearch,
    closeChatSearch,
    setActiveChatId,
  } = useChatStore(
    useShallow((state) => ({
      view: state.view,
      activeChatId: state.activeChatId,
      chats: state.chats,
      chatSearchOpen: state.chatSearchOpen,
      setView: state.setView,
      handleNewChat: state.handleNewChat,
      handleExportChat: state.handleExportChat,
      openChatSearch: state.openChatSearch,
      closeChatSearch: state.closeChatSearch,
      setActiveChatId: state.setActiveChatId,
    })),
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+N: new chat
      if (mod && e.key === "n") {
        e.preventDefault();
        void handleNewChat();
        return;
      }

      // Cmd+,: open settings
      if (mod && e.key === ",") {
        e.preventDefault();
        setView("settings");
        return;
      }

      // Cmd+F: search in chat
      if (mod && e.key === "f") {
        e.preventDefault();
        if (activeChatId !== null && view === "chat") {
          openChatSearch();
        }
        return;
      }

      // Cmd+E: export current chat
      if (mod && e.key === "e") {
        e.preventDefault();
        if (activeChatId !== null) {
          void handleExportChat(activeChatId);
        }
        return;
      }

      // Escape: close search / settings
      if (e.key === "Escape") {
        if (chatSearchOpen) {
          closeChatSearch();
          return;
        }
        if (view === "settings") {
          setView("chat");
          return;
        }
      }

      // Up/Down: switch chats when input empty
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && view === "chat") {
        const textarea = document.querySelector(".chat-input") as HTMLTextAreaElement | null;
        const isInputFocused = document.activeElement === textarea;
        const isInputEmpty = !textarea?.value;
        if (isInputFocused && isInputEmpty && chats.length > 0) {
          e.preventDefault();
          const currentIndex = chats.findIndex((c: ChatSummary) => c.chat_id === activeChatId);
          const nextIndex =
            e.key === "ArrowUp"
              ? Math.max(0, currentIndex - 1)
              : Math.min(chats.length - 1, currentIndex + 1);
          if (chats[nextIndex]) {
            setActiveChatId(chats[nextIndex].chat_id);
          }
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    activeChatId,
    chats,
    chatSearchOpen,
    closeChatSearch,
    handleExportChat,
    handleNewChat,
    openChatSearch,
    setActiveChatId,
    setView,
    view,
  ]);
}

