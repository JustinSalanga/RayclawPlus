import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

interface ToolStepProps {
  name: string;
  isError?: boolean;
  preview?: string;
  durationMs?: number;
  isRunning?: boolean;
}

export default function ToolStep({ name, isError, preview, durationMs, isRunning }: ToolStepProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (preview && !isRunning) {
      setExpanded(true);
    }
  }, [isRunning, preview]);

  return (
    <div className={`tool-step ${isError ? "tool-step-error" : ""}`}>
      <div className="tool-step-header" onClick={() => preview && setExpanded(!expanded)}>
        <span className="tool-step-icon">
          {isRunning ? (
            <Loader2 size={14} className="tool-step-spinner" />
          ) : isError ? (
            <XCircle size={14} />
          ) : (
            <CheckCircle2 size={14} />
          )}
        </span>
        <span className="tool-step-name">{name}</span>
        {durationMs !== undefined && (
          <span className="tool-step-duration">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        {preview && (
          <span className="tool-step-expand">{expanded ? "\u25BE" : "\u25B8"}</span>
        )}
      </div>
      {expanded && preview && (
        <pre className="tool-step-preview">{preview}</pre>
      )}
    </div>
  );
}
