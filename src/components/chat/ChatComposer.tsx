import { useEffect, useRef, useState } from "react";
import { X, Plus, Paperclip, Brain, Maximize2, FileText, FileCode2, FileArchive, FileAudio2, FileVideo2, Send } from "lucide-react";
import type { QueuedMessage } from "./chatTypes";
import type { FileAttachment } from "./chatTypes";

export interface ChatComposerProps {
  isReadOnly: boolean;
  input: string;
  setInput: (value: string) => void;
  showThinking: boolean;
  onToggleThinking: (enabled: boolean) => void | Promise<void>;
  attachments: FileAttachment[];
  removeAttachment: (idx: number) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  modalTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  queuedMessages: QueuedMessage[];
  canSend: boolean;
  onProcessFiles: (files: File[]) => void;
  onResizeTextarea: (el: HTMLTextAreaElement) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onSend: () => void;
  isInputModalOpen: boolean;
  setIsInputModalOpen: (open: boolean) => void;
  onModalKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Files skipped because they exceed max size; show notice and dismiss handler */
  oversizedFileNames?: string[];
  onDismissOversizedNotice?: () => void;
  maxAttachmentSizeMB?: number;
}

export function ChatComposer({
  isReadOnly,
  input,
  setInput,
  showThinking,
  onToggleThinking,
  attachments,
  removeAttachment,
  textareaRef,
  modalTextareaRef,
  fileInputRef,
  queuedMessages,
  canSend,
  onProcessFiles,
  onResizeTextarea,
  onKeyDown,
  onPaste,
  onSend,
  isInputModalOpen,
  setIsInputModalOpen,
  onModalKeyDown,
  oversizedFileNames = [],
  onDismissOversizedNotice,
  maxAttachmentSizeMB = 20,
}: ChatComposerProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isMenuOpen]);

  if (isReadOnly) return null;

  return (
    <>
      {oversizedFileNames.length > 0 && (
        <div className="attachment-size-notice" role="alert">
          <span className="attachment-size-notice-text">
            {oversizedFileNames.length === 1
              ? `"${oversizedFileNames[0]}" is over ${maxAttachmentSizeMB} MB and was not attached.`
              : `${oversizedFileNames.length} files over ${maxAttachmentSizeMB} MB were not attached: ${oversizedFileNames.slice(0, 3).join(", ")}${oversizedFileNames.length > 3 ? ` and ${oversizedFileNames.length - 3} more` : ""}.`}
          </span>
          {onDismissOversizedNotice && (
            <button
              type="button"
              className="attachment-size-notice-dismiss"
              onClick={onDismissOversizedNotice}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachment-preview-bar">
          {attachments.map((att, i) => {
            const isImage = att.type?.startsWith("image/");
            const lowerName = att.name.toLowerCase();
            const isAudio =
              att.type?.startsWith("audio/") ||
              /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(lowerName);
            const isVideo =
              att.type?.startsWith("video/") ||
              /\.(mp4|webm|mov|m4v|avi|mkv)$/.test(lowerName);
            const isArchive =
              /\.(zip|rar|7z|tar|gz|tgz|bz2)$/.test(lowerName);
            const isCode =
              att.type === "text/x-python" ||
              att.type === "text/x-typescript" ||
              att.type === "text/x-javascript" ||
              /\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c|h|hpp|rb|php|sh|ps1|sql|json|yml|yaml|toml|ini|cfg|conf|md|log)$/.test(
                lowerName,
              );
            const isText =
              att.type?.startsWith("text/") || /\.(txt|doc|docx|xls|xlsx|ppt|pptx|pdf)$/.test(lowerName);

            let Icon = Paperclip;
            if (!isImage) {
              if (isArchive) Icon = FileArchive;
              else if (isAudio) Icon = FileAudio2;
              else if (isVideo) Icon = FileVideo2;
              else if (isCode) Icon = FileCode2;
              else if (isText) Icon = FileText;
            }

            return (
              <div key={i} className="attachment-preview">
                {isImage && att.dataUrl ? (
                  <img src={att.dataUrl} alt={att.name} className="attachment-thumb" />
                ) : (
                  <div className="attachment-thumb attachment-thumb-file">
                    <Icon size={24} />
                  </div>
                )}
                <span className="attachment-name">{att.name}</span>
                <button
                  className="attachment-remove"
                  onClick={() => removeAttachment(i)}
                  type="button"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
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
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) onProcessFiles(Array.from(e.target.files));
              setIsMenuOpen(false);
              e.target.value = "";
            }}
          />
          <div
            ref={menuRef}
            className={`composer-dropdown${isMenuOpen ? " composer-dropdown-open" : ""}`}
          >
            <button
              className="btn-attach"
              title="Add"
              type="button"
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              <Plus size={18} />
            </button>
            <div className="composer-dropdown-menu" role="menu" aria-label="Composer actions">
              <button
                className="composer-dropdown-item"
                onClick={() => fileInputRef.current?.click()}
                type="button"
                role="menuitem"
              >
                <Paperclip size={16} />
                <span className="composer-dropdown-label">Add files</span>
              </button>
              <div className="composer-dropdown-item composer-dropdown-item-toggle" role="menuitem">
                <div className="composer-dropdown-left">
                  <Brain size={16} />
                  <span className="composer-dropdown-label">Thinking</span>
                </div>
                <label className="channel-switch" title="Toggle thinking">
                  <input
                    type="checkbox"
                    checked={showThinking}
                    onChange={(e) => onToggleThinking(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
          </div>
          <button
            className="btn-attach"
            onClick={() => setIsInputModalOpen(true)}
            title="Open fullscreen composer"
            type="button"
          >
            <Maximize2 size={16} />
          </button>
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              onResizeTextarea(e.target);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Type a message..."
            rows={1}
          />
          <button
            className="btn-send"
            onClick={onSend}
            disabled={!canSend}
            type="button"
          >
            <Send size={20} /> <span className="btn-send-text">Send</span>
          </button>
        </div>
      </div>
      {isInputModalOpen && (
        <div
          className="input-modal-overlay"
          onClick={() => setIsInputModalOpen(false)}
          role="presentation"
        >
          <div className="input-modal" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="input-modal-header">
              <div>
                <h3 className="input-modal-title">Fullscreen Composer</h3>
                <p className="input-modal-subtitle">
                  Use `Ctrl+Enter` to send. `Esc` closes the modal.
                </p>
              </div>
              <button
                className="input-modal-close"
                onClick={() => setIsInputModalOpen(false)}
                title="Close fullscreen composer"
                type="button"
              >
                <X size={18} />
              </button>
            </div>
            <textarea
              ref={modalTextareaRef}
              className="input-modal-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onModalKeyDown}
              onPaste={onPaste}
              placeholder="Type a long prompt..."
              rows={16}
            />
            <div className="input-modal-footer">
              <button
                className="input-modal-btn input-modal-btn-secondary"
                onClick={() => setIsInputModalOpen(false)}
                type="button"
              >
                Close
              </button>
              <button
                className="input-modal-btn input-modal-btn-primary"
                onClick={onSend}
                disabled={!canSend}
                type="button"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
