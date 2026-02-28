import type { ChatSummary } from "../types";

interface SidebarProps {
  chats: ChatSummary[];
  activeChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export default function Sidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>RayClaw</h2>
        <button className="btn-new-chat" onClick={onNewChat} title="New Chat">
          +
        </button>
      </div>
      <div className="sidebar-list">
        {chats.map((chat) => (
          <div
            key={chat.chat_id}
            className={`sidebar-item ${chat.chat_id === activeChatId ? "sidebar-item-active" : ""}`}
            onClick={() => onSelectChat(chat.chat_id)}
          >
            <div className="sidebar-item-title">
              {chat.chat_title || `Chat ${chat.chat_id}`}
            </div>
            {chat.last_message_preview && (
              <div className="sidebar-item-preview">
                {chat.last_message_preview.slice(0, 60)}
              </div>
            )}
          </div>
        ))}
        {chats.length === 0 && (
          <div className="sidebar-empty">No chats yet. Start a new one!</div>
        )}
      </div>
      <div className="sidebar-footer">
        <button className="btn-settings" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}
