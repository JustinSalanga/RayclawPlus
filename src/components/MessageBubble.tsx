import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Bot } from "lucide-react";
import type { StoredMessage } from "../types";

interface MessageBubbleProps {
  message: StoredMessage;
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

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isBot = message.is_from_bot;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`message-bubble ${isBot ? "message-bot" : "message-user"}`}>
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
      <div className="message-content">
        {isBot ? (
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
            {message.content}
          </ReactMarkdown>
        ) : (
          <p>{message.content}</p>
        )}
      </div>
      <span className="message-time">{time}</span>
    </div>
  );
}
