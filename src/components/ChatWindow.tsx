import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import MessageBubble, { BotMessageMarkdown } from "./MessageBubble";
import ToolStep from "./ToolStep";
import { MessageSquarePlus, Settings, X, ChevronUp, ChevronDown, Paperclip, Sparkles, Maximize2 } from "lucide-react";
import { sendMessage, getHistory, onAgentStream, renameChat, readSoul, saveSoul, type Attachment } from "../lib/tauri-api";
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

type StreamPhase = "thinking" | "tooling" | "waiting" | "responding" | "finalizing";

interface QueuedMessage {
  userText: string;
  displayText: string;
  attachmentDtos?: Attachment[];
  attachmentPreviews?: StoredMessage["attachmentPreviews"];
  optimisticMessage: StoredMessage;
}

interface ChatRuntimeState {
  isStreaming: boolean;
  streamPhase: StreamPhase | null;
  streamingText: string;
  toolSteps: ToolStepData[];
  sendError: string | null;
  queuedMessages: QueuedMessage[];
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

function createDefaultChatRuntimeState(): ChatRuntimeState {
  return {
    isStreaming: false,
    streamPhase: null,
    streamingText: "",
    toolSteps: [],
    sendError: null,
    queuedMessages: [],
  };
}

function mergeMessagesWithAttachmentPreviews(
  incoming: StoredMessage[],
  existing: StoredMessage[],
): StoredMessage[] {
  const previewsByContent = new Map<string, StoredMessage[]>();

  for (const message of existing) {
    if (message.is_from_bot || !message.attachmentPreviews?.length) {
      continue;
    }

    const bucket = previewsByContent.get(message.content) ?? [];
    bucket.push(message);
    previewsByContent.set(message.content, bucket);
  }

  return incoming.map((message) => {
    if (message.is_from_bot || message.attachmentPreviews?.length) {
      return message;
    }

    const matched = previewsByContent.get(message.content)?.shift();
    if (!matched?.attachmentPreviews?.length) {
      return message;
    }

    return {
      ...message,
      attachmentPreviews: matched.attachmentPreviews,
    };
  });
}

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
  const [chatRuntimeStates, setChatRuntimeStates] = useState<Record<number, ChatRuntimeState>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatIdRef = useRef<number | null>(chatId);
  const streamTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const [isInputModalOpen, setIsInputModalOpen] = useState(false);

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Per-chat soul editor
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulContent, setSoulContent] = useState("");
  const [soulOriginal, setSoulOriginal] = useState("");
  const [soulSaving, setSoulSaving] = useState(false);

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

  useEffect(() => {
    if (!isInputModalOpen) return;

    const timeout = setTimeout(() => {
      modalTextareaRef.current?.focus();
      const valueLength = modalTextareaRef.current?.value.length ?? 0;
      modalTextareaRef.current?.setSelectionRange(valueLength, valueLength);
    }, 30);

    return () => clearTimeout(timeout);
  }, [isInputModalOpen]);

  // Search matches
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .map((m, i) => (m.content.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i !== -1);
  }, [messages, searchQuery]);

  const activeRuntimeState = chatId !== null
    ? (chatRuntimeStates[chatId] ?? createDefaultChatRuntimeState())
    : createDefaultChatRuntimeState();
  const {
    isStreaming,
    streamPhase,
    streamingText,
    toolSteps,
    sendError,
    queuedMessages,
  } = activeRuntimeState;
  const queuedCount = queuedMessages.length;
  const runningToolCount = toolSteps.filter((step) => step.isRunning).length;
  const completedToolCount = toolSteps.length - runningToolCount;

  const updateChatRuntimeState = useCallback((
    targetChatId: number,
    updater: (state: ChatRuntimeState) => ChatRuntimeState,
  ) => {
    setChatRuntimeStates((prev) => {
      const current = prev[targetChatId] ?? createDefaultChatRuntimeState();
      const next = updater(current);
      if (next === current) {
        return prev;
      }
      return {
        ...prev,
        [targetChatId]: next,
      };
    });
  }, []);

  const streamStatus = useMemo(() => {
    if (!isStreaming || !streamPhase) return null;

    let label = "VirusClaw is working...";

    switch (streamPhase) {
      case "thinking":
        label = "VirusClaw is thinking...";
        break;
      case "tooling":
        label = runningToolCount > 0
          ? `Running ${runningToolCount} tool${runningToolCount === 1 ? "" : "s"}...`
          : "Running tools...";
        break;
      case "waiting":
        label = completedToolCount > 0
          ? "Tool work finished. Waiting for the response..."
          : "Waiting for the response...";
        break;
      case "responding":
        label = "Writing the response...";
        break;
      case "finalizing":
        label = "Finishing the response...";
        break;
    }

    const parts: string[] = [];
    if (toolSteps.length > 0) {
      parts.push(`${completedToolCount} done${runningToolCount > 0 ? `, ${runningToolCount} running` : ""}`);
    }
    if (queuedCount > 0) {
      parts.push(`${queuedCount} queued`);
    }
    const detail = parts.length > 0 ? parts.join(" · ") : null;

    return { label, detail };
  }, [completedToolCount, isStreaming, queuedCount, runningToolCount, streamPhase, toolSteps.length]);

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

  // Reset view-local UI when switching chats
  useEffect(() => {
    setSearchOpen(false);
    setAttachments([]);
    setSoulOpen(false);
  }, [chatId]);

  // Load history when chat changes
  useEffect(() => {
    if (chatId === null) {
      setMessages([]);
      return;
    }
    getHistory(chatId).then((msgs) => {
      setMessages((prev) => mergeMessagesWithAttachmentPreviews(msgs, prev));
      setTimeout(scrollToBottom, 50);
    }).catch(() => {
      setMessages([]);
    });
  }, [chatId, scrollToBottom]);

  // Reset stream timeout whenever we get an event
  const resetStreamTimeout = useCallback((targetChatId: number) => {
    const existingTimeout = streamTimeoutsRef.current.get(targetChatId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    const timeout = setTimeout(() => {
      console.warn(`Stream timeout for chat ${targetChatId}; auto-unlocking input`);
      updateChatRuntimeState(targetChatId, (state) => ({
        ...state,
        isStreaming: false,
        streamPhase: null,
        streamingText: "",
        toolSteps: [],
        sendError: "Response timed out. Please try again.",
      }));
      streamTimeoutsRef.current.delete(targetChatId);
    }, STREAM_TIMEOUT_MS);

    streamTimeoutsRef.current.set(targetChatId, timeout);
  }, [updateChatRuntimeState]);

  const clearStreamTimeout = useCallback((targetChatId: number) => {
    const existingTimeout = streamTimeoutsRef.current.get(targetChatId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      streamTimeoutsRef.current.delete(targetChatId);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const timeout of streamTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      streamTimeoutsRef.current.clear();
    };
  }, []);

  // Listen for streaming events and route them into per-chat runtime state
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
          }));
          if (eventChatId === chatIdRef.current) scrollToBottom();
          break;
        case "tool_start":
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: true,
            streamPhase: "tooling",
            toolSteps: [...state.toolSteps, { name: event.name, isRunning: true }],
          }));
          if (eventChatId === chatIdRef.current) scrollToBottom();
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
          }));
          if (eventChatId === chatIdRef.current) scrollToBottom();
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
          }));
          break;
        case "final_response":
          clearStreamTimeout(eventChatId);
          updateChatRuntimeState(eventChatId, (state) => ({
            ...state,
            isStreaming: false,
            streamPhase: "finalizing",
            streamingText: "",
            toolSteps: [],
            sendError: null,
          }));
          setTimeout(() => {
            getHistory(eventChatId).then((msgs) => {
              if (eventChatId === chatIdRef.current) {
                setMessages((prev) => mergeMessagesWithAttachmentPreviews(msgs, prev));
                setTimeout(scrollToBottom, 50);
              }

              updateChatRuntimeState(eventChatId, (state) => ({
                ...state,
                isStreaming: false,
                streamPhase: null,
                streamingText: "",
                toolSteps: [],
                sendError: null,
              }));

              if (chatTitle === "New Chat" && eventChatId === chatIdRef.current && msgs.length >= 2) {
                const firstUserMsg = msgs.find((m) => !m.is_from_bot);
                if (firstUserMsg) {
                  const autoTitle =
                    firstUserMsg.content.slice(0, 30).trim() +
                    (firstUserMsg.content.length > 30 ? "..." : "");
                  renameChat(eventChatId, autoTitle).then(() => {
                    onTitleChanged?.();
                  }).catch(() => {});
                }
              }
            }).catch(() => {
              updateChatRuntimeState(eventChatId, (state) => ({
                ...state,
                isStreaming: false,
                streamPhase: null,
              }));
            });
          }, 300);
          if (eventChatId === chatIdRef.current) scrollToBottom();
          break;
      }
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [chatTitle, clearStreamTimeout, onTitleChanged, resetStreamTimeout, scrollToBottom, updateChatRuntimeState]);

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

  const resizeComposerTextarea = useCallback((element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = Math.min(element.scrollHeight, 160) + "px";
  }, []);

  const resetComposer = useCallback(() => {
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (modalTextareaRef.current) modalTextareaRef.current.style.height = "auto";
  }, []);

  const createOptimisticUserMessage = useCallback((
    chatIdValue: number,
    content: string,
    attachmentPreviews?: StoredMessage["attachmentPreviews"],
  ): StoredMessage => {
    return {
      id: crypto.randomUUID(),
      chat_id: chatIdValue,
      sender_name: "user",
      content,
      is_from_bot: false,
      timestamp: new Date().toISOString(),
      attachmentPreviews,
    };
  }, []);

  const appendMessageToTimeline = useCallback((message: StoredMessage) => {
    setMessages((prev) => [...prev, message]);
    setTimeout(scrollToBottom, 50);
  }, [scrollToBottom]);

  const enqueueMessage = useCallback((targetChatId: number, message: QueuedMessage) => {
    updateChatRuntimeState(targetChatId, (state) => ({
      ...state,
      sendError: null,
      queuedMessages: [...state.queuedMessages, message],
    }));
    resetComposer();
  }, [resetComposer, updateChatRuntimeState]);

  const dispatchMessage = useCallback(async (
    targetChatId: number,
    message: QueuedMessage,
    addOptimistic: boolean,
  ) => {
    if ((!message.userText.trim() && (!message.attachmentDtos || message.attachmentDtos.length === 0))) {
      return;
    }

    const runtimeState = chatRuntimeStates[targetChatId] ?? createDefaultChatRuntimeState();
    if (runtimeState.isStreaming) {
      return;
    }

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
      }));
    }
  }, [appendMessageToTimeline, chatRuntimeStates, clearStreamTimeout, resetComposer, resetStreamTimeout, updateChatRuntimeState]);

  useEffect(() => {
    for (const [chatIdKey, runtimeState] of Object.entries(chatRuntimeStates)) {
      if (runtimeState.isStreaming || runtimeState.queuedMessages.length === 0) {
        continue;
      }

      const nextMessage = runtimeState.queuedMessages[0];
      if (!nextMessage) {
        continue;
      }

      updateChatRuntimeState(Number(chatIdKey), (state) => ({
        ...state,
        queuedMessages: state.queuedMessages.slice(1),
      }));
      void dispatchMessage(Number(chatIdKey), nextMessage, true);
      return;
    }
  }, [chatRuntimeStates, dispatchMessage, updateChatRuntimeState]);

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || !chatId) return;

    const userText = input.trim();
    const currentAttachments = [...attachments];
    const attachmentDtos = currentAttachments
      .filter((a) => a.type.startsWith("image/"))
      .map((a) => {
        const base64 = a.dataUrl.split(",")[1] || "";
        return { data: base64, media_type: a.type, name: a.name };
      });
    const attachmentPreviews = currentAttachments.map(({ name, type, dataUrl }) => ({
      name,
      type,
      dataUrl,
    }));
    const displayText = attachmentDtos.length > 0 && userText
      ? `[image] ${userText}`
      : attachmentDtos.length > 0
        ? "[image]"
        : userText;

    const outgoing: QueuedMessage = {
      userText,
      attachmentDtos,
      attachmentPreviews,
      displayText,
      optimisticMessage: createOptimisticUserMessage(chatId, displayText, attachmentPreviews),
    };

    if (isStreaming) {
      setIsInputModalOpen(false);
      enqueueMessage(chatId, outgoing);
      return;
    }

    setIsInputModalOpen(false);
    await dispatchMessage(chatId, outgoing, true);
  };

  const handleRetry = () => {
    if (chatId !== null) {
      updateChatRuntimeState(chatId, (state) => ({
        ...state,
        sendError: null,
      }));
    }
    const lastUserMsg = [...messages].reverse().find((m) => !m.is_from_bot);
    if (lastUserMsg) {
      setInput(lastUserMsg.content);
    }
  };

  const handleRetryMessage = useCallback(async (message: StoredMessage) => {
    if (isReadOnly) return;

    const trimmed = message.content.trim();
    if (!trimmed) return;

    if (trimmed === "[image]" || trimmed.startsWith("[image] ")) {
      updateChatRuntimeState(message.chat_id, (state) => ({
        ...state,
        sendError: "Retry for image messages is not supported yet.",
      }));
      return;
    }

    updateChatRuntimeState(message.chat_id, (state) => ({
      ...state,
      sendError: null,
    }));
    const outgoing: QueuedMessage = {
      userText: trimmed,
      displayText: trimmed,
      optimisticMessage: createOptimisticUserMessage(message.chat_id, trimmed),
    };

    const runtimeState = chatRuntimeStates[message.chat_id] ?? createDefaultChatRuntimeState();
    if (runtimeState.isStreaming) {
      enqueueMessage(message.chat_id, outgoing);
      return;
    }

    await dispatchMessage(message.chat_id, outgoing, true);
  }, [chatRuntimeStates, createOptimisticUserMessage, dispatchMessage, enqueueMessage, isReadOnly, updateChatRuntimeState]);

  const renderedMessages = useMemo(() => (
    messages.map((msg, idx) => (
      <MessageBubble
        key={msg.id}
        message={msg}
        isSearchMatch={searchMatches.includes(idx)}
        isCurrentMatch={searchMatches[currentMatchIdx] === idx}
        onRetry={!msg.is_from_bot ? handleRetryMessage : undefined}
      />
    ))
  ), [currentMatchIdx, handleRetryMessage, messages, searchMatches]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleModalKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setIsInputModalOpen(false);
      return;
    }

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSend();
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

  // Soul handlers
  const handleOpenSoul = async () => {
    if (!chatId) return;
    try {
      const s = await readSoul(chatId);
      setSoulContent(s.content);
      setSoulOriginal(s.content);
      setSoulOpen(true);
    } catch { /* ignore */ }
  };

  const handleSaveSoul = async () => {
    if (!chatId) return;
    setSoulSaving(true);
    try {
      await saveSoul(soulContent, chatId);
      setSoulOriginal(soulContent);
    } catch { /* ignore */ }
    setSoulSaving(false);
  };

  const handleCloseSoul = () => {
    setSoulOpen(false);
  };

  if (chatId === null) {
    return (
      <main className="chat-window chat-window-empty">
        <div className="chat-header" />
        <div className="chat-empty-state">
          <div className="empty-state-icon">VC</div>
          <h2>Welcome to VirusClaw</h2>
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
        {!isReadOnly && (
          <button className="chat-header-soul-btn" onClick={handleOpenSoul} title="Chat personality">
            <Sparkles size={14} />
          </button>
        )}
      </div>

      {/* Per-chat soul editor */}
      {soulOpen && (
        <div className="chat-soul-panel">
          <div className="chat-soul-panel-header">
            <span className="chat-soul-panel-title">Chat Personality</span>
            <div className="chat-soul-panel-actions">
              {soulContent !== soulOriginal && (
                <button
                  className="btn-save"
                  style={{ fontSize: 11, padding: "2px 10px" }}
                  onClick={handleSaveSoul}
                  disabled={soulSaving}
                >
                  {soulSaving ? "Saving..." : "Save"}
                </button>
              )}
              <button className="chat-search-close" onClick={handleCloseSoul}>
                <X size={14} />
              </button>
            </div>
          </div>
          <textarea
            className="chat-soul-textarea"
            value={soulContent}
            onChange={(e) => setSoulContent(e.target.value)}
            rows={6}
            placeholder="Override personality for this chat only. Leave empty to use global SOUL.md."
          />
          <p className="chat-soul-hint">
            {soulContent.trim() ? "This chat uses a custom personality override." : "No override — using global SOUL.md."}
          </p>
        </div>
      )}

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
        {renderedMessages}

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
              <BotMessageMarkdown content={streamingText} />
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

        {streamStatus && (
          <div className={`chat-status-indicator chat-status-${streamPhase}`}>
            <div className="chat-status-main">
              <span className="chat-status-spinner" aria-hidden="true" />
              <span>{streamStatus.label}</span>
            </div>
            {streamStatus.detail && (
              <span className="chat-status-detail">{streamStatus.detail}</span>
            )}
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
          <div className="chat-composer">
            {queuedMessages.length > 0 && (
              <div className="chat-queue-notice">
                {queuedMessages.map((message, index) => (
                  <div key={message.optimisticMessage.id} className="chat-queue-notice-item">
                    <span className="chat-queue-notice-index">#{index + 1}</span>
                    <span className="chat-queue-notice-text">{message.displayText}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-input-area">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) processFiles(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <button
              className="btn-attach"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              ref={textareaRef}
              className="chat-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                resizeComposerTextarea(e.target);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type a message..."
              rows={1}
            />
            <button
              className="btn-attach"
              onClick={() => setIsInputModalOpen(true)}
              title="Open fullscreen composer"
            >
              <Maximize2 size={18} />
            </button>
            <button
              className="btn-send"
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0)}
            >
              Send
            </button>
            </div>
          </div>
        </>
      )}
      {isInputModalOpen && (
        <div className="input-modal-overlay" onClick={() => setIsInputModalOpen(false)}>
          <div className="input-modal" onClick={(e) => e.stopPropagation()}>
            <div className="input-modal-header">
              <div>
                <h3 className="input-modal-title">Fullscreen Composer</h3>
                <p className="input-modal-subtitle">Use `Ctrl+Enter` to send. `Esc` closes the modal.</p>
              </div>
              <button
                className="input-modal-close"
                onClick={() => setIsInputModalOpen(false)}
                title="Close fullscreen composer"
              >
                <X size={18} />
              </button>
            </div>
            <textarea
              ref={modalTextareaRef}
              className="input-modal-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleModalKeyDown}
              onPaste={handlePaste}
              placeholder="Type a long prompt..."
              rows={16}
            />
            <div className="input-modal-footer">
              <button className="input-modal-btn input-modal-btn-secondary" onClick={() => setIsInputModalOpen(false)}>
                Close
              </button>
              <button
                className="input-modal-btn input-modal-btn-primary"
                onClick={handleSend}
                disabled={(!input.trim() && attachments.length === 0)}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
