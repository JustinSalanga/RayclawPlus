import { useState, useEffect, useRef, useCallback } from "react";
import { sendMessage, onAgentStream } from "../../lib/tauri-api";
import type { Attachment } from "../../lib/tauri-api";
import type { StoredMessage, AgentStreamEvent } from "../../types";
import { createDefaultChatRuntimeState, STREAM_TIMEOUT_MS, type ChatRuntimeState, type QueuedMessage } from "./chatTypes";

export interface UseChatStreamingArgs {
  chatId: number | null;
  chatTitle: string | null;
  setMessages: React.Dispatch<React.SetStateAction<StoredMessage[]>>;
  scrollToBottom: () => void;
  onTitleChanged?: () => void;
}

export function useChatStreaming({
  chatId,
  chatTitle,
  setMessages,
  scrollToBottom,
  onTitleChanged,
}: UseChatStreamingArgs) {
  const [chatRuntimeStates, setChatRuntimeStates] = useState<Record<number, ChatRuntimeState>>({});
  const chatIdRef = useRef<number | null>(chatId);
  const streamTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  const activeRuntimeState =
    chatId !== null
      ? (chatRuntimeStates[chatId] ?? createDefaultChatRuntimeState())
      : createDefaultChatRuntimeState();

  const updateChatRuntimeState = useCallback(
    (targetChatId: number, updater: (state: ChatRuntimeState) => ChatRuntimeState) => {
      setChatRuntimeStates((prev) => {
        const current = prev[targetChatId] ?? createDefaultChatRuntimeState();
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [targetChatId]: next };
      });
    },
    [],
  );

  const resetStreamTimeout = useCallback(
    (targetChatId: number) => {
      const existing = streamTimeoutsRef.current.get(targetChatId);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => {
        console.warn(`Stream timeout for chat ${targetChatId}; auto-unlocking input`);
        updateChatRuntimeState(targetChatId, (state) => ({
          ...state,
          isStreaming: false,
          streamPhase: null,
          streamingText: "",
          toolSteps: [],
          sendError: "Response timed out. Please try again.",
          streamStartedAt: null,
          lastResponseDurationMs: null,
        }));
        streamTimeoutsRef.current.delete(targetChatId);
      }, STREAM_TIMEOUT_MS);
      streamTimeoutsRef.current.set(targetChatId, timeout);
    },
    [updateChatRuntimeState],
  );

  const clearStreamTimeout = useCallback((targetChatId: number) => {
    const existing = streamTimeoutsRef.current.get(targetChatId);
    if (existing) {
      clearTimeout(existing);
      streamTimeoutsRef.current.delete(targetChatId);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const timeout of streamTimeoutsRef.current.values()) clearTimeout(timeout);
      streamTimeoutsRef.current.clear();
    };
  }, []);

  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;

  const appendMessageToTimeline = useCallback(
    (message: StoredMessage) => {
      setMessages((prev) => [...prev, message]);
      setTimeout(scrollToBottomRef.current, 50);
    },
    [setMessages],
  );

  useEffect(() => {
    const unlistenPromise = onAgentStream((event: AgentStreamEvent) => {
      const eventChatId = event.chat_id;
      resetStreamTimeout(eventChatId);

      switch (event.type) {
        case "text_delta":
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: true,
            streamPhase: "responding",
            streamingText: state.streamingText + event.delta,
            streamStartedAt: state.streamStartedAt ?? Date.now(),
          }));
          if (eventChatId === chatIdRef.current) scrollToBottomRef.current();
          break;
        case "tool_start":
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: true,
            streamPhase: "tooling",
            toolSteps: [...state.toolSteps, { name: event.name, isRunning: true }],
            streamStartedAt: state.streamStartedAt ?? Date.now(),
          }));
          if (eventChatId === chatIdRef.current) scrollToBottomRef.current();
          break;
        case "tool_result":
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: true,
            streamPhase: "waiting",
            toolSteps: state.toolSteps.map((s) =>
              s.name === event.name && s.isRunning
                ? { ...s, isRunning: false, isError: event.is_error, preview: event.preview, durationMs: event.duration_ms }
                : s
            ),
            streamStartedAt: state.streamStartedAt ?? Date.now(),
          }));
          if (eventChatId === chatIdRef.current) scrollToBottomRef.current();
          break;
        case "error":
          clearStreamTimeout(eventChatId);
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: false,
            streamPhase: null,
            streamingText: "",
            toolSteps: [],
            sendError: event.message,
            streamStartedAt: null,
            lastResponseDurationMs: null,
          }));
          break;
        case "final_response": {
          // Final response: turn the completion into a proper message bubble (rendered below tool steps).
          clearStreamTimeout(eventChatId);
          const content = (event.text ?? "").trim();
          let lastStreamResponseMessageId: string | null = null;
          if (content) {
            const botMessage: StoredMessage = {
              id: crypto.randomUUID(),
              chat_id: eventChatId,
              sender_name: "assistant",
              content,
              is_from_bot: true,
              timestamp: new Date().toISOString(),
            };
            lastStreamResponseMessageId = botMessage.id;
            appendMessageToTimeline(botMessage);
          }
          updateChatRuntimeState(eventChatId, (state) => {
            const started = state.streamStartedAt ?? Date.now();
            return {
              ...state,
              isStreaming: false,
              streamPhase: null,
              streamingText: "",
              sendError: null,
              streamStartedAt: null,
              lastResponseDurationMs: Math.max(0, Date.now() - started),
              toolSteps: state.toolSteps,
              lastStreamResponseMessageId,
            };
          });
          break;
        }
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [appendMessageToTimeline, chatTitle, clearStreamTimeout, onTitleChanged, resetStreamTimeout, setMessages, updateChatRuntimeState]);

  const createOptimisticUserMessage = useCallback(
    (
      chatIdValue: number,
      content: string,
      attachmentPreviews?: StoredMessage["attachmentPreviews"],
    ): StoredMessage => ({
      id: crypto.randomUUID(),
      chat_id: chatIdValue,
      sender_name: "user",
      content,
      is_from_bot: false,
      timestamp: new Date().toISOString(),
      attachmentPreviews,
    }),
    [],
  );

  const enqueueMessage = useCallback(
    (targetChatId: number, message: QueuedMessage, resetComposer: () => void) => {
      updateChatRuntimeState(targetChatId, (state) => ({
        ...state,
        sendError: null,
        queuedMessages: [...state.queuedMessages, message],
      }));
      resetComposer();
    },
    [updateChatRuntimeState],
  );

  const dispatchMessage = useCallback(
    async (
      targetChatId: number,
      message: QueuedMessage,
      addOptimistic: boolean,
      resetComposer: () => void,
    ) => {
      if (
        !message.userText.trim() &&
        (!message.attachmentDtos || message.attachmentDtos.length === 0)
      )
        return;
      const runtimeState = chatRuntimeStates[targetChatId] ?? createDefaultChatRuntimeState();
      if (runtimeState.isStreaming) return;

      if (addOptimistic && targetChatId === chatIdRef.current) {
        appendMessageToTimeline(message.optimisticMessage);
      }
      resetComposer();
      updateChatRuntimeState(targetChatId, (state) => ({
        ...state,
        isStreaming: true,
        streamPhase: "thinking",
        streamingText: "",
        toolSteps: [],
        sendError: null,
        streamStartedAt: Date.now(),
        lastResponseDurationMs: null,
        lastStreamResponseMessageId: null,
      }));
      resetStreamTimeout(targetChatId);

      try {
        await sendMessage(
          targetChatId,
          message.userText,
          message.attachmentDtos && message.attachmentDtos.length > 0 ? message.attachmentDtos : undefined,
        );
      } catch (err) {
        clearStreamTimeout(targetChatId);
        updateChatRuntimeState(targetChatId, (state) => ({
          ...state,
          isStreaming: false,
          streamPhase: null,
          sendError: err instanceof Error ? err.message : String(err),
          streamStartedAt: null,
          lastResponseDurationMs: null,
        }));
      }
    },
    [
      appendMessageToTimeline,
      chatRuntimeStates,
      clearStreamTimeout,
      resetStreamTimeout,
      updateChatRuntimeState,
    ],
  );

  useEffect(() => {
    for (const [chatIdKey, runtimeState] of Object.entries(chatRuntimeStates)) {
      if (runtimeState.isStreaming || runtimeState.queuedMessages.length === 0) continue;
      const nextMessage = runtimeState.queuedMessages[0];
      if (!nextMessage) continue;
      updateChatRuntimeState(Number(chatIdKey), (state) => ({
        ...state,
        queuedMessages: state.queuedMessages.slice(1),
      }));
      void dispatchMessage(Number(chatIdKey), nextMessage, true, () => {});
      return;
    }
  }, [chatRuntimeStates, dispatchMessage, updateChatRuntimeState]);

  const handleRetryMessage = useCallback(
    async (
      message: StoredMessage,
      isReadOnly: boolean,
      resetComposer: () => void,
    ) => {
      if (isReadOnly) return;
      const trimmed = (message.content ?? "").trim();
      if (!trimmed) return;
      const isImagePlaceholder = trimmed === "[image]" || trimmed.startsWith("[image] ");
      const attachmentPreviews = message.attachmentPreviews;

      let userText: string;
      let displayText: string;
      let attachmentDtos: Attachment[] | undefined;
      let optimisticMessage: StoredMessage;

      if (isImagePlaceholder && attachmentPreviews?.length) {
        userText = trimmed.replace(/^\s*\[image\]\s*/, "").trim();
        displayText = trimmed;
        attachmentDtos = attachmentPreviews
          .filter((p) => p.type?.startsWith("image/"))
          .map((p) => ({
            data: (p.dataUrl ?? "").split(",")[1] ?? "",
            media_type: p.type ?? "image/png",
            name: p.name ?? "image",
          }))
          .filter((a) => a.data);
        if (attachmentDtos.length === 0) {
          updateChatRuntimeState(message.chat_id, (state) => ({
            ...state,
            sendError: "Image data not available for retry.",
          }));
          return;
        }
        optimisticMessage = createOptimisticUserMessage(message.chat_id, displayText, attachmentPreviews);
      } else if (isImagePlaceholder && !attachmentPreviews?.length) {
        updateChatRuntimeState(message.chat_id, (state) => ({
          ...state,
          sendError: "Image data not available for retry.",
        }));
        return;
      } else {
        userText = trimmed;
        displayText = trimmed;
        optimisticMessage = createOptimisticUserMessage(message.chat_id, displayText);
      }

      updateChatRuntimeState(message.chat_id, (state) => ({ ...state, sendError: null }));
      const outgoing: QueuedMessage = {
        userText,
        displayText,
        ...(attachmentDtos && attachmentDtos.length > 0 && { attachmentDtos }),
        ...(attachmentPreviews?.length && { attachmentPreviews }),
        optimisticMessage,
      };
      const runtimeState = chatRuntimeStates[message.chat_id] ?? createDefaultChatRuntimeState();
      if (runtimeState.isStreaming) {
        enqueueMessage(message.chat_id, outgoing, resetComposer);
        return;
      }
      await dispatchMessage(message.chat_id, outgoing, true, resetComposer);
    },
    [
      chatRuntimeStates,
      createOptimisticUserMessage,
      dispatchMessage,
      enqueueMessage,
      updateChatRuntimeState,
    ],
  );

  return {
    chatRuntimeStates,
    activeRuntimeState,
    updateChatRuntimeState,
    createOptimisticUserMessage,
    appendMessageToTimeline,
    enqueueMessage,
    dispatchMessage,
    handleRetryMessage,
  };
}
