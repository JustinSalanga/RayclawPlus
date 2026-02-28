use crate::state::DesktopState;
use serde::Serialize;
use tauri::{Emitter, Manager};

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

/// Helper: get agent or return Err
fn require_agent(
    state: &DesktopState,
) -> Result<std::sync::Arc<rayclaw::sdk::RayClawAgent>, String> {
    state
        .agent
        .try_read()
        .ok()
        .and_then(|guard| guard.clone())
        .ok_or_else(|| "Agent not initialized. Please configure rayclaw first.".to_string())
}

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
pub async fn send_message(
    app: tauri::AppHandle,
    chat_id: i64,
    content: String,
) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let agent = require_agent(&state)?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

    // Spawn agent processing in background
    let app_handle = app.clone();
    tokio::spawn(async move {
        // Forward events to frontend
        tokio::spawn(async move {
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

        let _ = agent.process_message_stream(chat_id, &content, tx).await;
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
