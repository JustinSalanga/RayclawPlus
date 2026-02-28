import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredMessage } from "../types";

interface MessageBubbleProps {
  message: StoredMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isBot = message.is_from_bot;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`message-bubble ${isBot ? "message-bot" : "message-user"}`}>
      <div className="message-content">
        {isBot ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const isInline = !className;
                return isInline ? (
                  <code className="inline-code" {...props}>{children}</code>
                ) : (
                  <pre className="code-block">
                    <code className={className} {...props}>{children}</code>
                  </pre>
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
