import { useState, useEffect, useRef, useCallback } from "react";
import MessageBubble from "./MessageBubble";
import ToolStep from "./ToolStep";
import { MessageSquarePlus, Settings } from "lucide-react";
import { sendMessage, getHistory, onAgentStream } from "../lib/tauri-api";
import { inferChannel, channelLabel } from "../types";
import type { StoredMessage, AgentStreamEvent } from "../types";

interface ToolStepData {
  name: string;
  isRunning: boolean;
  isError?: boolean;
  preview?: string;
  durationMs?: number;
}

interface ChatWindowProps {
  chatId: number | null;
  chatTitle: string | null;
  chatType?: string;
  onNewChat?: () => void;
  onOpenSettings?: () => void;
}

const STREAM_TIMEOUT_MS = 90_000; // 90s no event → auto-unlock

export default function ChatWindow({ chatId, chatTitle, chatType, onNewChat, onOpenSettings }: ChatWindowProps) {
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
    if (streamingChatIdRef.current !== chatId) {
      // Switching to a non-streaming chat — clear everything
      setIsStreaming(false);
      setStreamingText("");
      setToolSteps([]);
    }
    // If switching back to the streaming chat, keep streamingText/toolSteps intact
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

      // Only process events for the currently viewed chat
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
  }, [scrollToBottom, resetStreamTimeout, clearStreamTimeout]);

  const handleSend = async () => {
    if (!input.trim() || !chatId || isStreaming) return;

    const userText = input.trim();
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsStreaming(true);
    setStreamingText("");
    setToolSteps([]);
    setSendError(null);
    streamingChatIdRef.current = chatId;
    resetStreamTimeout();

    // Optimistically add user message
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
      // IPC call itself failed — unlock immediately
      clearStreamTimeout();
      setIsStreaming(false);
      streamingChatIdRef.current = null;
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetry = () => {
    setSendError(null);
    // Re-send the last user message
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
    <main className="chat-window">
      <div className="chat-header">
        <span className="chat-header-title">
          {badge && <span className="channel-badge">{badge}</span>}
          {chatTitle || `Chat ${chatId}`}
        </span>
        {isReadOnly && (
          <span className="chat-header-readonly">View only</span>
        )}
      </div>
      <div className="chat-messages">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
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
      )}
    </main>
  );
}
