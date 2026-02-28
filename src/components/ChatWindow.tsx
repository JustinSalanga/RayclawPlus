import { useState, useEffect, useRef, useCallback } from "react";
import MessageBubble from "./MessageBubble";
import ToolStep from "./ToolStep";
import { sendMessage, getHistory, onAgentStream } from "../lib/tauri-api";
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
}

export default function ChatWindow({ chatId }: ChatWindowProps) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [toolSteps, setToolSteps] = useState<ToolStepData[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Load history when chat changes
  useEffect(() => {
    if (chatId === null) return;
    getHistory(chatId).then((msgs) => {
      setMessages(msgs);
      setTimeout(scrollToBottom, 50);
    });
  }, [chatId, scrollToBottom]);

  // Listen for streaming events
  useEffect(() => {
    const unlistenPromise = onAgentStream((event: AgentStreamEvent) => {
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
        case "final_response":
          setIsStreaming(false);
          setStreamingText("");
          setToolSteps([]);
          // Reload history to get the persisted messages
          if (chatId !== null) {
            getHistory(chatId).then((msgs) => {
              setMessages(msgs);
              setTimeout(scrollToBottom, 50);
            });
          }
          break;
      }
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [chatId, scrollToBottom]);

  const handleSend = async () => {
    if (!input.trim() || !chatId || isStreaming) return;

    const userText = input.trim();
    setInput("");
    setIsStreaming(true);
    setStreamingText("");
    setToolSteps([]);

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

    await sendMessage(chatId, userText);
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
        <div className="chat-empty-message">
          <h2>Welcome to RayClaw</h2>
          <p>Select a chat or start a new one</p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-window">
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

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
    </main>
  );
}
