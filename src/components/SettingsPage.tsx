import { useState, useEffect, useCallback, useRef } from "react";
import { Eye, EyeOff } from "lucide-react";
import { getConfig, saveConfig, getChannelStatus, toggleChannel, listSkills, getSkill, saveSkill, deleteSkill, readSoul, saveSoul } from "../lib/tauri-api";
import type { ConfigDto, ChannelStatus, SkillDto, SkillDetailDto } from "../types";

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

type SettingsTab =
  | "provider"
  | "skills"
  | "session"
  | "paths"
  | "advanced"
  | "ch:telegram"
  | "ch:discord"
  | "ch:slack"
  | "ch:feishu"
  | "ch:web";

const CHANNELS: { key: string; label: string }[] = [
  { key: "telegram", label: "Telegram" },
  { key: "discord", label: "Discord" },
  { key: "slack", label: "Slack" },
  { key: "feishu", label: "Feishu / Lark" },
  { key: "web", label: "Web UI" },
];

interface SettingsPageProps {
  onBack: () => void;
  onSaved: () => void;
}

// ---- Password field with Eye toggle ----
function PasswordField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible(!visible)}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

// ---- Validation ----
interface ValidationErrors {
  [key: string]: string;
}

function validate(config: ConfigDto): ValidationErrors {
  const errs: ValidationErrors = {};
  if (config.max_tokens < 1) errs.max_tokens = "Must be at least 1";
  if (config.max_tool_iterations < 1) errs.max_tool_iterations = "Must be at least 1";
  if (config.max_history_messages < 1) errs.max_history_messages = "Must be at least 1";
  if (config.max_session_messages < 1) errs.max_session_messages = "Must be at least 1";
  if (config.memory_token_budget < 1) errs.memory_token_budget = "Must be at least 1";
  if (config.llm_base_url && !/^https?:\/\/.+/.test(config.llm_base_url)) {
    errs.llm_base_url = "Must be a valid URL (http:// or https://)";
  }
  if (!config.data_dir.trim()) errs.data_dir = "Required";
  if (!config.working_dir.trim()) errs.working_dir = "Required";
  return errs;
}

export default function SettingsPage({ onBack, onSaved }: SettingsPageProps) {
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [channelStatuses, setChannelStatuses] = useState<ChannelStatus[]>([]);
  const [activeTab, setActiveTab] = useState<SettingsTab>("provider");
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const initialConfigRef = useRef<string>("");
  const [darkMode, setDarkMode] = useState(() => {
    return document.documentElement.getAttribute("data-theme") === "dark";
  });

  // Skills state
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetailDto | null>(null);
  const [skillEditing, setSkillEditing] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", description: "", platforms: "", deps: "", content: "" });
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);

  // Soul state
  const [soulContent, setSoulContent] = useState("");
  const [soulOriginal, setSoulOriginal] = useState("");
  const [soulPath, setSoulPath] = useState("");
  const [soulSaving, setSoulSaving] = useState(false);
  const [soulSaved, setSoulSaved] = useState(false);

  const isDirty = config ? JSON.stringify(config) !== initialConfigRef.current : false;

  const fetchStatuses = useCallback(() => {
    getChannelStatus().then(setChannelStatuses).catch(() => {});
  }, []);

  useEffect(() => {
    getConfig().then((c) => {
      setConfig(c);
      initialConfigRef.current = JSON.stringify(c);
    });
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 5000);
    return () => clearInterval(interval);
  }, [fetchStatuses]);

  const update = <K extends keyof ConfigDto>(key: K, value: ConfigDto[K]) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      setValidationErrors(validate(next));
      return next;
    });
    setSuccess(false);
    setError(null);
  };

  const handleSave = async () => {
    if (!config) return;
    const errs = validate(config);
    setValidationErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await saveConfig(config);
      setSuccess(true);
      initialConfigRef.current = JSON.stringify(config);
      onSaved();
      setTimeout(fetchStatuses, 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if (isDirty) {
      if (!window.confirm("You have unsaved changes. Discard and leave?")) return;
    }
    onBack();
  };

  if (!config) {
    return (
      <main className="settings-page">
        <p style={{ color: "var(--muted)" }}>Loading...</p>
      </main>
    );
  }

  const statusOf = (name: string) => channelStatuses.find((s) => s.name === name);
  const fieldErr = (key: string) => validationErrors[key];
  const hasErrors = Object.keys(validationErrors).length > 0;

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      await toggleChannel(name, enabled);
      setTimeout(fetchStatuses, 500);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDarkMode = (enabled: boolean) => {
    setDarkMode(enabled);
    document.documentElement.setAttribute("data-theme", enabled ? "dark" : "light");
    localStorage.setItem("rayclaw-theme", enabled ? "dark" : "light");
  };

  // Skills handlers
  const fetchSkills = useCallback(() => {
    listSkills().then(setSkills).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab === "skills") fetchSkills();
  }, [activeTab, fetchSkills]);

  const handleSelectSkill = async (name: string) => {
    setSkillError(null);
    setSkillEditing(false);
    try {
      const detail = await getSkill(name);
      setSelectedSkill(detail);
    } catch (e) {
      setSkillError(String(e));
    }
  };

  const handleNewSkill = () => {
    setSelectedSkill(null);
    setSkillEditing(true);
    setSkillForm({ name: "", description: "", platforms: "", deps: "", content: "" });
    setSkillError(null);
  };

  const handleEditSkill = () => {
    if (!selectedSkill) return;
    setSkillEditing(true);
    setSkillForm({
      name: selectedSkill.meta.name,
      description: selectedSkill.meta.description,
      platforms: selectedSkill.meta.platforms.join(", "),
      deps: selectedSkill.meta.deps.join(", "),
      content: selectedSkill.content,
    });
    setSkillError(null);
  };

  const handleSaveSkill = async () => {
    setSkillSaving(true);
    setSkillError(null);
    try {
      const platforms = skillForm.platforms.split(",").map((s) => s.trim()).filter(Boolean);
      const deps = skillForm.deps.split(",").map((s) => s.trim()).filter(Boolean);
      await saveSkill(skillForm.name, skillForm.description, platforms, deps, skillForm.content);
      setSkillEditing(false);
      fetchSkills();
      const detail = await getSkill(skillForm.name);
      setSelectedSkill(detail);
    } catch (e) {
      setSkillError(String(e));
    } finally {
      setSkillSaving(false);
    }
  };

  const handleDeleteSkill = async (name: string) => {
    if (!window.confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    setSkillError(null);
    try {
      await deleteSkill(name);
      setSelectedSkill(null);
      setSkillEditing(false);
      fetchSkills();
    } catch (e) {
      setSkillError(String(e));
    }
  };

  // Soul handlers
  const fetchSoul = useCallback(() => {
    readSoul().then((s) => {
      setSoulContent(s.content);
      setSoulOriginal(s.content);
      setSoulPath(s.path);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab === "advanced") fetchSoul();
  }, [activeTab, fetchSoul]);

  const handleSaveSoul = async () => {
    setSoulSaving(true);
    setSoulSaved(false);
    try {
      await saveSoul(soulContent);
      setSoulOriginal(soulContent);
      setSoulSaved(true);
      setTimeout(() => setSoulSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSoulSaving(false);
    }
  };

  const soulDirty = soulContent !== soulOriginal;

  const isBedrock = config.llm_provider === "bedrock";
  const isChannelTab = activeTab.startsWith("ch:");
  const runningCount = channelStatuses.filter((s) => s.running).length;

  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
  };

  const toggleChannelsOpen = () => {
    if (channelsOpen) {
      setChannelsOpen(false);
    } else {
      setChannelsOpen(true);
      setActiveTab("ch:telegram");
    }
  };

  const selectChannel = (key: string) => {
    setActiveTab(`ch:${key}` as SettingsTab);
    setChannelsOpen(true);
  };

  const StatusDot = ({ name }: { name: string }) => {
    const st = statusOf(name);
    if (st?.running) return <span className="nav-dot nav-dot-running" />;
    if (st?.configured) return <span className="nav-dot nav-dot-stopped" />;
    return null;
  };

  return (
    <main className="settings-page">
      <div className="settings-header">
        <button className="btn-back" onClick={handleBack}>
          &larr; Back
        </button>
        <h1>Settings</h1>
        <div className="settings-header-actions">
          {error && <span className="settings-error">{error}</span>}
          {success && <span className="settings-success">Saved</span>}
          {isDirty && !success && <span className="settings-dirty">Unsaved</span>}
          <button className="btn-save" onClick={handleSave} disabled={saving || hasErrors}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="settings-split">
        {/* Left nav */}
        <nav className="settings-nav">
          <button
            className={`settings-nav-item ${activeTab === "provider" ? "settings-nav-active" : ""}`}
            onClick={() => selectTab("provider")}
          >
            AI Provider
          </button>

          <button
            className={`settings-nav-item ${activeTab === "skills" ? "settings-nav-active" : ""}`}
            onClick={() => { selectTab("skills"); fetchSkills(); }}
          >
            Skills
            {skills.length > 0 && <span className="nav-badge">{skills.length}</span>}
          </button>

          <button
            className={`settings-nav-item settings-nav-group ${isChannelTab ? "settings-nav-active" : ""}`}
            onClick={toggleChannelsOpen}
          >
            <span>Channels</span>
            <span className="nav-group-right">
              {runningCount > 0 && <span className="nav-badge">{runningCount}</span>}
              <span className={`nav-arrow ${channelsOpen ? "nav-arrow-open" : ""}`}>&#9654;</span>
            </span>
          </button>
          {channelsOpen && (
            <div className="settings-nav-children">
              {CHANNELS.map((ch) => (
                <button
                  key={ch.key}
                  className={`settings-nav-item settings-nav-child ${activeTab === `ch:${ch.key}` ? "settings-nav-active" : ""}`}
                  onClick={() => selectChannel(ch.key)}
                >
                  <StatusDot name={ch.key} />
                  {ch.label}
                </button>
              ))}
            </div>
          )}

          <button
            className={`settings-nav-item ${activeTab === "session" ? "settings-nav-active" : ""}`}
            onClick={() => selectTab("session")}
          >
            Session
          </button>
          <button
            className={`settings-nav-item ${activeTab === "paths" ? "settings-nav-active" : ""}`}
            onClick={() => selectTab("paths")}
          >
            Paths
          </button>
          <button
            className={`settings-nav-item ${activeTab === "advanced" ? "settings-nav-active" : ""}`}
            onClick={() => selectTab("advanced")}
          >
            Advanced
          </button>
        </nav>

        {/* Right panel */}
        <div className="settings-panel">
          {/* AI Provider */}
          {activeTab === "provider" && (
            <div className="settings-panel-content">
              <h2>AI Provider</h2>

              <label className="settings-field">
                <span>Provider</span>
                <select
                  value={config.llm_provider}
                  onChange={(e) => update("llm_provider", e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>

              <label className="settings-field">
                <span>API Key</span>
                <PasswordField
                  value={config.api_key}
                  onChange={(v) => update("api_key", v)}
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

              <label className={`settings-field ${fieldErr("llm_base_url") ? "settings-field-error" : ""}`}>
                <span>Base URL (optional)</span>
                <input
                  type="text"
                  value={config.llm_base_url ?? ""}
                  onChange={(e) => update("llm_base_url", e.target.value || null)}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              {fieldErr("llm_base_url") && <p className="field-error">{fieldErr("llm_base_url")}</p>}

              <label className={`settings-field ${fieldErr("max_tokens") ? "settings-field-error" : ""}`}>
                <span>Max Tokens</span>
                <input
                  type="number"
                  value={config.max_tokens}
                  onChange={(e) => update("max_tokens", Number(e.target.value) || 0)}
                  min={1}
                />
              </label>
              {fieldErr("max_tokens") && <p className="field-error">{fieldErr("max_tokens")}</p>}

              <label className="settings-field settings-toggle">
                <span>Show Thinking</span>
                <input
                  type="checkbox"
                  checked={config.show_thinking}
                  onChange={(e) => update("show_thinking", e.target.checked)}
                />
              </label>

              {isBedrock && (
                <>
                  <div className="settings-divider" />
                  <h3>AWS Bedrock</h3>

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
                    <PasswordField
                      value={config.aws_access_key_id ?? ""}
                      onChange={(v) => update("aws_access_key_id", v || null)}
                    />
                  </label>

                  <label className="settings-field">
                    <span>Secret Access Key</span>
                    <PasswordField
                      value={config.aws_secret_access_key ?? ""}
                      onChange={(v) => update("aws_secret_access_key", v || null)}
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
                </>
              )}
            </div>
          )}

          {/* Skills */}
          {activeTab === "skills" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Skills</h2>
                <div className="channel-panel-status">
                  <button className="btn-save" style={{ fontSize: 12, padding: "4px 12px" }} onClick={handleNewSkill}>
                    + New Skill
                  </button>
                </div>
              </div>

              {skillError && <p className="field-error" style={{ marginBottom: 12 }}>{skillError}</p>}

              {/* Skill editor */}
              {skillEditing && (
                <div className="skill-editor">
                  <label className="settings-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={skillForm.name}
                      onChange={(e) => setSkillForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="my-skill"
                      disabled={!!selectedSkill}
                    />
                  </label>
                  <label className="settings-field">
                    <span>Description</span>
                    <input
                      type="text"
                      value={skillForm.description}
                      onChange={(e) => setSkillForm((f) => ({ ...f, description: e.target.value }))}
                      placeholder="What this skill does..."
                    />
                  </label>
                  <label className="settings-field">
                    <span>Platforms (comma-separated)</span>
                    <input
                      type="text"
                      value={skillForm.platforms}
                      onChange={(e) => setSkillForm((f) => ({ ...f, platforms: e.target.value }))}
                      placeholder="linux, darwin, windows (empty = all)"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Dependencies (comma-separated)</span>
                    <input
                      type="text"
                      value={skillForm.deps}
                      onChange={(e) => setSkillForm((f) => ({ ...f, deps: e.target.value }))}
                      placeholder="curl, python3 (empty = none)"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Instructions (Markdown)</span>
                    <textarea
                      className="skill-content-editor"
                      value={skillForm.content}
                      onChange={(e) => setSkillForm((f) => ({ ...f, content: e.target.value }))}
                      rows={12}
                      placeholder="# How to use this skill&#10;&#10;Step-by-step instructions..."
                    />
                  </label>
                  <div className="skill-editor-actions">
                    <button className="btn-save" onClick={handleSaveSkill} disabled={skillSaving || !skillForm.name.trim()}>
                      {skillSaving ? "Saving..." : "Save"}
                    </button>
                    <button className="btn-back" onClick={() => setSkillEditing(false)}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Skill detail view */}
              {!skillEditing && selectedSkill && (
                <div className="skill-detail">
                  <div className="skill-detail-header">
                    <h3>{selectedSkill.meta.name}</h3>
                    <div className="skill-detail-actions">
                      <button className="btn-back" style={{ fontSize: 12 }} onClick={handleEditSkill}>Edit</button>
                      <button className="btn-back" style={{ fontSize: 12, color: "var(--error)" }} onClick={() => handleDeleteSkill(selectedSkill.meta.name)}>Delete</button>
                    </div>
                  </div>
                  <p className="skill-description">{selectedSkill.meta.description}</p>
                  <div className="skill-meta-tags">
                    {selectedSkill.meta.available
                      ? <span className="skill-tag skill-tag-available">Available</span>
                      : <span className="skill-tag skill-tag-unavailable" title={selectedSkill.meta.unavailable_reason ?? ""}>Unavailable</span>
                    }
                    <span className="skill-tag">{selectedSkill.meta.source}</span>
                    {selectedSkill.meta.platforms.length > 0 && (
                      <span className="skill-tag">{selectedSkill.meta.platforms.join(", ")}</span>
                    )}
                    {selectedSkill.meta.deps.length > 0 && (
                      <span className="skill-tag">deps: {selectedSkill.meta.deps.join(", ")}</span>
                    )}
                    {selectedSkill.meta.version && (
                      <span className="skill-tag">v{selectedSkill.meta.version}</span>
                    )}
                  </div>
                  {selectedSkill.meta.unavailable_reason && (
                    <p className="skill-unavailable-reason">{selectedSkill.meta.unavailable_reason}</p>
                  )}
                  <pre className="skill-content-preview">{selectedSkill.content}</pre>
                </div>
              )}

              {/* Skill list */}
              {!skillEditing && !selectedSkill && (
                <div className="skill-list">
                  {skills.length === 0 && (
                    <p className="settings-hint">No skills found. Click "+ New Skill" to create one.</p>
                  )}
                  {skills.map((s) => (
                    <button
                      key={s.name}
                      className={`skill-list-item ${!s.available ? "skill-list-item-unavailable" : ""}`}
                      onClick={() => handleSelectSkill(s.name)}
                    >
                      <div className="skill-list-item-header">
                        <span className="skill-list-item-name">{s.name}</span>
                        <span className={`skill-list-item-dot ${s.available ? "skill-dot-available" : "skill-dot-unavailable"}`} />
                      </div>
                      <span className="skill-list-item-desc">{s.description.slice(0, 80)}{s.description.length > 80 ? "..." : ""}</span>
                      <span className="skill-list-item-source">{s.source}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Telegram */}
          {activeTab === "ch:telegram" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Telegram</h2>
                <div className="channel-panel-status">
                  {statusOf("telegram")?.running && <span className="status-pill status-running">Running</span>}
                  {statusOf("telegram")?.configured && !statusOf("telegram")?.running && <span className="status-pill status-stopped">Stopped</span>}
                  {statusOf("telegram")?.configured && (
                    <label className="channel-switch">
                      <input
                        type="checkbox"
                        checked={statusOf("telegram")?.enabled ?? true}
                        onChange={(e) => handleToggle("telegram", e.target.checked)}
                      />
                      <span className="switch-slider" />
                    </label>
                  )}
                </div>
              </div>

              <label className="settings-field">
                <span>Bot Token</span>
                <PasswordField
                  value={config.telegram_bot_token}
                  onChange={(v) => update("telegram_bot_token", v)}
                  placeholder="123456:ABC-DEF..."
                />
              </label>
              <label className="settings-field">
                <span>Bot Username</span>
                <input
                  type="text"
                  value={config.bot_username}
                  onChange={(e) => update("bot_username", e.target.value)}
                  placeholder="my_bot"
                />
              </label>
            </div>
          )}

          {/* Discord */}
          {activeTab === "ch:discord" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Discord</h2>
                <div className="channel-panel-status">
                  {statusOf("discord")?.running && <span className="status-pill status-running">Running</span>}
                  {statusOf("discord")?.configured && !statusOf("discord")?.running && <span className="status-pill status-stopped">Stopped</span>}
                  {statusOf("discord")?.configured && (
                    <label className="channel-switch">
                      <input
                        type="checkbox"
                        checked={statusOf("discord")?.enabled ?? true}
                        onChange={(e) => handleToggle("discord", e.target.checked)}
                      />
                      <span className="switch-slider" />
                    </label>
                  )}
                </div>
              </div>

              <label className="settings-field">
                <span>Bot Token</span>
                <PasswordField
                  value={config.discord_bot_token ?? ""}
                  onChange={(v) => update("discord_bot_token", v || null)}
                  placeholder="Discord bot token"
                />
              </label>
            </div>
          )}

          {/* Slack */}
          {activeTab === "ch:slack" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Slack</h2>
                <div className="channel-panel-status">
                  {statusOf("slack")?.running && <span className="status-pill status-running">Running</span>}
                  {statusOf("slack")?.configured && !statusOf("slack")?.running && <span className="status-pill status-stopped">Stopped</span>}
                  {statusOf("slack")?.configured && (
                    <label className="channel-switch">
                      <input
                        type="checkbox"
                        checked={statusOf("slack")?.enabled ?? true}
                        onChange={(e) => handleToggle("slack", e.target.checked)}
                      />
                      <span className="switch-slider" />
                    </label>
                  )}
                </div>
              </div>

              <label className="settings-field">
                <span>Bot Token</span>
                <PasswordField
                  value={config.slack_bot_token ?? ""}
                  onChange={(v) => update("slack_bot_token", v || null)}
                  placeholder="xoxb-..."
                />
              </label>
              <label className="settings-field">
                <span>App Token</span>
                <PasswordField
                  value={config.slack_app_token ?? ""}
                  onChange={(v) => update("slack_app_token", v || null)}
                  placeholder="xapp-..."
                />
              </label>
            </div>
          )}

          {/* Feishu */}
          {activeTab === "ch:feishu" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Feishu / Lark</h2>
                <div className="channel-panel-status">
                  {statusOf("feishu")?.running && <span className="status-pill status-running">Running</span>}
                  {statusOf("feishu")?.configured && !statusOf("feishu")?.running && <span className="status-pill status-stopped">Stopped</span>}
                  {statusOf("feishu")?.configured && (
                    <label className="channel-switch">
                      <input
                        type="checkbox"
                        checked={statusOf("feishu")?.enabled ?? true}
                        onChange={(e) => handleToggle("feishu", e.target.checked)}
                      />
                      <span className="switch-slider" />
                    </label>
                  )}
                </div>
              </div>

              <label className="settings-field">
                <span>App ID</span>
                <input
                  type="text"
                  value={config.feishu_app_id ?? ""}
                  onChange={(e) => update("feishu_app_id", e.target.value || null)}
                  placeholder="cli_xxx"
                />
              </label>
              <label className="settings-field">
                <span>App Secret</span>
                <PasswordField
                  value={config.feishu_app_secret ?? ""}
                  onChange={(v) => update("feishu_app_secret", v || null)}
                />
              </label>
            </div>
          )}

          {/* Web UI */}
          {activeTab === "ch:web" && (
            <div className="settings-panel-content">
              <div className="channel-panel-header">
                <h2>Web UI</h2>
                <div className="channel-panel-status">
                  <label className="channel-switch">
                    <input
                      type="checkbox"
                      checked={config.web_enabled}
                      onChange={(e) => update("web_enabled", e.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
              </div>
              <p className="settings-hint">
                Enable the built-in Web UI served by the agent at runtime.
              </p>
            </div>
          )}

          {/* Session */}
          {activeTab === "session" && (
            <div className="settings-panel-content">
              <h2>Session</h2>

              <label className={`settings-field ${fieldErr("max_tool_iterations") ? "settings-field-error" : ""}`}>
                <span>Max Tool Iterations</span>
                <input
                  type="number"
                  value={config.max_tool_iterations}
                  onChange={(e) => update("max_tool_iterations", Number(e.target.value) || 0)}
                  min={1}
                />
              </label>
              {fieldErr("max_tool_iterations") && <p className="field-error">{fieldErr("max_tool_iterations")}</p>}

              <label className={`settings-field ${fieldErr("max_history_messages") ? "settings-field-error" : ""}`}>
                <span>Max History Messages</span>
                <input
                  type="number"
                  value={config.max_history_messages}
                  onChange={(e) => update("max_history_messages", Number(e.target.value) || 0)}
                  min={1}
                />
              </label>
              {fieldErr("max_history_messages") && <p className="field-error">{fieldErr("max_history_messages")}</p>}

              <label className={`settings-field ${fieldErr("max_session_messages") ? "settings-field-error" : ""}`}>
                <span>Max Session Messages</span>
                <input
                  type="number"
                  value={config.max_session_messages}
                  onChange={(e) => update("max_session_messages", Number(e.target.value) || 0)}
                  min={1}
                />
              </label>
              {fieldErr("max_session_messages") && <p className="field-error">{fieldErr("max_session_messages")}</p>}
            </div>
          )}

          {/* Paths */}
          {activeTab === "paths" && (
            <div className="settings-panel-content">
              <h2>Paths</h2>

              <label className={`settings-field ${fieldErr("data_dir") ? "settings-field-error" : ""}`}>
                <span>Data Directory</span>
                <input
                  type="text"
                  value={config.data_dir}
                  onChange={(e) => update("data_dir", e.target.value)}
                />
              </label>
              {fieldErr("data_dir") && <p className="field-error">{fieldErr("data_dir")}</p>}

              <label className={`settings-field ${fieldErr("working_dir") ? "settings-field-error" : ""}`}>
                <span>Working Directory</span>
                <input
                  type="text"
                  value={config.working_dir}
                  onChange={(e) => update("working_dir", e.target.value)}
                />
              </label>
              {fieldErr("working_dir") && <p className="field-error">{fieldErr("working_dir")}</p>}

              <label className="settings-field">
                <span>Timezone</span>
                <input
                  type="text"
                  value={config.timezone}
                  onChange={(e) => update("timezone", e.target.value)}
                  placeholder="UTC"
                />
              </label>
            </div>
          )}

          {/* Advanced */}
          {activeTab === "advanced" && (
            <div className="settings-panel-content">
              <h2>Advanced</h2>

              <h3>Appearance</h3>
              <label className="settings-field settings-toggle">
                <span>Dark Mode</span>
                <input
                  type="checkbox"
                  checked={darkMode}
                  onChange={(e) => handleDarkMode(e.target.checked)}
                />
              </label>

              <div className="settings-divider" />
              <h3>Agent</h3>

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

              <label className={`settings-field ${fieldErr("memory_token_budget") ? "settings-field-error" : ""}`}>
                <span>Memory Token Budget</span>
                <input
                  type="number"
                  value={config.memory_token_budget}
                  onChange={(e) => update("memory_token_budget", Number(e.target.value) || 0)}
                  min={1}
                />
              </label>
              {fieldErr("memory_token_budget") && <p className="field-error">{fieldErr("memory_token_budget")}</p>}

              <div className="settings-divider" />
              <div className="soul-editor-section">
                <div className="soul-editor-header">
                  <h3>Personality (SOUL.md)</h3>
                  <div className="soul-editor-actions">
                    {soulSaved && <span className="settings-success">Saved</span>}
                    {soulDirty && !soulSaved && <span className="settings-dirty">Unsaved</span>}
                    <button
                      className="btn-save"
                      style={{ fontSize: 12, padding: "4px 12px" }}
                      onClick={handleSaveSoul}
                      disabled={soulSaving || !soulDirty}
                    >
                      {soulSaving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
                <p className="settings-hint">
                  Define the bot's personality, values, and communication style. This is injected into the system prompt for all conversations.
                </p>
                <textarea
                  className="soul-editor-textarea"
                  value={soulContent}
                  onChange={(e) => { setSoulContent(e.target.value); setSoulSaved(false); }}
                  rows={14}
                  placeholder={"# Personality\n\nYou are a helpful assistant...\n\n# Communication Style\n\n- Be concise and clear\n- Use a friendly tone"}
                />
                <p className="settings-hint" style={{ marginTop: 6 }}>
                  {soulPath}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
