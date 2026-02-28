import { useState, useEffect, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import ChatWindow from "./components/ChatWindow";
import { getChats, newChat } from "./lib/tauri-api";
import type { ChatSummary } from "./types";
import "./App.css";

function App() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);

  const loadChats = useCallback(async () => {
    const chatList = await getChats();
    setChats(chatList);
  }, []);

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
