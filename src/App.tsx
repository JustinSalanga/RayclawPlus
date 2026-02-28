import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import SetupScreen from "./components/SetupScreen";
import { getStatus, getChats, newChat } from "./lib/tauri-api";
import type { AppStatus, ChatSummary } from "./types";
import "./App.css";

function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);

  useEffect(() => {
    getStatus().then(setStatus);
  }, []);

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

  // Not configured
  if (!status.ready) {
    return <SetupScreen error={status.error} />;
  }

  return (
    <div className="app-layout">
      <Sidebar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
      />
      <ChatWindow chatId={activeChatId} />
    </div>
  );
}

export default App;
