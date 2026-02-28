import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import SetupScreen from "./components/SetupScreen";
import SettingsPage from "./components/SettingsPage";
import { getStatus, getChats, newChat } from "./lib/tauri-api";
import type { AppStatus, ChatSummary } from "./types";
import "./App.css";

type View = "chat" | "settings";

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [view, setView] = useState<View>("chat");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);

  const refreshStatus = useCallback(() => {
    getStatus().then(setStatus);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const loadChats = useCallback(async () => {
    if (!status?.ready) return;
    const chatList = await getChats();
    setChats(chatList);
  }, [status?.ready]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const handleNewChat = async () => {
    const chatId = await newChat();
    setActiveChatId(chatId);
    await loadChats();
  };

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
    <div className="app-layout">
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onOpenSettings={() => setView("settings")}
      />
      <ChatWindow
        chatId={activeChatId}
        chatType={chats.find((c) => c.chat_id === activeChatId)?.chat_type}
      />
    </div>
  );
}

export default App;
