import { useState, useEffect } from "react";
import { getConfig, saveConfig } from "../lib/tauri-api";
import type { ConfigDto } from "../types";

const PROVIDERS = [
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "google",
  "deepseek",
  "openrouter",
  "mistral",
  "alibaba",
  "moonshot",
  "xai",
  "custom",
];

interface SettingsPageProps {
  onBack: () => void;
  onSaved: () => void;
}

export default function SettingsPage({ onBack, onSaved }: SettingsPageProps) {
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig);
  }, []);

  const update = <K extends keyof ConfigDto>(key: K, value: ConfigDto[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSuccess(false);
    setError(null);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await saveConfig(config);
      setSuccess(true);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <main className="settings-page">
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </main>
    );
  }

  const isBedrock = config.llm_provider === "bedrock";

  return (
    <main className="settings-page">
      <div className="settings-header">
        <button className="btn-back" onClick={onBack}>
          ← Back
        </button>
        <h1>Settings</h1>
      </div>

      <div className="settings-body">
        {/* Model Section */}
        <section className="settings-section">
          <h2>Model</h2>

          <label className="settings-field">
            <span>Provider</span>
            <select
              value={config.llm_provider}
              onChange={(e) => update("llm_provider", e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>API Key</span>
            <input
              type="password"
              value={config.api_key}
              onChange={(e) => update("api_key", e.target.value)}
              placeholder="sk-..."
            />
          </label>

          <label className="settings-field">
            <span>Model</span>
            <input
              type="text"
              value={config.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="Leave empty for provider default"
            />
          </label>

          <label className="settings-field">
            <span>Base URL (optional)</span>
            <input
              type="text"
              value={config.llm_base_url ?? ""}
              onChange={(e) =>
                update("llm_base_url", e.target.value || null)
              }
              placeholder="https://api.example.com/v1"
            />
          </label>

          <label className="settings-field">
            <span>Max Tokens</span>
            <input
              type="number"
              value={config.max_tokens}
              onChange={(e) => update("max_tokens", Number(e.target.value) || 8192)}
              min={1}
            />
          </label>

          <label className="settings-field settings-toggle">
            <span>Show Thinking</span>
            <input
              type="checkbox"
              checked={config.show_thinking}
              onChange={(e) => update("show_thinking", e.target.checked)}
            />
          </label>
        </section>

        {/* AWS Bedrock Section */}
        {isBedrock && (
          <section className="settings-section">
            <h2>AWS Bedrock</h2>

            <label className="settings-field">
              <span>Region</span>
              <input
                type="text"
                value={config.aws_region ?? ""}
                onChange={(e) => update("aws_region", e.target.value || null)}
                placeholder="us-east-1"
              />
            </label>

            <label className="settings-field">
              <span>Access Key ID</span>
              <input
                type="password"
                value={config.aws_access_key_id ?? ""}
                onChange={(e) =>
                  update("aws_access_key_id", e.target.value || null)
                }
              />
            </label>

            <label className="settings-field">
              <span>Secret Access Key</span>
              <input
                type="password"
                value={config.aws_secret_access_key ?? ""}
                onChange={(e) =>
                  update("aws_secret_access_key", e.target.value || null)
                }
              />
            </label>

            <label className="settings-field">
              <span>Profile (optional)</span>
              <input
                type="text"
                value={config.aws_profile ?? ""}
                onChange={(e) => update("aws_profile", e.target.value || null)}
                placeholder="default"
              />
            </label>
          </section>
        )}

        {/* Session Section */}
        <section className="settings-section">
          <h2>Session</h2>

          <label className="settings-field">
            <span>Max Tool Iterations</span>
            <input
              type="number"
              value={config.max_tool_iterations}
              onChange={(e) =>
                update("max_tool_iterations", Number(e.target.value) || 100)
              }
              min={1}
            />
          </label>

          <label className="settings-field">
            <span>Max History Messages</span>
            <input
              type="number"
              value={config.max_history_messages}
              onChange={(e) =>
                update("max_history_messages", Number(e.target.value) || 50)
              }
              min={1}
            />
          </label>

          <label className="settings-field">
            <span>Max Session Messages</span>
            <input
              type="number"
              value={config.max_session_messages}
              onChange={(e) =>
                update("max_session_messages", Number(e.target.value) || 40)
              }
              min={1}
            />
          </label>
        </section>

        {/* Paths Section */}
        <section className="settings-section">
          <h2>Paths</h2>

          <label className="settings-field">
            <span>Data Directory</span>
            <input
              type="text"
              value={config.data_dir}
              onChange={(e) => update("data_dir", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Working Directory</span>
            <input
              type="text"
              value={config.working_dir}
              onChange={(e) => update("working_dir", e.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>Timezone</span>
            <input
              type="text"
              value={config.timezone}
              onChange={(e) => update("timezone", e.target.value)}
              placeholder="UTC"
            />
          </label>
        </section>

        {/* Advanced Section */}
        <section className="settings-section">
          <h2>Advanced</h2>

          <label className="settings-field settings-toggle">
            <span>Skip Tool Approval</span>
            <input
              type="checkbox"
              checked={config.skip_tool_approval}
              onChange={(e) => update("skip_tool_approval", e.target.checked)}
            />
          </label>

          <label className="settings-field settings-toggle">
            <span>Memory Reflector</span>
            <input
              type="checkbox"
              checked={config.reflector_enabled}
              onChange={(e) => update("reflector_enabled", e.target.checked)}
            />
          </label>

          <label className="settings-field">
            <span>Memory Token Budget</span>
            <input
              type="number"
              value={config.memory_token_budget}
              onChange={(e) =>
                update("memory_token_budget", Number(e.target.value) || 1500)
              }
              min={1}
            />
          </label>

          <label className="settings-field">
            <span>Soul Path (optional)</span>
            <input
              type="text"
              value={config.soul_path ?? ""}
              onChange={(e) => update("soul_path", e.target.value || null)}
              placeholder="Path to SOUL.md"
            />
          </label>
        </section>
      </div>

      <div className="settings-footer">
        {error && <p className="settings-error">{error}</p>}
        {success && <p className="settings-success">Saved and agent reinitialized.</p>}
        <button className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </main>
  );
}
