import { useState } from "react";

interface ToolStepProps {
  name: string;
  isError?: boolean;
  preview?: string;
  durationMs?: number;
  isRunning?: boolean;
}

export default function ToolStep({ name, isError, preview, durationMs, isRunning }: ToolStepProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`tool-step ${isError ? "tool-step-error" : ""}`}>
      <div className="tool-step-header" onClick={() => preview && setExpanded(!expanded)}>
        <span className="tool-step-icon">
          {isRunning ? "⟳" : isError ? "✕" : "✓"}
        </span>
        <span className="tool-step-name">{name}</span>
        {durationMs !== undefined && (
          <span className="tool-step-duration">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        {preview && (
          <span className="tool-step-expand">{expanded ? "▾" : "▸"}</span>
        )}
      </div>
      {expanded && preview && (
        <pre className="tool-step-preview">{preview}</pre>
      )}
    </div>
  );
}
