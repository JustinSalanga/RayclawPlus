import { useMemo } from "react";
import MessageBubble, { BotMessageMarkdown } from "../MessageBubble";
import ToolStep from "../ToolStep";
import type { StoredMessage } from "../../types";
import type { ToolStepData } from "./chatTypes";
import type { StreamPhase } from "./chatTypes";
import { Square } from "lucide-react";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${min}m ${s}s` : `${min}m`;
}

export interface ChatTimelineProps {
  messages: StoredMessage[];
  searchMatches: number[];
  currentMatchIdx: number;
  onRetryMessage: (message: StoredMessage) => void;
  toolSteps: ToolStepData[];
  lastStreamResponseMessageId: string | null;
  isStreaming: boolean;
  streamingText: string;
  sendError: string | null;
  streamStatus: { label: string; detail: string | null } | null;
  streamPhase: StreamPhase | null;
  lastResponseDurationMs?: number | null;
  onStop?: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatTimeline({
  messages,
  searchMatches,
  currentMatchIdx,
  onRetryMessage,
  toolSteps,
  lastStreamResponseMessageId,
  isStreaming,
  streamingText,
  sendError,
  streamStatus,
  streamPhase,
  lastResponseDurationMs,
  onStop,
  messagesEndRef,
}: ChatTimelineProps) {
  const { messagesAbove, finalResponseMessage } = useMemo(() => {
    if (!lastStreamResponseMessageId) {
      return {
        messagesAbove: messages,
        finalResponseMessage: null as StoredMessage | null,
      };
    }
    const idx = messages.findIndex((m) => m.id === lastStreamResponseMessageId);
    if (idx < 0) {
      return { messagesAbove: messages, finalResponseMessage: null };
    }
    const finalMsg = messages[idx];
    const above = messages.filter((_, i) => i !== idx);
    return { messagesAbove: above, finalResponseMessage: finalMsg };
  }, [messages, lastStreamResponseMessageId]);

  const renderedMessagesAbove = useMemo(
    () =>
      messagesAbove.map((msg) => {
        const originalIdx = messages.indexOf(msg);
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            isSearchMatch={searchMatches.includes(originalIdx)}
            isCurrentMatch={searchMatches[currentMatchIdx] === originalIdx}
            onRetry={!msg.is_from_bot ? onRetryMessage : undefined}
          />
        );
      }),
    [currentMatchIdx, messages, messagesAbove, onRetryMessage, searchMatches],
  );

  const renderedFinalResponse = finalResponseMessage ? (
    <MessageBubble
      key={finalResponseMessage.id}
      message={finalResponseMessage}
      isSearchMatch={searchMatches.includes(messages.length - 1)}
      isCurrentMatch={searchMatches[currentMatchIdx] === messages.length - 1}
      onRetry={undefined}
    />
  ) : null;

  return (
    <div className="chat-messages">
      {renderedMessagesAbove}

      {toolSteps.length > 0 && (
        <div className="tool-steps-container">
          {toolSteps.map((step, i) => (
            <ToolStep key={`${step.name}-${i}`} {...step} />
          ))}
        </div>
      )}

      {renderedFinalResponse}

      {(streamingText && (isStreaming || lastResponseDurationMs != null)) && (
        <div className="message-bubble message-bot message-streaming">
          <div className="message-content">
            <BotMessageMarkdown content={streamingText} />
          </div>
          {lastResponseDurationMs != null && lastResponseDurationMs > 0 && (
            <div className="message-streaming-total-time">
              Total time: {formatDuration(lastResponseDurationMs)}
            </div>
          )}
        </div>
      )}

      {sendError && (
        <div className="message-bubble message-error">
          <div className="message-content">
            <p>{sendError}</p>
            {/* <button className="btn-retry" onClick={onRetry} type="button">
              Retry
            </button> */}
          </div>
        </div>
      )}

      {streamStatus && (
        <div className={`chat-status-indicator chat-status-${streamPhase ?? ""}`}>
          <div className="chat-status-main">
            <span className="chat-status-spinner" aria-hidden="true" />
            <span>{streamStatus.label}</span>
          </div>
          {streamStatus.detail && (
            <span className="chat-status-detail">{streamStatus.detail}</span>
          )}
          {onStop && (
            <button
              type="button"
              className="message-action-btn chat-status-stop-btn"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square size={10} />
              Stop
            </button>
          )}
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
