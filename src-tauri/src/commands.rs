use crate::state::DesktopState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager};

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
}

/// Create a default Config from a minimal YAML string.
fn default_config() -> rayclaw::config::Config {
    serde_yaml::from_str(
        r#"
llm_provider: anthropic
api_key: ""
model: ""
data_dir: "~/.rayclaw/data"
working_dir: "./tmp"
timezone: UTC
web_enabled: false
"#,
    )
    .expect("default config YAML is always valid")
}

fn mask_secret(s: &str) -> String {
    if s.len() <= 8 {
        "*".repeat(s.len())
    } else {
        format!("{}...{}", &s[..4], &s[s.len() - 4..])
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn require_agent(state: &DesktopState) -> Result<Arc<rayclaw::sdk::RayClawAgent>, String> {
    state
        .agent
        .blocking_read()
        .clone()
        .ok_or_else(|| "Agent not initialized. Please configure in Settings.".to_string())
}

fn default_config_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = format!("{home}/.rayclaw");
    let _ = std::fs::create_dir_all(&dir);
    format!("{dir}/rayclaw.config.yaml")
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
pub async fn get_config(app: tauri::AppHandle) -> Result<ConfigDto, String> {
    // Try loading from file; if not found return defaults
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
    })
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: ConfigDto) -> Result<(), String> {
    // Load existing config or start fresh
    let mut full_config = rayclaw::config::Config::load().unwrap_or_else(|_| default_config());

    // Apply DTO fields (skip masked secrets — keep existing value if masked)
    full_config.llm_provider = config.llm_provider;
    if !config.api_key.is_empty() && !config.api_key.contains("...") {
        full_config.api_key = config.api_key;
    }
    full_config.model = config.model;
    full_config.llm_base_url = config.llm_base_url;
    full_config.max_tokens = config.max_tokens;
    full_config.show_thinking = config.show_thinking;

    // AWS — only update if not masked
    full_config.aws_region = config.aws_region;
    if let Some(ref key) = config.aws_access_key_id {
        if !key.contains("...") {
            full_config.aws_access_key_id = Some(key.clone());
        }
    } else {
        full_config.aws_access_key_id = None;
    }
    if let Some(ref key) = config.aws_secret_access_key {
        if !key.contains("...") {
            full_config.aws_secret_access_key = Some(key.clone());
        }
    } else {
        full_config.aws_secret_access_key = None;
    }
    full_config.aws_profile = config.aws_profile;

    full_config.max_tool_iterations = config.max_tool_iterations;
    full_config.max_history_messages = config.max_history_messages;
    full_config.max_session_messages = config.max_session_messages;
    full_config.data_dir = config.data_dir;
    full_config.working_dir = config.working_dir;
    full_config.timezone = config.timezone;
    full_config.skip_tool_approval = config.skip_tool_approval;
    full_config.soul_path = config.soul_path;
    full_config.memory_token_budget = config.memory_token_budget;
    full_config.reflector_enabled = config.reflector_enabled;

    // Validate
    full_config
        .validate_for_sdk()
        .map_err(|e| format!("Validation failed: {e}"))?;

    // Save to file
    let save_path = rayclaw::config::Config::resolve_config_path()
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(default_config_path);
    full_config
        .save_yaml(&save_path)
        .map_err(|e| format!("Failed to save config: {e}"))?;

    // Reinitialize agent
    let state = app.state::<DesktopState>();
    let new_agent = state
        .runtime
        .block_on(async {
            rayclaw::sdk::RayClawAgent::new(full_config).await
        })
        .map_err(|e| format!("Failed to initialize agent: {e}"))?;

    {
        let mut agent_lock = state.agent.blocking_write();
        *agent_lock = Some(Arc::new(new_agent));
    }
    {
        let mut err_lock = state.init_error.blocking_write();
        *err_lock = None;
    }

    Ok(())
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
    let agent = require_agent(&state)?;
    let rt_handle = state.runtime.handle().clone();

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
        let _ = agent.process_message_stream(chat_id, &content, tx).await;

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
    let agent = require_agent(&state)?;
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
    let agent = require_agent(&state)?;
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
    let agent = require_agent(&state)?;
    agent.reset_session(chat_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn new_chat(app: tauri::AppHandle) -> Result<i64, String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state)?;
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
