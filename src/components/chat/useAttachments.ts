import { useState, useRef, useCallback } from "react";
import { saveAttachmentFile } from "../../lib/tauri-api";
import { MAX_ATTACHMENT_SIZE } from "./chatTypes";
import type { FileAttachment } from "./chatTypes";

export function useAttachments(isReadOnly: boolean, chatId: number | null) {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_ATTACHMENT_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            type: file.type,
            dataUrl: reader.result as string,
            size: file.size,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!isReadOnly) setDragOver(true);
    },
    [isReadOnly],
  );

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (isReadOnly) return;
      processFiles(Array.from(e.dataTransfer.files));
    },
    [isReadOnly, processFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((i) => i.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        for (const item of imageItems) {
          const file = item.getAsFile();
          if (!file || !file.type.startsWith("image/") || file.size > MAX_ATTACHMENT_SIZE) continue;
          (async () => {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
            const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1]! : "";
            try {
              const saved = await saveAttachmentFile(base64, file.name, file.type, chatId);
              setAttachments((prev) => [
                ...prev,
                { name: saved.name, type: saved.media_type, dataUrl, path: saved.path },
              ]);
            } catch {
              setAttachments((prev) => [
                ...prev,
                { name: file.name, type: file.type, dataUrl, size: file.size },
              ]);
            }
          })();
        }
      }
    },
    [chatId],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  return {
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
  };
}
