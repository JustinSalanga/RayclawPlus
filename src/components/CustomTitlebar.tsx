import type { ReactNode } from "react";
import { useCallback } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../assets/logo-text.png";

const TITLEBAR_HEIGHT = 36;

export interface CustomTitlebarProps {
  chatHeaderContent?: ReactNode;
}

export function CustomTitlebar({ chatHeaderContent }: CustomTitlebarProps) {
  const appWindow = getCurrentWindow();

  const onMinimize = useCallback(() => {
    void appWindow.minimize();
  }, []);

  const onMaximize = useCallback(() => {
    void appWindow.toggleMaximize();
  }, []);

  const onClose = useCallback(() => {
    void appWindow.close();
  }, []);

  const onTitlebarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      if (e.detail === 2) {
        void appWindow.toggleMaximize();
      } else {
        void appWindow.startDragging();
      }
    },
    [],
  );

  return (
    <header
      className="custom-titlebar-container"
      onMouseDown={onTitlebarMouseDown}
    >
      <div className="custom-titlebar-container-left">
        <div className="custom-titlebar-icon" data-tauri-drag-region>
          <img src={appIcon} alt="" />
        </div>
      </div>
      <div className="custom-titlebar-container-right">
        <div className="custom-titlebar">
          <div className="custom-titlebar-left" data-tauri-drag-region>
            <span className="custom-titlebar-title" data-tauri-drag-region>
              VirusClaw Desktop
            </span>
          </div>
          <div className="custom-titlebar-right" data-no-drag>
            <button
              type="button"
              className="custom-titlebar-btn"
              title="Minimize"
              aria-label="Minimize"
              onClick={onMinimize}
            >
              <Minus size={20} />
            </button>
            <button
              type="button"
              className="custom-titlebar-btn"
              title="Maximize"
              aria-label="Maximize"
              onClick={onMaximize}
            >
              <Square size={16} />
            </button>
            <button
              type="button"
              className="custom-titlebar-btn custom-titlebar-close"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="custom-titlebar-container-chat-header" data-no-drag>
          {chatHeaderContent}
        </div>
      </div>
    </header>
  );
}

export const CUSTOM_TITLEBAR_HEIGHT = TITLEBAR_HEIGHT;
