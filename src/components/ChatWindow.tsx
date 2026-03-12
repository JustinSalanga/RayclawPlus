import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { MessageSquarePlus, Settings, X } from "lucide-react";
import { getConfig, getHistory, renameChat, readAttachmentAsDataUrl, setShowThinking, stopAgent } from "../lib/tauri-api";
import { inferChannel, channelLabel } from "../types";
import type { StoredMessage } from "../types";
import logoText from "../assets/logo-text.png";
import { mergeMessagesWithAttachmentPreviews } from "./chat/chatTypes";
import { useChatStreaming } from "./chat/useChatStreaming";
import { useChatSearch } from "./chat/useChatSearch";
import { useAttachments } from "./chat/useAttachments";
import { useSoulEditor } from "./chat/useSoulEditor";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatSearchBar } from "./chat/ChatSearchBar";
import { ChatTimeline } from "./chat/ChatTimeline";
import { ChatComposer } from "./chat/ChatComposer";
import type { QueuedMessage } from "./chat/chatTypes";

export interface ChatWindowProps {
  chatId: number | null;
  chatTitle: string | null;
  chatType?: string;
  onNewChat?: () => void;
  onOpenSettings?: () => void;
  onTitleChanged?: () => void;
  searchOpen?: boolean;
  onSearchClose?: () => void;
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
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [isInputModalOpen, setIsInputModalOpen] = useState(false);
  const [showThinking, setShowThinkingState] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const {
    activeRuntimeState,
    createOptimisticUserMessage,
    enqueueMessage,
    dispatchMessage,
    handleRetryMessage,
  } = useChatStreaming({
    chatId,
    chatTitle: chatTitle ?? null,
    setMessages,
    scrollToBottom,
    onTitleChanged,
  });

  const {
    isStreaming,
    streamPhase,
    streamingText,
    toolSteps,
    sendError,
    queuedMessages,
    streamStartedAt,
    lastResponseDurationMs,
    lastStreamResponseMessageId,
  } = activeRuntimeState;

  const [elapsedTick, setElapsedTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setElapsedTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [isStreaming]);

  const search = useChatSearch({
    messages,
    searchOpenProp,
    onSearchClose,
  });

  const {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    currentMatchIdx,
    setCurrentMatchIdx,
    searchInputRef,
    searchMatches,
    navigateMatch,
    closeSearch,
  } = search;

  const attachmentsApi = useAttachments(isReadOnly, chatId);
  const {
    attachments,
    setAttachments,
    dragOver,
    fileInputRef,
    processFiles,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    removeAttachment,
  } = attachmentsApi;

  const soul = useSoulEditor(chatId);
  const {
    soulOpen,
    soulContent,
    soulOriginal,
    soulSaving,
    handleOpenSoul,
    handleSaveSoul,
    handleCloseSoul,
    setSoulOpen,
    setSoulContent,
  } = soul;

  useEffect(() => {
    setSearchOpen(false);
    setAttachments([]);
    setSoulOpen(false);
  }, [chatId, setAttachments, setSearchOpen, setSoulOpen]);

  useEffect(() => {
    getConfig()
      .then((cfg) => setShowThinkingState(Boolean(cfg.show_thinking)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (chatId === null) {
      setMessages([]);
      return;
    }
    getHistory(chatId)
      .then(async (msgs) => {
        const withPreviews = await Promise.all(
          msgs.map(async (m) => {
            if (!m.attachment_paths?.length) return m;
            const previews = await Promise.all(
              m.attachment_paths.map(async (p) => {
                try {
                  const dataUrl = await readAttachmentAsDataUrl(p.path);
                  return { name: p.name, type: p.media_type, dataUrl };
                } catch {
                  return null;
                }
              }),
            );
            const attachmentPreviews = previews.filter(
              (p): p is { name: string; type: string; dataUrl: string } => p != null && p.dataUrl !== "",
            );
            return { ...m, attachmentPreviews };
          }),
        );
        setMessages((prev) => mergeMessagesWithAttachmentPreviews(withPreviews, prev));
        setTimeout(scrollToBottom, 50);
      })
      .catch(() => setMessages([]));
  }, [chatId, scrollToBottom]);

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

  useEffect(() => {
    if (isEditingTitle) titleInputRef.current?.focus();
  }, [isEditingTitle]);

  useEffect(() => {
    if (!isInputModalOpen) return;
    const t = setTimeout(() => {
      modalTextareaRef.current?.focus();
      const len = modalTextareaRef.current?.value.length ?? 0;
      modalTextareaRef.current?.setSelectionRange(len, len);
    }, 30);
    return () => clearTimeout(t);
  }, [isInputModalOpen]);

  const resetComposer = useCallback(() => {
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (modalTextareaRef.current) modalTextareaRef.current.style.height = "auto";
  }, [setAttachments]);

  const onRetryMessage = useCallback(
    (message: StoredMessage) => {
      void handleRetryMessage(message, isReadOnly, resetComposer);
    },
    [handleRetryMessage, isReadOnly, resetComposer],
  );

  const streamStatus = useMemo(() => {
    if (!isStreaming || !streamPhase) return null;
    const runningToolCount = toolSteps.filter((s) => s.isRunning).length;
    const completedToolCount = toolSteps.length - runningToolCount;
    const totalDurationMs = toolSteps.reduce(
      (sum, s) => sum + (s.durationMs ?? 0),
      0,
    );
    const elapsedMs =
      streamStartedAt != null ? Date.now() - streamStartedAt : 0;
    const formatDuration = (ms: number) => {
      if (ms < 1000) return `${ms}ms`;
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const min = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `${min}m ${s}s` : `${min}m`;
    };
    let label = "VirusClaw is working...";
    switch (streamPhase) {
      case "thinking":
        label = "VirusClaw is thinking...";
        break;
      case "tooling":
        label =
          runningToolCount > 0
            ? `Running ${runningToolCount} tool${runningToolCount === 1 ? "" : "s"}...`
            : "Running tools...";
        break;
      case "waiting":
        label =
          completedToolCount > 0
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
      const donePart = `${completedToolCount} done`;
      const runningPart =
        runningToolCount > 0 ? `, ${runningToolCount} running` : "";
      const timePart =
        totalDurationMs > 0 ? ` in ${formatDuration(totalDurationMs)}` : "";
      parts.push(`${donePart}${runningPart}${timePart}`);
    }
    if (elapsedMs > 0) parts.push(`elapsed ${formatDuration(elapsedMs)}`);
    if (queuedMessages.length > 0) parts.push(`${queuedMessages.length} queued`);
    const detail = parts.length > 0 ? parts.join(" · ") : null;
    return { label, detail };
  }, [
    isStreaming,
    streamPhase,
    toolSteps,
    queuedMessages.length,
    streamStartedAt,
    elapsedTick,
  ]);

  const handleSend = useCallback(async () => {
    if ((!input.trim() && attachments.length === 0) || !chatId) return;
    const userText = input.trim();
    const currentAttachments = [...attachments];
    const attachmentDtos = currentAttachments
      .filter((a) => a.type.startsWith("image/"))
      .map((a) =>
        a.path
          ? { path: a.path, data: "", media_type: a.type, name: a.name }
          : {
              data: a.dataUrl.split(",")[1] || "",
              media_type: a.type,
              name: a.name,
            },
      );
    const attachmentPreviews = currentAttachments.map(({ name, type, dataUrl }) => ({
      name,
      type,
      dataUrl,
    }));
    const displayText =
      attachmentDtos.length > 0 && userText
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
    setIsInputModalOpen(false);
    if (isStreaming) {
      enqueueMessage(chatId, outgoing, resetComposer);
      return;
    }
    await dispatchMessage(chatId, outgoing, true, resetComposer);
  }, [
    input,
    attachments,
    chatId,
    isStreaming,
    createOptimisticUserMessage,
    enqueueMessage,
    dispatchMessage,
    resetComposer,
  ]);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        navigateMatch(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        navigateMatch(1);
      } else if (e.key === "Escape") closeSearch();
    },
    [navigateMatch, closeSearch],
  );

  const handleTitleDoubleClick = useCallback(() => {
    if (isReadOnly || !chatId) return;
    setEditTitle(chatTitle ?? "");
    setIsEditingTitle(true);
  }, [isReadOnly, chatId, chatTitle]);

  const handleTitleConfirm = useCallback(async () => {
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
  }, [chatId, editTitle, onTitleChanged]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleTitleConfirm();
      } else if (e.key === "Escape") setIsEditingTitle(false);
    },
    [handleTitleConfirm],
  );

  const resizeComposerTextarea = useCallback((element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = Math.min(element.scrollHeight, 160) + "px";
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handleModalKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsInputModalOpen(false);
        return;
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  if (chatId === null) {
    return (
      <main className="chat-window chat-window-empty">
        <div className="chat-header" />
        <div className="chat-empty-state">
          <img src={logoText} alt="VirusClaw" className="setup-logo" />
          <h2>Welcome to VirusClaw</h2>
          <p>Select a chat or start a new conversation</p>
          <div className="empty-state-actions">
            {onNewChat && (
              <button className="empty-state-btn" onClick={onNewChat} type="button">
                <MessageSquarePlus size={16} />
                New Chat
              </button>
            )}
            {onOpenSettings && (
              <button
                className="empty-state-btn empty-state-btn-secondary"
                onClick={onOpenSettings}
                type="button"
              >
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
      <ChatHeader
        chatId={chatId}
        chatTitle={chatTitle}
        badge={badge}
        isReadOnly={isReadOnly}
        isEditingTitle={isEditingTitle}
        editTitle={editTitle}
        titleInputRef={titleInputRef}
        onEditTitleChange={setEditTitle}
        onTitleDoubleClick={handleTitleDoubleClick}
        onTitleConfirm={handleTitleConfirm}
        onTitleKeyDown={handleTitleKeyDown}
        onOpenSoul={handleOpenSoul}
      />

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
                  type="button"
                >
                  {soulSaving ? "Saving..." : "Save"}
                </button>
              )}
              <button className="chat-search-close" onClick={handleCloseSoul} type="button">
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
            {soulContent.trim()
              ? "This chat uses a custom personality override."
              : "No override — using global SOUL.md."}
          </p>
        </div>
      )}

      {searchOpen && (
        <ChatSearchBar
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          onSearchChange={(value) => {
            setSearchQuery(value);
            setCurrentMatchIdx(0);
          }}
          onSearchKeyDown={handleSearchKeyDown}
          searchMatchesCount={searchMatches.length}
          currentMatchIdx={currentMatchIdx}
          onNavigateMatch={navigateMatch}
          onClose={closeSearch}
        />
      )}

      <ChatTimeline
        messages={messages}
        searchMatches={searchMatches}
        currentMatchIdx={currentMatchIdx}
        onRetryMessage={onRetryMessage}
        toolSteps={toolSteps}
        lastStreamResponseMessageId={lastStreamResponseMessageId ?? null}
        isStreaming={isStreaming}
        streamingText={streamingText}
        sendError={sendError}
        streamStatus={streamStatus}
        streamPhase={streamPhase}
        lastResponseDurationMs={lastResponseDurationMs}
        onStop={chatId != null ? () => void stopAgent(chatId) : undefined}
        messagesEndRef={messagesEndRef}
      />

      <ChatComposer
        isReadOnly={isReadOnly}
        input={input}
        setInput={setInput}
        showThinking={showThinking}
        onToggleThinking={async (enabled) => {
          setShowThinkingState(enabled);
          try {
            await setShowThinking(enabled);
          } catch {
            // ignore: toggle is best-effort
          }
        }}
        attachments={attachments}
        removeAttachment={removeAttachment}
        textareaRef={textareaRef}
        modalTextareaRef={modalTextareaRef}
        fileInputRef={fileInputRef}
        queuedMessages={queuedMessages}
        canSend={Boolean(input.trim() || attachments.length > 0)}
        onProcessFiles={processFiles}
        onResizeTextarea={resizeComposerTextarea}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onSend={handleSend}
        isInputModalOpen={isInputModalOpen}
        setIsInputModalOpen={setIsInputModalOpen}
        onModalKeyDown={handleModalKeyDown}
      />
    </main>
  );
}
