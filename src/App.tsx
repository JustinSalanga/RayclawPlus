import { useEffect, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { CustomTitlebar } from "./components/CustomTitlebar";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import SetupScreen from "./components/SetupScreen";
import SettingsPage from "./components/SettingsPage";
import NotificationCenter from "./components/NotificationCenter";
import { useChatStore } from "./store/chatStore";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import "./App.css";

function App() {
  const {
    status,
    view,
    chats,
    chatsLoaded,
    activeChatId,
    sidebarWidth,
    pinnedChatIds,
    chatSearchOpen,
    refreshStatus,
    loadChats,
    setView,
    setActiveChatId,
    setSidebarWidth,
    togglePin,
    handleNewChat,
    closeChatSearch,
  } = useChatStore(
    useShallow((state) => ({
      status: state.status,
      view: state.view,
      chats: state.chats,
      chatsLoaded: state.chatsLoaded,
      activeChatId: state.activeChatId,
      sidebarWidth: state.sidebarWidth,
      pinnedChatIds: state.pinnedChatIds,
      chatSearchOpen: state.chatSearchOpen,
      refreshStatus: state.refreshStatus,
      loadChats: state.loadChats,
      setView: state.setView,
      setActiveChatId: state.setActiveChatId,
      setSidebarWidth: state.setSidebarWidth,
      togglePin: state.togglePin,
      handleNewChat: state.handleNewChat,
      closeChatSearch: state.closeChatSearch,
    })),
  );

  useGlobalShortcuts();

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Handle tray menu "Settings" action.
  useEffect(() => {
    let unlistenPromise: Promise<UnlistenFn> | null = null;
    if (typeof window !== "undefined") {
      unlistenPromise = listen("tray-open-settings", () => {
        setView("settings");
      });
    }
    return () => {
      unlistenPromise?.then((unlisten) => unlisten());
    };
  }, [setView]);

  useEffect(() => {
    if (status?.ready) {
      loadChats();
    }
  }, [status?.ready, loadChats]);

  // When a system notification is clicked for a specific chat, focus that chat.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId?: number }>).detail;
      if (!detail || typeof detail.chatId !== "number") return;
      setActiveChatId(detail.chatId);
      setView("chat");
    };
    window.addEventListener("rayclaw-open-chat", handler as EventListener);
    return () => {
      window.removeEventListener(
        "rayclaw-open-chat",
        handler as EventListener,
      );
    };
  }, [setActiveChatId, setView]);

  // When the scheduler completes a task, refetch chats so the updated chat moves to the top of the sidebar.
  useEffect(() => {
    let unlistenPromise: Promise<UnlistenFn> | null = null;
    if (typeof window !== "undefined") {
      unlistenPromise = listen<number>("scheduled-task-completed", () => {
        loadChats();
      });
    }
    return () => {
      unlistenPromise?.then((unlisten) => unlisten());
    };
  }, [loadChats]);

  const handleSelectChat = (chatId: number) => {
    setActiveChatId(chatId);
  };

  const handleSettingsSaved = () => {
    refreshStatus();
  };

  const [titlebarChatHeaderContent, setTitlebarChatHeaderContent] =
    useState<ReactNode>(null);

  useEffect(() => {
    if (view !== "chat" && view !== "settings") {
      setTitlebarChatHeaderContent(null);
    }
  }, [view]);

  // When ready and viewing chat with no active chat, open latest chat (after chats have loaded)
  // or start a new one only if there is truly no history.
  useEffect(() => {
    if (!status?.ready) return;
    if (view !== "chat") return;
    if (activeChatId !== null) return;
    if (!chatsLoaded) return; // wait until chats have been fetched at least once

    if (chats.length > 0) {
      // Chats are ordered with most-recent first; open the first entry.
      const latestChat = chats[0];
      if (latestChat?.chat_id != null) {
        setActiveChatId(latestChat.chat_id);
      }
    } else {
      handleNewChat();
    }
  }, [
    status?.ready,
    view,
    activeChatId,
    chats,
    chatsLoaded,
    setActiveChatId,
    handleNewChat,
  ]);

  // Loading
  if (status === null) {
    return (
      <div className="app-with-titlebar">
        <CustomTitlebar chatHeaderContent={null} />
        <div className="app-content">
          <div className="app-layout">
            <div className="setup-screen">
              <p style={{ color: "var(--muted)" }}>Loading...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Not configured — show setup screen (or settings if user clicked Configure)
  if (!status.ready && view !== "settings") {
    return (
      <div className="app-with-titlebar">
        <CustomTitlebar chatHeaderContent={null} />
        <div className="app-content">
          <SetupScreen
            error={status.error}
            onConfigure={() => setView("settings")}
          />
        </div>
      </div>
    );
  }

  // Settings page (accessible from setup screen or sidebar)
  if (view === "settings") {
    return (
      <div className="app-with-titlebar">
        <CustomTitlebar
          chatHeaderContent={titlebarChatHeaderContent}
        />
        <div className="app-content">
          <SettingsPage
            onBack={() => setView("chat")}
            onSaved={handleSettingsSaved}
            setTitlebarChatHeaderContent={setTitlebarChatHeaderContent}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="app-with-titlebar">
        <CustomTitlebar
          chatHeaderContent={titlebarChatHeaderContent}
        />
        <div className="app-content">
          <div className="app-layout">
        <Sidebar
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={handleSelectChat}
          onNewChat={handleNewChat}
          onOpenSettings={() => setView("settings")}
          onChatDeleted={() => {
            setActiveChatId(null);
            void loadChats();
          }}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          pinnedChatIds={pinnedChatIds}
          onTogglePin={togglePin}
        />
        <ChatWindow
          chatId={activeChatId}
          chatTitle={chats.find((c) => c.chat_id === activeChatId)?.chat_title ?? null}
          chatType={chats.find((c) => c.chat_id === activeChatId)?.chat_type}
          onNewChat={handleNewChat}
          onTitleChanged={loadChats}
          searchOpen={chatSearchOpen}
          onSearchClose={closeChatSearch}
          setTitlebarChatHeaderContent={setTitlebarChatHeaderContent}
        />
          </div>
        </div>
      </div>
      <NotificationCenter />
    </>
  );
}

export default App;
