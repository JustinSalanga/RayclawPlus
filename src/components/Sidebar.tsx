import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, FileDown, Trash2 } from "lucide-react";
import { save, confirm } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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

export default function Sidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onOpenSettings,
  onChatDeleted,
}: SidebarProps) {
  const [menuChatId, setMenuChatId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on click outside
  useEffect(() => {
    if (menuChatId === null) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuChatId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuChatId]);

  const toggleMenu = (e: React.MouseEvent, chatId: number) => {
    e.stopPropagation();
    setMenuChatId(menuChatId === chatId ? null : chatId);
  };

  const handleDelete = async (chatId: number) => {
    setMenuChatId(null);
    try {
      const ok = await confirm("Are you sure you want to delete this chat? This action cannot be undone.", {
        title: "Delete Chat",
        kind: "warning",
      });
      if (!ok) return;
      await deleteChat(chatId);
      onChatDeleted();
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }
  };

  const handleExport = async (chatId: number) => {
    setMenuChatId(null);
    try {
      const chat = chats.find((c) => c.chat_id === chatId);
      const defaultName = (chat?.chat_title || `chat-${chatId}`).replace(/[^a-zA-Z0-9_-]/g, "_") + ".md";

      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!filePath) return; // user cancelled

      const md = await exportChatMarkdown(chatId);
      await writeTextFile(filePath, md);
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
          const isMenuOpen = menuChatId === chat.chat_id;
          return (
            <div
              key={chat.chat_id}
              className={`sidebar-item ${chat.chat_id === activeChatId ? "sidebar-item-active" : ""}`}
              onClick={() => onSelectChat(chat.chat_id)}
            >
              <div className="sidebar-item-row">
                <div className="sidebar-item-title">
                  {badge && <span className="channel-badge">{badge}</span>}
                  {chat.chat_title || `Chat ${chat.chat_id}`}
                </div>
                <button
                  className="sidebar-item-more"
                  onClick={(e) => toggleMenu(e, chat.chat_id)}
                  title="More"
                >
                  <MoreHorizontal size={14} />
                </button>
              </div>
              {chat.last_message_preview && (
                <div className="sidebar-item-preview">
                  {chat.last_message_preview.slice(0, 60)}
                </div>
              )}

              {/* Dropdown menu */}
              {isMenuOpen && (
                <div ref={menuRef} className="sidebar-dropdown" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="sidebar-dropdown-item"
                    onClick={() => handleExport(chat.chat_id)}
                  >
                    <FileDown size={14} />
                    Export as Markdown
                  </button>
                  <button
                    className="sidebar-dropdown-item sidebar-dropdown-danger"
                    onClick={() => handleDelete(chat.chat_id)}
                  >
                    <Trash2 size={14} />
                    Delete Chat
                  </button>
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
    </aside>
  );
}
