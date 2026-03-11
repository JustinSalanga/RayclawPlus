import type { StoredMessage } from "../../types";
import type { Attachment } from "../../lib/tauri-api";

export interface ToolStepData {
  name: string;
  isRunning: boolean;
  isError?: boolean;
  preview?: string;
  durationMs?: number;
}

export interface FileAttachment {
  name: string;
  type: string;
  dataUrl: string;
  size?: number;
  /** When set, send this path to backend instead of base64 (e.g. after paste-save). */
  path?: string;
}

export type StreamPhase = "thinking" | "tooling" | "waiting" | "responding" | "finalizing";

export interface QueuedMessage {
  userText: string;
  displayText: string;
  attachmentDtos?: Attachment[];
  attachmentPreviews?: StoredMessage["attachmentPreviews"];
  optimisticMessage: StoredMessage;
}

export interface ChatRuntimeState {
  isStreaming: boolean;
  streamPhase: StreamPhase | null;
  streamingText: string;
  toolSteps: ToolStepData[];
  sendError: string | null;
  queuedMessages: QueuedMessage[];
  /** Timestamp when current stream started (for real-time elapsed). */
  streamStartedAt: number | null;
  /** Total duration in ms when stream finished (for "total time" in result). */
  lastResponseDurationMs: number | null;
  /** When set, this message is rendered below tool steps (final response for current turn). */
  lastStreamResponseMessageId: string | null;
}

export const STREAM_TIMEOUT_MS = 450_000;
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

export function createDefaultChatRuntimeState(): ChatRuntimeState {
  return {
    isStreaming: false,
    streamPhase: null,
    streamingText: "",
    toolSteps: [],
    sendError: null,
    queuedMessages: [],
    streamStartedAt: null,
    lastResponseDurationMs: null,
    lastStreamResponseMessageId: null,
  };
}

const CACHE_KEY_MAX_LEN = 600;
const attachmentPreviewCache = new Map<string, NonNullable<StoredMessage["attachmentPreviews"]>>();

function attachmentPreviewCacheKey(chatId: number, content: string): string {
  const trimmed = content.length > CACHE_KEY_MAX_LEN ? content.slice(0, CACHE_KEY_MAX_LEN) : content;
  return `${chatId}\t${trimmed}`;
}

export function mergeMessagesWithAttachmentPreviews(
  incoming: StoredMessage[],
  existing: StoredMessage[],
): StoredMessage[] {
  const previewsByContent = new Map<string, StoredMessage[]>();
  for (const message of existing) {
    if (message.is_from_bot || !message.attachmentPreviews?.length) continue;
    const key = attachmentPreviewCacheKey(message.chat_id, message.content);
    attachmentPreviewCache.set(key, message.attachmentPreviews);
    const bucket = previewsByContent.get(message.content) ?? [];
    bucket.push(message);
    previewsByContent.set(message.content, bucket);
  }

  const result = incoming.map((message) => {
    if (message.is_from_bot || message.attachmentPreviews?.length) return message;
    const matched = previewsByContent.get(message.content)?.shift();
    if (matched?.attachmentPreviews?.length) {
      return { ...message, attachmentPreviews: matched.attachmentPreviews };
    }
    const cacheKey = attachmentPreviewCacheKey(message.chat_id, message.content);
    const cached = attachmentPreviewCache.get(cacheKey);
    if (cached?.length) {
      return { ...message, attachmentPreviews: cached };
    }
    return message;
  });

  for (const message of result) {
    if (message.is_from_bot || !message.attachmentPreviews?.length) continue;
    const key = attachmentPreviewCacheKey(message.chat_id, message.content);
    attachmentPreviewCache.set(key, message.attachmentPreviews);
  }
  return result;
}
