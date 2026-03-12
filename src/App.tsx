import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
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

  const handleSelectChat = (chatId: number) => {
    setActiveChatId(chatId);
  };

  const handleSettingsSaved = () => {
    refreshStatus();
  };

  // Loading
  if (status === null) {
    return (
      <div className="app-layout">
        <div className="setup-screen">
          <p style={{ color: "var(--muted)" }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Not configured — show setup screen (or settings if user clicked Configure)
  if (!status.ready && view !== "settings") {
    return (
      <SetupScreen
        error={status.error}
        onConfigure={() => setView("settings")}
      />
    );
  }

  // Settings page (accessible from setup screen or sidebar)
  if (view === "settings") {
    return (
      <SettingsPage
        onBack={() => setView("chat")}
        onSaved={handleSettingsSaved}
      />
    );
  }

  return (
    <>
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
          onOpenSettings={() => setView("settings")}
          onTitleChanged={loadChats}
          searchOpen={chatSearchOpen}
          onSearchClose={closeChatSearch}
        />
      </div>
      <NotificationCenter />
    </>
  );
}

export default App;
