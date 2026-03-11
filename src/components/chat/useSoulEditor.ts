import { useState, useCallback } from "react";
import { readSoul, saveSoul } from "../../lib/tauri-api";

export function useSoulEditor(chatId: number | null) {
  const [soulOpen, setSoulOpen] = useState(false);
  const [soulContent, setSoulContent] = useState("");
  const [soulOriginal, setSoulOriginal] = useState("");
  const [soulSaving, setSoulSaving] = useState(false);

  const handleOpenSoul = useCallback(async () => {
    if (!chatId) return;
    try {
      const s = await readSoul(chatId);
      setSoulContent(s.content);
      setSoulOriginal(s.content);
      setSoulOpen(true);
    } catch {
      // ignore
    }
  }, [chatId]);

  const handleSaveSoul = useCallback(async () => {
    if (!chatId) return;
    setSoulSaving(true);
    try {
      await saveSoul(soulContent, chatId);
      setSoulOriginal(soulContent);
    } catch {
      // ignore
    }
    setSoulSaving(false);
  }, [chatId, soulContent]);

  const handleCloseSoul = useCallback(() => setSoulOpen(false), []);

  return {
    soulOpen,
    setSoulOpen,
    soulContent,
    setSoulContent,
    soulOriginal,
    soulSaving,
    handleOpenSoul,
    handleSaveSoul,
    handleCloseSoul,
  };
}
