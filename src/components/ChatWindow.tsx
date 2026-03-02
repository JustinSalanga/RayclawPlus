import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import MessageBubble from "./MessageBubble";
import ToolStep from "./ToolStep";
import { MessageSquarePlus, Settings, X, ChevronUp, ChevronDown } from "lucide-react";
import { sendMessage, getHistory, onAgentStream, renameChat } from "../lib/tauri-api";
import { inferChannel, channelLabel } from "../types";
import type { StoredMessage, AgentStreamEvent } from "../types";

interface ToolStepData {
  name: string;
  isRunning: boolean;
  isError?: boolean;
  preview?: string;
  durationMs?: number;
}

interface FileAttachment {
  name: string;
  type: string;
  dataUrl: string;
  size: number;
}

interface ChatWindowProps {
  chatId: number | null;
  chatTitle: string | null;
  chatType?: string;
  onNewChat?: () => void;
  onOpenSettings?: () => void;
  onTitleChanged?: () => void;
  searchOpen?: boolean;
  onSearchClose?: () => void;
}

const STREAM_TIMEOUT_MS = 90_000; // 90s no event → auto-unlock
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

export default function ChatWindow({
  chatId,
  chatTitle,
  chatType,
  onNewChat,
  onOpenSettings,
  onTitleChanged,
  searchOpen: searchOpenProp,
  onSearchClose,
}: ChatWindowProps) {
  const channel = chatType ? inferChannel(chatType) : "desktop";
  const isReadOnly = channel !== "desktop";
  const badge = chatType ? channelLabel(chatType) : null;
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [toolSteps, setToolSteps] = useState<ToolStepData[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatIdRef = useRef<number | null>(chatId);
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamingChatIdRef = useRef<number | null>(null);

  // Title editing
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Message search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // File attachments
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Sync search open from prop
  useEffect(() => {
    if (searchOpenProp) {
      setSearchOpen(true);
    }
  }, [searchOpenProp]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery("");
      setCurrentMatchIdx(0);
    }
  }, [searchOpen]);

  // Focus title input when editing
  useEffect(() => {
    if (isEditingTitle) titleInputRef.current?.focus();
  }, [isEditingTitle]);

  // Search matches
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .map((m, i) => (m.content.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i !== -1);
  }, [messages, searchQuery]);

  // Scroll to current match
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const msgIdx = searchMatches[currentMatchIdx];
    if (msgIdx === undefined) return;
    const msg = messages[msgIdx];
    if (msg) {
      const el = document.getElementById(`msg-${msg.id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatchIdx, searchMatches, messages]);

  const navigateMatch = (dir: number) => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIdx((prev) => {
      const next = prev + dir;
      if (next < 0) return searchMatches.length - 1;
      if (next >= searchMatches.length) return 0;
      return next;
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    onSearchClose?.();
  };

  // Keep chatIdRef in sync
  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Reset streaming state when switching chats
  useEffect(() => {
    setSendError(null);
    setSearchOpen(false);
    setAttachments([]);
    if (streamingChatIdRef.current !== chatId) {
      setIsStreaming(false);
      setStreamingText("");
      setToolSteps([]);
    }
  }, [chatId]);

  // Load history when chat changes
  useEffect(() => {
    if (chatId === null) return;
    getHistory(chatId).then((msgs) => {
      setMessages(msgs);
      setTimeout(scrollToBottom, 50);
    });
  }, [chatId, scrollToBottom]);

  // Reset stream timeout whenever we get an event
  const resetStreamTimeout = useCallback(() => {
    if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current);
    streamTimeoutRef.current = setTimeout(() => {
      console.warn("Stream timeout — auto-unlocking input");
      setIsStreaming(false);
      setStreamingText("");
      setToolSteps([]);
      setSendError("Response timed out. Please try again.");
      streamingChatIdRef.current = null;
    }, STREAM_TIMEOUT_MS);
  }, []);

  const clearStreamTimeout = useCallback(() => {
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
  }, []);

  // Listen for streaming events — filter by chatId
  useEffect(() => {
    const unlistenPromise = onAgentStream((event: AgentStreamEvent) => {
      const eventChatId = event.chat_id;
      if (eventChatId !== chatIdRef.current) return;

      resetStreamTimeout();

      switch (event.type) {
        case "text_delta":
          setStreamingText((prev) => prev + event.delta);
          scrollToBottom();
          break;
        case "tool_start":
          setToolSteps((prev) => [...prev, { name: event.name, isRunning: true }]);
          scrollToBottom();
          break;
        case "tool_result":
          setToolSteps((prev) =>
            prev.map((s) =>
              s.name === event.name && s.isRunning
                ? { ...s, isRunning: false, isError: event.is_error, preview: event.preview, durationMs: event.duration_ms }
                : s
            )
          );
          break;
        case "error":
          clearStreamTimeout();
          setIsStreaming(false);
          setStreamingText("");
          setToolSteps([]);
          setSendError(event.message);
          streamingChatIdRef.current = null;
          break;
        case "final_response":
          clearStreamTimeout();
          setToolSteps([]);
          streamingChatIdRef.current = null;
          if (chatIdRef.current !== null) {
            const currentChatId = chatIdRef.current;
            setTimeout(() => {
              getHistory(currentChatId).then((msgs) => {
                setMessages(msgs);
                setStreamingText("");
                setIsStreaming(false);
                setTimeout(scrollToBottom, 50);

                // Auto-title: if title is "New Chat", derive from first user message
                if (chatTitle === "New Chat" && msgs.length >= 2) {
                  const firstUserMsg = msgs.find((m) => !m.is_from_bot);
                  if (firstUserMsg) {
                    const autoTitle =
                      firstUserMsg.content.slice(0, 30).trim() +
                      (firstUserMsg.content.length > 30 ? "..." : "");
                    renameChat(currentChatId, autoTitle).then(() => {
                      onTitleChanged?.();
                    }).catch(() => {});
                  }
                }
              }).catch(() => {
                setIsStreaming(false);
              });
            }, 300);
          } else {
            setStreamingText("");
            setIsStreaming(false);
          }
          break;
      }
    });

    return () => {
      unlistenPromise.then((fn) => fn());
      clearStreamTimeout();
    };
  }, [scrollToBottom, resetStreamTimeout, clearStreamTimeout, chatTitle, onTitleChanged]);

  // File processing
  const processFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_ATTACHMENT_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          { name: file.name, type: file.type, dataUrl: reader.result as string, size: file.size },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isReadOnly) setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isReadOnly) return;
    processFiles(Array.from(e.dataTransfer.files));
  };
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((i) => i.type.startsWith("image/"));
    if (imageItems.length > 0) {
      e.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) processFiles([file]);
      }
    }
  };
  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSend = async () => {
    if (!input.trim() || !chatId || isStreaming) return;

    let userText = input.trim();
    // Append attachment notes
    if (attachments.length > 0) {
      const names = attachments.map((a) => `[Attached: ${a.name}]`).join(" ");
      userText = `${userText}\n${names}`;
    }

    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsStreaming(true);
    setStreamingText("");
    setToolSteps([]);
    setSendError(null);
    streamingChatIdRef.current = chatId;
    resetStreamTimeout();

    const userMsg: StoredMessage = {
      id: crypto.randomUUID(),
      chat_id: chatId,
      sender_name: "user",
      content: userText,
      is_from_bot: false,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      await sendMessage(chatId, userText);
    } catch (err) {
      clearStreamTimeout();
      setIsStreaming(false);
      streamingChatIdRef.current = null;
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetry = () => {
    setSendError(null);
    const lastUserMsg = [...messages].reverse().find((m) => !m.is_from_bot);
    if (lastUserMsg) {
      setInput(lastUserMsg.content);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      navigateMatch(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      navigateMatch(1);
    } else if (e.key === "Escape") {
      closeSearch();
    }
  };

  // Double-click to rename title
  const handleTitleDoubleClick = () => {
    if (isReadOnly || !chatId) return;
    setEditTitle(chatTitle || "");
    setIsEditingTitle(true);
  };

  const handleTitleConfirm = async () => {
    if (!chatId || !editTitle.trim()) {
      setIsEditingTitle(false);
      return;
    }
    try {
      await renameChat(chatId, editTitle.trim());
      onTitleChanged?.();
    } catch {
      // ignore
    }
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleConfirm();
    } else if (e.key === "Escape") {
      setIsEditingTitle(false);
    }
  };

  if (chatId === null) {
    return (
      <main className="chat-window chat-window-empty">
        <div className="chat-header" />
        <div className="chat-empty-state">
          <div className="empty-state-icon">RC</div>
          <h2>Welcome to RayClaw</h2>
          <p>Select a chat or start a new conversation</p>
          <div className="empty-state-actions">
            {onNewChat && (
              <button className="empty-state-btn" onClick={onNewChat}>
                <MessageSquarePlus size={16} />
                New Chat
              </button>
            )}
            {onOpenSettings && (
              <button className="empty-state-btn empty-state-btn-secondary" onClick={onOpenSettings}>
                <Settings size={16} />
                Settings
              </button>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`chat-window ${dragOver ? "chat-window-drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="chat-header">
        {isEditingTitle ? (
          <input
            ref={titleInputRef}
            className="chat-header-title-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleTitleConfirm}
            onKeyDown={handleTitleKeyDown}
          />
        ) : (
          <span className="chat-header-title" onDoubleClick={handleTitleDoubleClick}>
            {badge && <span className="channel-badge">{badge}</span>}
            {chatTitle || `Chat ${chatId}`}
          </span>
        )}
        {isReadOnly && (
          <span className="chat-header-readonly">View only</span>
        )}
      </div>

      {/* Message search bar */}
      {searchOpen && (
        <div className="chat-search-bar">
          <input
            ref={searchInputRef}
            className="chat-search-input"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatchIdx(0); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search messages..."
          />
          <span className="chat-search-count">
            {searchMatches.length > 0
              ? `${currentMatchIdx + 1}/${searchMatches.length}`
              : searchQuery ? "0 results" : ""}
          </span>
          <button className="chat-search-nav" onClick={() => navigateMatch(-1)} title="Previous">
            <ChevronUp size={14} />
          </button>
          <button className="chat-search-nav" onClick={() => navigateMatch(1)} title="Next">
            <ChevronDown size={14} />
          </button>
          <button className="chat-search-close" onClick={closeSearch}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="chat-messages">
        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isSearchMatch={searchMatches.includes(idx)}
            isCurrentMatch={searchMatches[currentMatchIdx] === idx}
          />
        ))}

        {/* Tool steps during streaming */}
        {toolSteps.length > 0 && (
          <div className="tool-steps-container">
            {toolSteps.map((step, i) => (
              <ToolStep key={`${step.name}-${i}`} {...step} />
            ))}
          </div>
        )}

        {/* Streaming text */}
        {isStreaming && streamingText && (
          <div className="message-bubble message-bot message-streaming">
            <div className="message-content">
              <p>{streamingText}</p>
            </div>
          </div>
        )}

        {/* Typing indicator */}
        {isStreaming && !streamingText && toolSteps.length === 0 && (
          <div className="message-bubble message-bot">
            <div className="message-content typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}

        {/* Error bubble */}
        {sendError && (
          <div className="message-bubble message-error">
            <div className="message-content">
              <p>{sendError}</p>
              <button className="btn-retry" onClick={handleRetry}>Retry</button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {!isReadOnly && (
        <>
          {/* Attachment preview */}
          {attachments.length > 0 && (
            <div className="attachment-preview-bar">
              {attachments.map((att, i) => (
                <div key={i} className="attachment-preview">
                  <img src={att.dataUrl} alt={att.name} className="attachment-thumb" />
                  <span className="attachment-name">{att.name}</span>
                  <button className="attachment-remove" onClick={() => removeAttachment(i)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-area">
            <textarea
              ref={textareaRef}
              className="chat-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 160) + "px";
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type a message..."
              rows={1}
              disabled={isStreaming}
            />
            <button
              className="btn-send"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
            >
              Send
            </button>
          </div>
        </>
      )}
    </main>
  );
}
