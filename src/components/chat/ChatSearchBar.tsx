import { ChevronUp, ChevronDown, X } from "lucide-react";

export interface ChatSearchBarProps {
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent) => void;
  searchMatchesCount: number;
  currentMatchIdx: number;
  onNavigateMatch: (dir: number) => void;
  onClose: () => void;
}

export function ChatSearchBar({
  searchQuery,
  searchInputRef,
  onSearchChange,
  onSearchKeyDown,
  searchMatchesCount,
  currentMatchIdx,
  onNavigateMatch,
  onClose,
}: ChatSearchBarProps) {
  return (
    <div className="chat-search-bar">
      <input
        ref={searchInputRef}
        className="chat-search-input"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search messages..."
      />
      <span className="chat-search-count">
        {searchMatchesCount > 0
          ? `${currentMatchIdx + 1}/${searchMatchesCount}`
          : searchQuery
            ? "0 results"
            : ""}
      </span>
      <button className="chat-search-nav" onClick={() => onNavigateMatch(-1)} title="Previous">
        <ChevronUp size={14} />
      </button>
      <button className="chat-search-nav" onClick={() => onNavigateMatch(1)} title="Next">
        <ChevronDown size={14} />
      </button>
      <button className="chat-search-close" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
