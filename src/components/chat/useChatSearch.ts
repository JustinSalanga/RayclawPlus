import { useState, useRef, useEffect, useMemo } from "react";
import type { StoredMessage } from "../../types";

export interface UseChatSearchArgs {
  messages: StoredMessage[];
  searchOpenProp?: boolean;
  onSearchClose?: () => void;
}

export function useChatSearch({
  messages,
  searchOpenProp,
  onSearchClose,
}: UseChatSearchArgs) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpenProp) setSearchOpen(true);
  }, [searchOpenProp]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    } else {
      setSearchQuery("");
      setCurrentMatchIdx(0);
    }
  }, [searchOpen]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .map((m, i) => (m.content.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i !== -1);
  }, [messages, searchQuery]);

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

  return {
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
  };
}
