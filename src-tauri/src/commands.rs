use crate::state::DesktopState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tracing::{debug, error, info};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub ready: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSummaryDto {
    pub chat_id: i64,
    pub chat_title: Option<String>,
    pub chat_type: String,
    pub last_message_time: String,
    pub last_message_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredMessageDto {
    pub id: String,
    pub chat_id: i64,
    pub sender_name: String,
    pub content: String,
    pub is_from_bot: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AgentStreamPayload {
    #[serde(rename = "iteration")]
    Iteration { iteration: usize },
    #[serde(rename = "tool_start")]
    ToolStart { name: String },
    #[serde(rename = "tool_result")]
    ToolResult {
        name: String,
        is_error: bool,
        preview: String,
        duration_ms: u64,
    },
    #[serde(rename = "text_delta")]
    TextDelta { delta: String },
    #[serde(rename = "final_response")]
    FinalResponse { text: String },
}

/// Configuration DTO for the settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigDto {
    // Model
    pub llm_provider: String,
    pub api_key: String,
    pub model: String,
    pub llm_base_url: Option<String>,
    pub max_tokens: u32,
    pub show_thinking: bool,
    // AWS Bedrock
    pub aws_region: Option<String>,
    pub aws_access_key_id: Option<String>,
    pub aws_secret_access_key: Option<String>,
    pub aws_profile: Option<String>,
    // Session
    pub max_tool_iterations: usize,
    pub max_history_messages: usize,
    pub max_session_messages: usize,
    // Paths
    pub data_dir: String,
    pub working_dir: String,
    pub timezone: String,
    // Advanced
    pub skip_tool_approval: bool,
    pub soul_path: Option<String>,
    pub memory_token_budget: usize,
    pub reflector_enabled: bool,
    // Channels — Telegram
    pub telegram_bot_token: String,
    pub bot_username: String,
    // Channels — Discord
    pub discord_bot_token: Option<String>,
    // Channels — Slack
    pub slack_bot_token: Option<String>,
    pub slack_app_token: Option<String>,
    // Channels — Feishu
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    // Channels — Web
    pub web_enabled: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".into())
}

/// Expand leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", home_dir(), rest)
    } else if path == "~" {
        home_dir()
    } else {
        path.to_string()
    }
}

/// Create a default Config from a minimal YAML string with expanded paths.
fn default_config() -> rayclaw::config::Config {
    let home = home_dir();
    let yaml = format!(
        r#"
llm_provider: anthropic
api_key: ""
model: ""
data_dir: "{home}/.rayclaw/data"
working_dir: "{home}/.rayclaw/tmp"
timezone: UTC
web_enabled: false
"#
    );
    serde_yaml::from_str(&yaml).expect("default config YAML is always valid")
}

fn mask_secret(s: &str) -> String {
    if s.len() <= 8 {
        "*".repeat(s.len())
    } else {
        format!("{}...{}", &s[..4], &s[s.len() - 4..])
    }
}

async fn require_agent(state: &DesktopState) -> Result<Arc<rayclaw::sdk::RayClawAgent>, String> {
    state
        .agent
        .read()
        .await
        .clone()
        .ok_or_else(|| "Agent not initialized. Please configure in Settings.".to_string())
}

fn default_config_path() -> String {
    let dir = format!("{}/.rayclaw", home_dir());
    let _ = std::fs::create_dir_all(&dir);
    format!("{dir}/rayclaw.config.yaml")
}

/// Extract a string from a channels YAML value.
fn channel_str(channels: &std::collections::HashMap<String, serde_yaml::Value>, channel: &str, key: &str) -> Option<String> {
    channels
        .get(channel)
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Commands: Status & Config
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_status(app: tauri::AppHandle) -> Result<AppStatus, String> {
    let state = app.state::<DesktopState>();
    let agent = state.agent.read().await;
    let error = state.init_error.read().await;
    Ok(AppStatus {
        ready: agent.is_some(),
        error: error.clone(),
    })
}

#[tauri::command]
pub async fn get_config(_app: tauri::AppHandle) -> Result<ConfigDto, String> {
    let config = rayclaw::config::Config::load().unwrap_or_else(|_| default_config());

    Ok(ConfigDto {
        llm_provider: config.llm_provider.clone(),
        api_key: if config.api_key.is_empty() {
            String::new()
        } else {
            mask_secret(&config.api_key)
        },
        model: config.model.clone(),
        llm_base_url: config.llm_base_url.clone(),
        max_tokens: config.max_tokens,
        show_thinking: config.show_thinking,
        aws_region: config.aws_region.clone(),
        aws_access_key_id: config.aws_access_key_id.as_ref().map(|s| mask_secret(s)),
        aws_secret_access_key: config.aws_secret_access_key.as_ref().map(|s| mask_secret(s)),
        aws_profile: config.aws_profile.clone(),
        max_tool_iterations: config.max_tool_iterations,
        max_history_messages: config.max_history_messages,
        max_session_messages: config.max_session_messages,
        data_dir: config.data_dir.clone(),
        working_dir: config.working_dir.clone(),
        timezone: config.timezone.clone(),
        skip_tool_approval: config.skip_tool_approval,
        soul_path: config.soul_path.clone(),
        memory_token_budget: config.memory_token_budget,
        reflector_enabled: config.reflector_enabled,
        // Channels — Telegram (legacy flat fields)
        telegram_bot_token: if config.telegram_bot_token.is_empty() {
            String::new()
        } else {
            mask_secret(&config.telegram_bot_token)
        },
        bot_username: config.bot_username.clone(),
        // Channels — Discord
        discord_bot_token: config.discord_bot_token.as_ref().map(|s| mask_secret(s)),
        // Channels — Slack (from channels map)
        slack_bot_token: channel_str(&config.channels, "slack", "bot_token").map(|s| mask_secret(&s)),
        slack_app_token: channel_str(&config.channels, "slack", "app_token").map(|s| mask_secret(&s)),
        // Channels — Feishu (from channels map)
        feishu_app_id: channel_str(&config.channels, "feishu", "app_id"),
        feishu_app_secret: channel_str(&config.channels, "feishu", "app_secret").map(|s| mask_secret(&s)),
        // Channels — Web
        web_enabled: config.web_enabled,
    })
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: ConfigDto) -> Result<(), String> {
    info!("save_config: provider={}, model={}", config.llm_provider, config.model);
    let mut full_config = rayclaw::config::Config::load().unwrap_or_else(|_| default_config());

    // Apply DTO fields (skip masked secrets — keep existing value if masked)
    full_config.llm_provider = config.llm_provider;
    if !config.api_key.is_empty() && !config.api_key.contains("...") && !config.api_key.contains("*") {
        full_config.api_key = config.api_key;
    }
    full_config.model = config.model;
    full_config.llm_base_url = config.llm_base_url;
    full_config.max_tokens = config.max_tokens;
    full_config.show_thinking = config.show_thinking;

    // AWS — only update if not masked
    full_config.aws_region = config.aws_region;
    if let Some(ref key) = config.aws_access_key_id {
        if !key.contains("...") && !key.contains("*") {
            full_config.aws_access_key_id = Some(key.clone());
        }
    } else {
        full_config.aws_access_key_id = None;
    }
    if let Some(ref key) = config.aws_secret_access_key {
        if !key.contains("...") && !key.contains("*") {
            full_config.aws_secret_access_key = Some(key.clone());
        }
    } else {
        full_config.aws_secret_access_key = None;
    }
    full_config.aws_profile = config.aws_profile;

    full_config.max_tool_iterations = config.max_tool_iterations;
    full_config.max_history_messages = config.max_history_messages;
    full_config.max_session_messages = config.max_session_messages;
    // Expand tilde in paths before saving
    full_config.data_dir = expand_tilde(&config.data_dir);
    full_config.working_dir = expand_tilde(&config.working_dir);
    full_config.timezone = config.timezone;
    full_config.skip_tool_approval = config.skip_tool_approval;
    full_config.soul_path = config.soul_path.map(|p| expand_tilde(&p));
    full_config.memory_token_budget = config.memory_token_budget;
    full_config.reflector_enabled = config.reflector_enabled;

    // Channels — Telegram
    if !config.telegram_bot_token.is_empty()
        && !config.telegram_bot_token.contains("...")
        && !config.telegram_bot_token.contains("*")
    {
        full_config.telegram_bot_token = config.telegram_bot_token;
    }
    full_config.bot_username = config.bot_username;

    // Channels — Discord
    if let Some(ref token) = config.discord_bot_token {
        if !token.contains("...") && !token.contains("*") {
            full_config.discord_bot_token = Some(token.clone());
        }
    } else {
        full_config.discord_bot_token = None;
    }

    // Channels — Slack (stored in channels map)
    apply_channel_secret(&mut full_config.channels, "slack", "bot_token", config.slack_bot_token);
    apply_channel_secret(&mut full_config.channels, "slack", "app_token", config.slack_app_token);

    // Channels — Feishu (stored in channels map)
    apply_channel_field(&mut full_config.channels, "feishu", "app_id", config.feishu_app_id);
    apply_channel_secret(&mut full_config.channels, "feishu", "app_secret", config.feishu_app_secret);

    // Channels — Web
    full_config.web_enabled = config.web_enabled;

    // Validate
    info!("save_config: validating config...");
    full_config
        .validate_for_sdk()
        .map_err(|e| {
            error!("save_config: validation failed: {e}");
            format!("Validation failed: {e}")
        })?;

    // Save to file
    let save_path = rayclaw::config::Config::resolve_config_path()
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(default_config_path);
    info!("save_config: saving to {save_path}");
    full_config
        .save_yaml(&save_path)
        .map_err(|e| {
            error!("save_config: failed to save: {e}");
            format!("Failed to save config: {e}")
        })?;

    // Log channel diagnostics after save
    crate::log_channel_diagnostics(&full_config);

    // Reinitialize agent on the stored runtime (separate from Tauri's)
    info!("save_config: reinitializing agent (SDK mode)...");
    let state = app.state::<DesktopState>();
    let rt_handle = state.runtime.handle().clone();
    let new_agent = rt_handle
        .spawn(async move {
            rayclaw::sdk::RayClawAgent::new(full_config).await
        })
        .await
        .map_err(|e| {
            error!("save_config: spawn task failed: {e}");
            format!("Task failed: {e}")
        })?
        .map_err(|e| {
            error!("save_config: agent init failed: {e}");
            format!("Failed to initialize agent: {e}")
        })?;

    info!("save_config: agent reinitialized successfully");

    {
        let mut agent_lock = state.agent.write().await;
        *agent_lock = Some(Arc::new(new_agent));
    }
    {
        let mut err_lock = state.init_error.write().await;
        *err_lock = None;
    }

    Ok(())
}

/// Apply a non-secret channel field to the channels map.
fn apply_channel_field(
    channels: &mut std::collections::HashMap<String, serde_yaml::Value>,
    channel: &str,
    key: &str,
    value: Option<String>,
) {
    if let Some(val) = value.filter(|s| !s.is_empty()) {
        let entry = channels
            .entry(channel.to_string())
            .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
        if let serde_yaml::Value::Mapping(ref mut map) = entry {
            map.insert(
                serde_yaml::Value::String(key.to_string()),
                serde_yaml::Value::String(val),
            );
        }
    }
}

/// Apply a secret channel field (skip if masked).
fn apply_channel_secret(
    channels: &mut std::collections::HashMap<String, serde_yaml::Value>,
    channel: &str,
    key: &str,
    value: Option<String>,
) {
    if let Some(ref val) = value {
        if val.contains("...") || val.contains("*") {
            return; // masked — keep existing
        }
    }
    apply_channel_field(channels, channel, key, value);
}

// ---------------------------------------------------------------------------
// Commands: Chat
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn send_message(
    app: tauri::AppHandle,
    chat_id: i64,
    content: String,
) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state).await?;
    let rt_handle = state.runtime.handle().clone();

    info!("send_message: chat_id={chat_id}, content_len={}", content.len());

    rt_handle.spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app_handle = app.clone();

        // Spawn event forwarder first
        let fwd = tokio::spawn(async move {
            use rayclaw::agent_engine::AgentEvent;
            while let Some(event) = rx.recv().await {
                let payload = match event {
                    AgentEvent::Iteration { iteration } => {
                        AgentStreamPayload::Iteration { iteration }
                    }
                    AgentEvent::ToolStart { name } => AgentStreamPayload::ToolStart { name },
                    AgentEvent::ToolResult {
                        name,
                        is_error,
                        preview,
                        duration_ms,
                        ..
                    } => AgentStreamPayload::ToolResult {
                        name,
                        is_error,
                        preview,
                        duration_ms: duration_ms as u64,
                    },
                    AgentEvent::TextDelta { delta } => AgentStreamPayload::TextDelta { delta },
                    AgentEvent::FinalResponse { text } => {
                        AgentStreamPayload::FinalResponse { text }
                    }
                };
                let _ = app_handle.emit("agent-stream", &payload);
            }
        });

        // Run agent — sends events via tx, drops tx when done
        debug!("send_message: starting agent processing for chat_id={chat_id}");
        let result = agent.process_message_stream(chat_id, &content, tx).await;

        // Store bot response in messages table (SDK stores user msg but not bot response)
        match &result {
            Ok(text) => info!("send_message: agent responded, len={}", text.len()),
            Err(e) => error!("send_message: agent error: {e}"),
        }
        if let Ok(ref response_text) = result {
            if !response_text.is_empty() {
                let bot_msg = rayclaw::db::StoredMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    chat_id,
                    sender_name: "rayclaw".to_string(),
                    content: response_text.clone(),
                    is_from_bot: true,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                let _ = agent.state().db.store_message(&bot_msg);
            }
        }

        // Wait for forwarder to drain all events
        let _ = fwd.await;
    });

    Ok(())
}

#[tauri::command]
pub async fn get_history(
    app: tauri::AppHandle,
    chat_id: i64,
    limit: Option<usize>,
) -> Result<Vec<StoredMessageDto>, String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state).await?;
    let messages = agent
        .get_messages(chat_id, limit.unwrap_or(100))
        .map_err(|e| e.to_string())?;

    Ok(messages
        .into_iter()
        .map(|m| StoredMessageDto {
            id: m.id,
            chat_id: m.chat_id,
            sender_name: m.sender_name,
            content: m.content,
            is_from_bot: m.is_from_bot,
            timestamp: m.timestamp,
        })
        .collect())
}

#[tauri::command]
pub async fn get_chats(app: tauri::AppHandle) -> Result<Vec<ChatSummaryDto>, String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state).await?;
    let chats = agent
        .state()
        .db
        .get_recent_chats(50)
        .map_err(|e| e.to_string())?;

    Ok(chats
        .into_iter()
        .map(|c| ChatSummaryDto {
            chat_id: c.chat_id,
            chat_title: c.chat_title,
            chat_type: c.chat_type,
            last_message_time: c.last_message_time,
            last_message_preview: c.last_message_preview,
        })
        .collect())
}

#[tauri::command]
pub async fn reset_session(app: tauri::AppHandle, chat_id: i64) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state).await?;
    agent.reset_session(chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn new_chat(app: tauri::AppHandle) -> Result<i64, String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state).await?;
    let chat_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    agent
        .state()
        .db
        .upsert_chat(chat_id, Some("New Chat"), "private")
        .map_err(|e| e.to_string())?;
    Ok(chat_id)
}
