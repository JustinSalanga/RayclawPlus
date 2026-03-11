import { Sparkles } from "lucide-react";

export interface ChatHeaderProps {
  chatId: number;
  chatTitle: string | null;
  badge: string | null;
  isReadOnly: boolean;
  isEditingTitle: boolean;
  editTitle: string;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  onEditTitleChange: (value: string) => void;
  onTitleDoubleClick: () => void;
  onTitleConfirm: () => void;
  onTitleKeyDown: (e: React.KeyboardEvent) => void;
  onOpenSoul: () => void;
}

export function ChatHeader({
  chatId,
  chatTitle,
  badge,
  isReadOnly,
  isEditingTitle,
  editTitle,
  titleInputRef,
  onEditTitleChange,
  onTitleDoubleClick,
  onTitleConfirm,
  onTitleKeyDown,
  onOpenSoul,
}: ChatHeaderProps) {
  return (
    <div className="chat-header">
      {isEditingTitle ? (
        <input
          ref={titleInputRef}
          className="chat-header-title-input"
          value={editTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onBlur={onTitleConfirm}
          onKeyDown={onTitleKeyDown}
        />
      ) : (
        <span className="chat-header-title" onDoubleClick={onTitleDoubleClick}>
          {badge && <span className="channel-badge">{badge}</span>}
          {chatTitle || `Chat ${chatId}`}
        </span>
      )}
      {isReadOnly && <span className="chat-header-readonly">View only</span>}
      {!isReadOnly && (
        <button className="chat-header-soul-btn" onClick={onOpenSoul} title="Chat personality">
          <Sparkles size={14} />
        </button>
      )}
    </div>
  );
}
