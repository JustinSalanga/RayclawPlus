import { X, Paperclip, Maximize2 } from "lucide-react";
import type { QueuedMessage } from "./chatTypes";
import type { FileAttachment } from "./chatTypes";

export interface ChatComposerProps {
  isReadOnly: boolean;
  input: string;
  setInput: (value: string) => void;
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
}

export function ChatComposer({
  isReadOnly,
  input,
  setInput,
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
}: ChatComposerProps) {
  if (isReadOnly) return null;

  return (
    <>
      {attachments.length > 0 && (
        <div className="attachment-preview-bar">
          {attachments.map((att, i) => (
            <div key={i} className="attachment-preview">
              <img src={att.dataUrl} alt={att.name} className="attachment-thumb" />
              <span className="attachment-name">{att.name}</span>
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
                type="button"
              >
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
              if (e.target.files) onProcessFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <button
            className="btn-attach"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            type="button"
          >
            <Paperclip size={18} />
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
            className="btn-attach"
            onClick={() => setIsInputModalOpen(true)}
            title="Open fullscreen composer"
            type="button"
          >
            <Maximize2 size={18} />
          </button>
          <button
            className="btn-send"
            onClick={onSend}
            disabled={!canSend}
            type="button"
          >
            Send
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
