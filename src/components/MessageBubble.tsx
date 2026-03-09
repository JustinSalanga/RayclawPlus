import { memo, useState, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Bot, ChevronDown, ChevronUp, FileDown, RotateCcw } from "lucide-react";
import type { StoredMessage } from "../types";

interface MessageBubbleProps {
  message: StoredMessage;
  isSearchMatch?: boolean;
  isCurrentMatch?: boolean;
  onRetry?: (message: StoredMessage) => void;
}

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <div className="code-block-wrapper">
      <button className="code-copy-btn" onClick={handleCopy} title="Copy code">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="code-block">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const BotMessageMarkdown = memo(function BotMessageMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className && !String(children).includes("\n");
          return isInline ? (
            <code className="inline-code" {...props}>{children}</code>
          ) : (
            <CodeBlock className={className}>{children}</CodeBlock>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

const COLLAPSE_LINE_THRESHOLD = 30;

function messageFilename(message: StoredMessage) {
  const sender = (message.is_from_bot ? "assistant" : message.sender_name || "message")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date(message.timestamp)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${sender}-${stamp}.md`;
}

function MessageBubble({ message, isSearchMatch, isCurrentMatch, onRetry }: MessageBubbleProps) {
  const isBot = message.is_from_bot;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const lineCount = message.content.split("\n").length;
  const isLong = isBot && lineCount > COLLAPSE_LINE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(isLong);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const matchClass = isCurrentMatch
    ? "message-search-current"
    : isSearchMatch
      ? "message-search-match"
      : "";

  const handleCopyMessage = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message.content]);

  const handleDownloadMessage = useCallback(async () => {
    try {
      const filePath = await save({
        defaultPath: messageFilename(message),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, message.content);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    } catch (err) {
      console.error("Failed to save message:", err);
    }
  }, [message]);

  return (
    <div
      id={`msg-${message.id}`}
      className={`message-bubble ${isBot ? "message-bot" : "message-user"} ${matchClass}`}
    >
      {isBot && (
        <div className="message-sender">
          <span className="message-sender-avatar"><Bot size={12} /></span>
          RayClaw
        </div>
      )}
      {!isBot && message.sender_name !== "user" && (
        <div className="message-sender message-sender-user">
          {message.sender_name}
        </div>
      )}
      <div className={`message-content ${isLong && collapsed ? "message-content-collapsed" : ""}`}>
        {isBot ? (
          <BotMessageMarkdown content={message.content} />
        ) : (
          <p>{message.content}</p>
        )}
      </div>
      {isLong && (
        <button className="btn-collapse-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? (
            <><ChevronDown size={14} /> Show more</>
          ) : (
            <><ChevronUp size={14} /> Show less</>
          )}
        </button>
      )}
      <div className="message-footer">
        <div className="message-actions">
          <button className="message-action-btn" onClick={handleCopyMessage} title="Copy markdown">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
          {!isBot && onRetry && (
            <button className="message-action-btn" onClick={() => onRetry(message)} title="Retry message">
              <RotateCcw size={13} />
              Retry
            </button>
          )}
          {isBot && (
            <button className="message-action-btn" onClick={handleDownloadMessage} title="Download markdown">
              {downloaded ? <Check size={13} /> : <FileDown size={13} />}
              {downloaded ? "Saved" : "Download"}
            </button>
          )}
        </div>
        <span className="message-time">{time}</span>
      </div>
    </div>
  );
}

const MemoizedMessageBubble = memo(
  MessageBubble,
  (prev, next) =>
    prev.message === next.message &&
    prev.isSearchMatch === next.isSearchMatch &&
    prev.isCurrentMatch === next.isCurrentMatch &&
    prev.onRetry === next.onRetry,
);

BotMessageMarkdown.displayName = "BotMessageMarkdown";
MessageBubble.displayName = "MessageBubble";
MemoizedMessageBubble.displayName = "MemoizedMessageBubble";

export default MemoizedMessageBubble;
