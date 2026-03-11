import { memo, useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Bot, ChevronDown, ChevronUp, FileDown, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import type { StoredMessage } from "../types";

interface MessageBubbleProps {
  message: StoredMessage;
  isSearchMatch?: boolean;
  isCurrentMatch?: boolean;
  onRetry?: (message: StoredMessage) => void;
}

type MediaKind = "image" | "audio" | "video" | "pdf";

interface MediaReference {
  original: string;
  source: string;
  kind: MediaKind;
}

interface ImagePreviewState {
  source: string;
  alt: string;
}

interface Size {
  width: number;
  height: number;
}

interface ImagePreviewMetrics {
  renderWidth: number;
  renderHeight: number;
  stageWidth: number;
  stageHeight: number;
}

interface ZoomAnchor {
  viewportX: number;
  viewportY: number;
  imageRelativeX: number;
  imageRelativeY: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "avi", "mkv"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const IMAGE_PREVIEW_MIN_ZOOM = 0.5;
const IMAGE_PREVIEW_MAX_ZOOM = 20;
const IMAGE_PREVIEW_ZOOM_STEP = 0.2;
const IMAGE_PREVIEW_WHEEL_ZOOM_SCALE = 0.0025;
const IMAGE_PREVIEW_ZOOM_EPSILON = 0.001;
const IMAGE_PREVIEW_ZOOM_SMOOTHING = 0.2;

function normalizeLocalPath(raw: string): string {
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname;
    } catch {
      return raw;
    }
  }
  return raw;
}

function isLocalPath(raw: string): boolean {
  const value = normalizeLocalPath(raw);
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith("/");
}

function mediaKindForPath(raw: string): MediaKind | null {
  const normalized = normalizeLocalPath(raw);
  const clean = normalized.split(/[?#]/)[0] ?? normalized;
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1).toLowerCase() : "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  return null;
}

function resolveMediaSource(raw: string): string {
  if (/^(https?:|data:|blob:)/i.test(raw)) {
    return raw;
  }
  const normalized = normalizeLocalPath(raw);
  if (isLocalPath(normalized)) {
    return convertFileSrc(normalized);
  }
  return raw;
}

function clampImagePreviewZoom(value: number): number {
  return Math.min(IMAGE_PREVIEW_MAX_ZOOM, Math.max(IMAGE_PREVIEW_MIN_ZOOM, value));
}

function clampScrollOffset(value: number, viewportSize: number, contentSize: number): number {
  return Math.min(Math.max(0, value), Math.max(0, contentSize - viewportSize));
}

function stripImagePlaceholder(content: string): string {
  return content.replace(/^\[image\]\s*/i, "");
}

function extractMediaReferences(content: string): MediaReference[] {
  const seen = new Set<string>();
  const refs: MediaReference[] = [];
  const patterns = [
    /`((?:[A-Za-z]:[\\/]|\/|\\\\|file:\/\/|https?:\/\/)[^`\n]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|mp3|wav|ogg|m4a|flac|aac|opus|mp4|webm|mov|m4v|avi|mkv|pdf)(?:[?#][^`\n]*)?)`/gi,
    /((?:[A-Za-z]:[\\/]|\/|\\\\|file:\/\/|https?:\/\/)[^\s<>"')\]]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|mp3|wav|ogg|m4a|flac|aac|opus|mp4|webm|mov|m4v|avi|mkv|pdf)(?:[?#][^\s<>"')\]]*)?)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const rawCandidate = (match[1] ?? match[0] ?? "").trim().replace(/^<|>$/g, "");
      const candidate = rawCandidate.replace(/\s+"[^"]*"$/, "");
      const kind = mediaKindForPath(candidate);
      if (!kind || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      refs.push({
        original: candidate,
        source: resolveMediaSource(candidate),
        kind,
      });
    }
  }

  return refs;
}

function extractAttachmentMediaReferences(message: StoredMessage): MediaReference[] {
  const previews = message.attachmentPreviews ?? [];

  return previews.reduce<MediaReference[]>((media, preview) => {
    if (!preview.type.startsWith("image/")) {
      return media;
    }

    media.push({
      original: preview.name,
      source: preview.dataUrl,
      kind: "image",
    });
    return media;
  }, []);
}

function InlineMedia({
  media,
  onImagePreview,
}: {
  media: MediaReference;
  onImagePreview?: (source: string, alt: string) => void;
}) {
  if (media.kind === "image") {
    return (
      <button
        type="button"
        className="message-media-button"
        onClick={() => onImagePreview?.(media.source, media.original)}
        title="Open image preview"
      >
        <img className="message-media message-media-image" src={media.source} alt={media.original} loading="lazy" />
      </button>
    );
  }

  if (media.kind === "audio") {
    return <audio className="message-media message-media-audio" src={media.source} controls preload="metadata" />;
  }

  if (media.kind === "pdf") {
    return (
      <div className="message-media message-media-pdf-frame">
        <iframe
          className="message-media-pdf"
          src={media.source}
          title={media.original}
        />
      </div>
    );
  }

  return <video className="message-media message-media-video" src={media.source} controls preload="metadata" playsInline />;
}

function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <div className="code-block-wrapper">
      <button className="code-copy-btn" onClick={handleCopy} title="Copy code">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="code-block">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const BotMessageMarkdown = memo(function BotMessageMarkdown({
  content,
  onImagePreview,
}: {
  content: string;
  onImagePreview?: (source: string, alt: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className && !String(children).includes("\n");
          return isInline ? (
            <code className="inline-code" {...props}>{children}</code>
          ) : (
            <CodeBlock className={className}>{children}</CodeBlock>
          );
        },
        img({ src, alt, ...props }) {
          const resolvedSrc = src ? resolveMediaSource(src) : "";
          return resolvedSrc ? (
            onImagePreview ? (
              <button
                type="button"
                className="message-media-button"
                onClick={() => onImagePreview(resolvedSrc, alt ?? "")}
                title="Open image preview"
              >
                <img
                  {...props}
                  className="message-media message-media-image"
                  src={resolvedSrc}
                  alt={alt ?? ""}
                  loading="lazy"
                />
              </button>
            ) : (
              <img
                {...props}
                className="message-media message-media-image"
                src={resolvedSrc}
                alt={alt ?? ""}
                loading="lazy"
              />
            )
          ) : null;
        },
        a({ href, children, ...props }) {
          if (!href) return <a href={href} {...props}>{children}</a>;
          const kind = mediaKindForPath(href);
          if (!kind) return <a href={href} {...props}>{children}</a>;
          const resolved = resolveMediaSource(href);
          if (kind === "image") {
            const alt = typeof children === "string" ? children : href.split(/[\\/]/).pop() ?? "";
            return onImagePreview ? (
              <button type="button" className="message-media-button" onClick={() => onImagePreview(resolved, alt)} title="Open image preview">
                <img className="message-media message-media-image" src={resolved} alt={alt} loading="lazy" />
              </button>
            ) : (
              <img className="message-media message-media-image" src={resolved} alt={alt} loading="lazy" />
            );
          }
          if (kind === "audio") {
            return <audio className="message-media message-media-audio" src={resolved} controls preload="metadata" />;
          }
          if (kind === "video") {
            return <video className="message-media message-media-video" src={resolved} controls preload="metadata" playsInline />;
          }
          if (kind === "pdf") {
            return (
              <div className="message-media message-media-pdf-frame">
                <iframe className="message-media-pdf" src={resolved} title={href.split(/[\\/]/).pop() ?? "PDF"} />
              </div>
            );
          }
          return <a href={href} {...props}>{children}</a>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

const COLLAPSE_LINE_THRESHOLD = 30;

function messageFilename(message: StoredMessage) {
  const sender = (message.is_from_bot ? "assistant" : message.sender_name || "message")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date(message.timestamp)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${sender}-${stamp}.md`;
}

function MessageBubble({ message, isSearchMatch, isCurrentMatch, onRetry }: MessageBubbleProps) {
  const isBot = message.is_from_bot;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const lineCount = message.content.split("\n").length;
  const isLong = isBot && lineCount > COLLAPSE_LINE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(isLong);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [imagePreviewZoom, setImagePreviewZoom] = useState(1);
  const [imagePreviewTargetZoom, setImagePreviewTargetZoom] = useState(1);
  const [imagePreviewNaturalSize, setImagePreviewNaturalSize] = useState<Size | null>(null);
  const [imagePreviewViewportSize, setImagePreviewViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [isImagePreviewDragging, setIsImagePreviewDragging] = useState(false);
  const imagePreviewViewportRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewModalRef = useRef<HTMLDivElement | null>(null);
  const imagePreviewDragRef = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const imagePreviewZoomAnimationRef = useRef<number | null>(null);
  const imagePreviewZoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const attachmentMediaReferences = useMemo(() => extractAttachmentMediaReferences(message), [message]);
  // User messages show attachment previews in a separate media stack
  const mediaReferences = useMemo(
    () => isBot ? [] : attachmentMediaReferences,
    [isBot, attachmentMediaReferences],
  );
  const botContentWithInlineMedia = useMemo(() => {
    if (!isBot) return message.content;
    let content = message.content;

    // Resolve local paths inside existing markdown images to Tauri asset URLs
    // so ReactMarkdown can load them (backslash paths + bare C:/ paths both work).
    content = content.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt: string, href: string) => {
        const resolved = resolveMediaSource(href.replace(/\\/g, "/"));
        return `![${alt}](${resolved})`;
      },
    );

    // Convert bare local/remote media paths into markdown syntax with resolved URLs
    const refs = extractMediaReferences(content);
    for (const ref of refs) {
      const escaped = ref.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const alreadyMd = new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escaped.replace(/\\\\/g, "[/\\\\\\\\]")}`);
      if (alreadyMd.test(content)) continue;
      const label = ref.original.split(/[\\/]/).pop() ?? "media";
      const resolved = resolveMediaSource(ref.original);
      if (ref.kind === "image") {
        content = content.replace(ref.original, `![${label}](${resolved})`);
      } else {
        content = content.replace(ref.original, `[${label}](${resolved})`);
      }
    }

    return content;
  }, [isBot, message.content]);
  const userDisplayText = useMemo(
    () => (message.attachmentPreviews?.length ? stripImagePlaceholder(message.content) : message.content),
    [message.attachmentPreviews, message.content],
  );
  const imagePreviewMetrics = useMemo<ImagePreviewMetrics | null>(() => {
    if (!imagePreviewNaturalSize || imagePreviewViewportSize.width <= 0 || imagePreviewViewportSize.height <= 0) {
      return null;
    }

    const fitScale = Math.min(
      imagePreviewViewportSize.width / imagePreviewNaturalSize.width,
      imagePreviewViewportSize.height / imagePreviewNaturalSize.height,
      1,
    );
    const baseWidth = imagePreviewNaturalSize.width * fitScale;
    const baseHeight = imagePreviewNaturalSize.height * fitScale;
    const renderWidth = baseWidth * imagePreviewZoom;
    const renderHeight = baseHeight * imagePreviewZoom;

    return {
      renderWidth,
      renderHeight,
      stageWidth: Math.max(imagePreviewViewportSize.width, renderWidth),
      stageHeight: Math.max(imagePreviewViewportSize.height, renderHeight),
    };
  }, [imagePreviewNaturalSize, imagePreviewViewportSize, imagePreviewZoom]);
  const isImagePreviewPannable = Boolean(
    imagePreviewMetrics
    && (
      imagePreviewMetrics.renderWidth > imagePreviewViewportSize.width + 1
      || imagePreviewMetrics.renderHeight > imagePreviewViewportSize.height + 1
    ),
  );

  const matchClass = isCurrentMatch
    ? "message-search-current"
    : isSearchMatch
      ? "message-search-match"
      : "";

  const handleCopyMessage = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message.content]);

  const handleDownloadMessage = useCallback(async () => {
    try {
      const filePath = await save({
        defaultPath: messageFilename(message),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!filePath) return;
      await writeTextFile(filePath, message.content);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    } catch (err) {
      console.error("Failed to save message:", err);
    }
  }, [message]);

  const handleOpenImagePreview = useCallback((source: string, alt: string) => {
    setImagePreview({ source, alt });
    setImagePreviewZoom(1);
    setImagePreviewTargetZoom(1);
    setImagePreviewNaturalSize(null);
    setIsImagePreviewDragging(false);
    imagePreviewDragRef.current = null;
    imagePreviewZoomAnchorRef.current = null;
  }, []);

  const handleCloseImagePreview = useCallback(() => {
    setImagePreview(null);
    setImagePreviewZoom(1);
    setImagePreviewTargetZoom(1);
    setImagePreviewNaturalSize(null);
    setIsImagePreviewDragging(false);
    imagePreviewDragRef.current = null;
    imagePreviewZoomAnchorRef.current = null;
  }, []);

  const setImagePreviewZoomTarget = useCallback((nextZoom: number, anchor?: { clientX: number; clientY: number }) => {
    const viewport = imagePreviewViewportRef.current;
    const metrics = imagePreviewMetrics;
    if (viewport && metrics) {
      const rect = viewport.getBoundingClientRect();
      const viewportX = anchor
        ? Math.min(Math.max(0, anchor.clientX - rect.left), rect.width)
        : rect.width / 2;
      const viewportY = anchor
        ? Math.min(Math.max(0, anchor.clientY - rect.top), rect.height)
        : rect.height / 2;
      const stageX = viewport.scrollLeft + viewportX;
      const stageY = viewport.scrollTop + viewportY;
      const imageOffsetX = (metrics.stageWidth - metrics.renderWidth) / 2;
      const imageOffsetY = (metrics.stageHeight - metrics.renderHeight) / 2;

      imagePreviewZoomAnchorRef.current = {
        viewportX,
        viewportY,
        imageRelativeX: (stageX - imageOffsetX) / metrics.renderWidth,
        imageRelativeY: (stageY - imageOffsetY) / metrics.renderHeight,
      };
    } else {
      imagePreviewZoomAnchorRef.current = null;
    }

    setImagePreviewTargetZoom(clampImagePreviewZoom(nextZoom));
  }, [imagePreviewMetrics]);

  const handleZoomIn = useCallback(() => {
    setImagePreviewZoomTarget(imagePreviewTargetZoom + IMAGE_PREVIEW_ZOOM_STEP);
  }, [imagePreviewTargetZoom, setImagePreviewZoomTarget]);

  const handleZoomOut = useCallback(() => {
    setImagePreviewZoomTarget(imagePreviewTargetZoom - IMAGE_PREVIEW_ZOOM_STEP);
  }, [imagePreviewTargetZoom, setImagePreviewZoomTarget]);

  const handleZoomReset = useCallback(() => {
    setImagePreviewZoomTarget(1);
  }, [setImagePreviewZoomTarget]);

  const handleImagePreviewMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isImagePreviewPannable || !imagePreviewViewportRef.current) {
      return;
    }

    event.preventDefault();
    imagePreviewDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: imagePreviewViewportRef.current.scrollLeft,
      scrollTop: imagePreviewViewportRef.current.scrollTop,
    };
    setIsImagePreviewDragging(true);
  }, [isImagePreviewPannable]);

  useEffect(() => {
    if (!imagePreview) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setImagePreview(null);
        setImagePreviewZoom(1);
        setImagePreviewTargetZoom(1);
        imagePreviewZoomAnchorRef.current = null;
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setImagePreviewZoomTarget(imagePreviewTargetZoom + IMAGE_PREVIEW_ZOOM_STEP);
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setImagePreviewZoomTarget(imagePreviewTargetZoom - IMAGE_PREVIEW_ZOOM_STEP);
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        setImagePreviewZoomTarget(1);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [imagePreview, imagePreviewTargetZoom, setImagePreviewZoomTarget]);

  useEffect(() => {
    if (!imagePreview) {
      if (imagePreviewZoomAnimationRef.current !== null) {
        cancelAnimationFrame(imagePreviewZoomAnimationRef.current);
        imagePreviewZoomAnimationRef.current = null;
      }
      return;
    }

    if (Math.abs(imagePreviewZoom - imagePreviewTargetZoom) <= IMAGE_PREVIEW_ZOOM_EPSILON) {
      if (imagePreviewZoom !== imagePreviewTargetZoom) {
        setImagePreviewZoom(imagePreviewTargetZoom);
      }
      imagePreviewZoomAnchorRef.current = null;
      if (imagePreviewZoomAnimationRef.current !== null) {
        cancelAnimationFrame(imagePreviewZoomAnimationRef.current);
        imagePreviewZoomAnimationRef.current = null;
      }
      return;
    }

    const animate = () => {
      setImagePreviewZoom((current) => {
        const next = current + ((imagePreviewTargetZoom - current) * IMAGE_PREVIEW_ZOOM_SMOOTHING);
        return Math.abs(next - imagePreviewTargetZoom) <= IMAGE_PREVIEW_ZOOM_EPSILON
          ? imagePreviewTargetZoom
          : next;
      });
      imagePreviewZoomAnimationRef.current = requestAnimationFrame(animate);
    };

    imagePreviewZoomAnimationRef.current = requestAnimationFrame(animate);

    return () => {
      if (imagePreviewZoomAnimationRef.current !== null) {
        cancelAnimationFrame(imagePreviewZoomAnimationRef.current);
        imagePreviewZoomAnimationRef.current = null;
      }
    };
  }, [imagePreview, imagePreviewTargetZoom, imagePreviewZoom]);

  useLayoutEffect(() => {
    const viewport = imagePreviewViewportRef.current;
    const anchor = imagePreviewZoomAnchorRef.current;
    if (!viewport || !anchor || !imagePreviewMetrics) {
      return;
    }

    const imageOffsetX = (imagePreviewMetrics.stageWidth - imagePreviewMetrics.renderWidth) / 2;
    const imageOffsetY = (imagePreviewMetrics.stageHeight - imagePreviewMetrics.renderHeight) / 2;
    const nextScrollLeft = imageOffsetX + (anchor.imageRelativeX * imagePreviewMetrics.renderWidth) - anchor.viewportX;
    const nextScrollTop = imageOffsetY + (anchor.imageRelativeY * imagePreviewMetrics.renderHeight) - anchor.viewportY;

    viewport.scrollLeft = clampScrollOffset(nextScrollLeft, viewport.clientWidth, imagePreviewMetrics.stageWidth);
    viewport.scrollTop = clampScrollOffset(nextScrollTop, viewport.clientHeight, imagePreviewMetrics.stageHeight);
  }, [imagePreviewMetrics]);

  useEffect(() => {
    if (!imagePreview || !imagePreviewViewportRef.current) {
      return;
    }

    const node = imagePreviewViewportRef.current;
    const updateViewportSize = () => {
      setImagePreviewViewportSize({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [imagePreview]);

  useEffect(() => {
    if (!imagePreview) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const modal = imagePreviewModalRef.current;
      const target = event.target;
      if (!(target instanceof Node) || (modal && !modal.contains(target))) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setImagePreviewZoomTarget(
        imagePreviewTargetZoom - (event.deltaY * IMAGE_PREVIEW_WHEEL_ZOOM_SCALE),
        { clientX: event.clientX, clientY: event.clientY },
      );
    };

    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleWheel, { capture: true });
  }, [imagePreview, imagePreviewTargetZoom, setImagePreviewZoomTarget]);

  useEffect(() => {
    if (!isImagePreviewDragging) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      if (!imagePreviewDragRef.current || !imagePreviewViewportRef.current) {
        return;
      }

      const { startX, startY, scrollLeft, scrollTop } = imagePreviewDragRef.current;
      imagePreviewViewportRef.current.scrollLeft = scrollLeft - (event.clientX - startX);
      imagePreviewViewportRef.current.scrollTop = scrollTop - (event.clientY - startY);
    };

    const handleMouseUp = () => {
      imagePreviewDragRef.current = null;
      setIsImagePreviewDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isImagePreviewDragging]);

  return (
    <>
      <div
        id={`msg-${message.id}`}
        className={`message-bubble ${isBot ? "message-bot" : "message-user"} ${matchClass}`}
      >
        {isBot && (
          <div className="message-sender">
            <span className="message-sender-avatar"><Bot size={12} /></span>
            VirusClaw
          </div>
        )}
        {!isBot && message.sender_name !== "user" && (
          <div className="message-sender message-sender-user">
            {message.sender_name}
          </div>
        )}
        <div className={`message-content ${isLong && collapsed ? "message-content-collapsed" : ""}`}>
          {mediaReferences.length > 0 && (
            <div className="message-media-stack">
              {mediaReferences.map((media) => (
                <InlineMedia key={media.original} media={media} onImagePreview={handleOpenImagePreview} />
              ))}
            </div>
          )}
          {isBot ? (
            <BotMessageMarkdown content={botContentWithInlineMedia} onImagePreview={handleOpenImagePreview} />
          ) : userDisplayText ? (
            <p>{userDisplayText}</p>
          ) : null}
        </div>
        {isLong && (
          <button className="btn-collapse-toggle" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? (
              <><ChevronDown size={14} /> Show more</>
            ) : (
              <><ChevronUp size={14} /> Show less</>
            )}
          </button>
        )}
        <div className="message-footer">
          <div className="message-actions">
            <button className="message-action-btn" onClick={handleCopyMessage} title="Copy markdown">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "Copied" : "Copy"}
            </button>
            {!isBot && onRetry && (
              <button className="message-action-btn" onClick={() => onRetry(message)} title="Retry message">
                <RotateCcw size={13} />
                Retry
              </button>
            )}
            {isBot && (
              <button className="message-action-btn" onClick={handleDownloadMessage} title="Download markdown">
                {downloaded ? <Check size={13} /> : <FileDown size={13} />}
                {downloaded ? "Saved" : "Download"}
              </button>
            )}
          </div>
          <span className="message-time">{time}</span>
        </div>
      </div>
      {imagePreview && (
        <div className="message-image-modal-overlay" onClick={handleCloseImagePreview}>
          <div ref={imagePreviewModalRef} className="message-image-modal" onClick={(event) => event.stopPropagation()}>
            <div className="message-image-modal-toolbar">
              <button
                type="button"
                className="message-image-modal-tool"
                onClick={handleZoomOut}
                title="Zoom out"
                disabled={imagePreviewZoom <= IMAGE_PREVIEW_MIN_ZOOM}
              >
                <ZoomOut size={16} />
              </button>
              <button
                type="button"
                className="message-image-modal-zoom-value"
                onClick={handleZoomReset}
                title="Reset zoom"
              >
                {Math.round(imagePreviewTargetZoom * 100)}%
              </button>
              <button
                type="button"
                className="message-image-modal-tool"
                onClick={handleZoomIn}
                title="Zoom in"
                disabled={imagePreviewZoom >= IMAGE_PREVIEW_MAX_ZOOM}
              >
                <ZoomIn size={16} />
              </button>
            </div>
            <button
              type="button"
              className="message-image-modal-close"
              onClick={handleCloseImagePreview}
              title="Close image preview"
            >
              <X size={18} />
            </button>
            <div
              ref={imagePreviewViewportRef}
              className={`message-image-modal-viewport ${isImagePreviewDragging ? "message-image-modal-viewport-dragging" : isImagePreviewPannable ? "message-image-modal-viewport-pannable" : ""}`}
              onMouseDown={handleImagePreviewMouseDown}
            >
              <div
                className="message-image-modal-stage"
                style={imagePreviewMetrics ? {
                  width: `${imagePreviewMetrics.stageWidth}px`,
                  height: `${imagePreviewMetrics.stageHeight}px`,
                } : undefined}
              >
                <img
                  className="message-image-modal-image"
                  src={imagePreview.source}
                  alt={imagePreview.alt}
                  onDragStart={(event) => event.preventDefault()}
                  onLoad={(event) => {
                    setImagePreviewNaturalSize({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                  }}
                  style={imagePreviewMetrics ? {
                    width: `${imagePreviewMetrics.renderWidth}px`,
                    height: `${imagePreviewMetrics.renderHeight}px`,
                  } : undefined}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const MemoizedMessageBubble = memo(
  MessageBubble,
  (prev, next) =>
    prev.message === next.message &&
    prev.isSearchMatch === next.isSearchMatch &&
    prev.isCurrentMatch === next.isCurrentMatch &&
    prev.onRetry === next.onRetry,
);

BotMessageMarkdown.displayName = "BotMessageMarkdown";
MessageBubble.displayName = "MessageBubble";
MemoizedMessageBubble.displayName = "MemoizedMessageBubble";

export default MemoizedMessageBubble;
