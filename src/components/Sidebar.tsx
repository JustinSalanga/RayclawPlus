import { useState, useRef, useEffect } from "react";
import type { ChatSummary } from "../types";
import { channelLabel } from "../types";
import { deleteChat, exportChatMarkdown } from "../lib/tauri-api";

interface SidebarProps {
  chats: ChatSummary[];
  activeChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onChatDeleted: () => void;
}

interface ContextMenu {
  chatId: number;
  x: number;
  y: number;
}

export default function Sidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onOpenSettings,
  onChatDeleted,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, chatId: number) => {
    e.preventDefault();
    setContextMenu({ chatId, x: e.clientX, y: e.clientY });
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const chatId = contextMenu.chatId;
    setContextMenu(null);
    try {
      await deleteChat(chatId);
      onChatDeleted();
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }
  };

  const handleExport = async () => {
    if (!contextMenu) return;
    const chatId = contextMenu.chatId;
    setContextMenu(null);
    try {
      const md = await exportChatMarkdown(chatId);
      // Create a download via a temporary link
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const chat = chats.find((c) => c.chat_id === chatId);
      const name = (chat?.chat_title || `chat-${chatId}`).replace(/[^a-zA-Z0-9_-]/g, "_");
      a.download = `${name}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export chat:", err);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>RayClaw</h2>
        <button className="btn-new-chat" onClick={onNewChat} title="New Chat">
          +
        </button>
      </div>
      <div className="sidebar-list">
        {chats.map((chat) => {
          const badge = channelLabel(chat.chat_type);
          return (
            <div
              key={chat.chat_id}
              className={`sidebar-item ${chat.chat_id === activeChatId ? "sidebar-item-active" : ""}`}
              onClick={() => onSelectChat(chat.chat_id)}
              onContextMenu={(e) => handleContextMenu(e, chat.chat_id)}
            >
              <div className="sidebar-item-title">
                {badge && <span className="channel-badge">{badge}</span>}
                {chat.chat_title || `Chat ${chat.chat_id}`}
              </div>
              {chat.last_message_preview && (
                <div className="sidebar-item-preview">
                  {chat.last_message_preview.slice(0, 60)}
                </div>
              )}
            </div>
          );
        })}
        {chats.length === 0 && (
          <div className="sidebar-empty">No chats yet. Start a new one!</div>
        )}
      </div>
      <div className="sidebar-footer">
        <button className="btn-settings" onClick={onOpenSettings}>
          Settings
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="context-menu-item" onClick={handleExport}>
            Export as Markdown
          </button>
          <button className="context-menu-item context-menu-danger" onClick={handleDelete}>
            Delete Chat
          </button>
        </div>
      )}
    </aside>
  );
}
