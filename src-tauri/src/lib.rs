mod commands;
mod state;

use state::DesktopState;
use tauri::Manager;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

fn expand_tilde(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{}", home, rest)
    } else if path == "~" {
        home
    } else {
        path.to_string()
    }
}

fn init_logging() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let log_dir = format!("{}/.rayclaw/logs", home);
    let _ = std::fs::create_dir_all(&log_dir);

    // File appender: daily rotation in ~/.rayclaw/logs/
    let file_appender =
        tracing_appender::rolling::daily(&log_dir, "rayclaw-desktop.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    // Leak the guard so it lives for the entire process
    // (dropping it would flush + stop the writer)
    std::mem::forget(_guard);

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,rayclaw=debug,rayclaw_desktop=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_target(true)
                .with_ansi(true)
                .with_writer(std::io::stderr),
        )
        .with(
            fmt::layer()
                .with_target(true)
                .with_ansi(false)
                .with_writer(file_writer),
        )
        .init();

    info!(
        "Logging initialized — file: {}/rayclaw-desktop.log.*",
        log_dir
    );
}

/// Log which channels are configured (and warn that SDK mode does not start them).
pub(crate) fn log_channel_diagnostics(config: &rayclaw::config::Config) {
    let mut channels_configured: Vec<&str> = Vec::new();

    if !config.telegram_bot_token.is_empty() {
        channels_configured.push("telegram");
    }
    if config.discord_bot_token.as_ref().map_or(false, |t| !t.is_empty()) {
        channels_configured.push("discord");
    }
    if config
        .channels
        .get("slack")
        .and_then(|v| v.get("bot_token"))
        .and_then(|v| v.as_str())
        .map_or(false, |s| !s.is_empty())
    {
        channels_configured.push("slack");
    }
    if config
        .channels
        .get("feishu")
        .and_then(|v| v.get("app_id"))
        .and_then(|v| v.as_str())
        .map_or(false, |s| !s.is_empty())
    {
        channels_configured.push("feishu");
        // Extra Feishu diagnostics
        let has_secret = config
            .channels
            .get("feishu")
            .and_then(|v| v.get("app_secret"))
            .and_then(|v| v.as_str())
            .map_or(false, |s| !s.is_empty());
        if !has_secret {
            warn!("Feishu channel: app_id is set but app_secret is missing — Feishu will not work");
        }
        let domain = config
            .channels
            .get("feishu")
            .and_then(|v| v.get("domain"))
            .and_then(|v| v.as_str())
            .unwrap_or("(not set, defaults to feishu)");
        let mode = config
            .channels
            .get("feishu")
            .and_then(|v| v.get("connection_mode"))
            .and_then(|v| v.as_str())
            .unwrap_or("(not set, defaults to websocket)");
        info!("Feishu channel config: domain={}, connection_mode={}", domain, mode);
    }
    if config.web_enabled {
        channels_configured.push("web");
    }

    if channels_configured.is_empty() {
        info!("No messaging channels configured");
    } else {
        warn!(
            "Channels configured in config: [{}]. NOTE: rayclaw-desktop runs in SDK mode — \
             channel adapters (Telegram, Discord, Slack, Feishu, Web) are NOT started by the \
             desktop app. To run channel adapters, use the CLI: `rayclaw start`",
            channels_configured.join(", ")
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    info!(
        "RayClaw Desktop v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

            let (agent, init_error) = rt.block_on(async {
                info!("Loading config...");
                match rayclaw::config::Config::load() {
                    Ok(mut config) => {
                        info!(
                            "Config loaded: provider={}, model={}, data_dir={}",
                            config.llm_provider, config.model, config.data_dir
                        );

                        // Expand tilde in paths for desktop context
                        if config.data_dir.starts_with("~/") {
                            config.data_dir = expand_tilde(&config.data_dir);
                            info!("Expanded data_dir to {}", config.data_dir);
                        }
                        if config.working_dir.starts_with("~/") {
                            config.working_dir = expand_tilde(&config.working_dir);
                        }

                        log_channel_diagnostics(&config);

                        info!("Initializing agent (SDK mode)...");
                        match rayclaw::sdk::RayClawAgent::new(config).await {
                            Ok(agent) => {
                                info!("Agent initialized successfully");
                                (Some(std::sync::Arc::new(agent)), None)
                            }
                            Err(e) => {
                                error!("Failed to initialize agent: {e}");
                                (None, Some(format!("Failed to initialize agent: {e}")))
                            }
                        }
                    }
                    Err(e) => {
                        info!("No config found ({e}) — showing setup screen");
                        (None, None)
                    }
                }
            });

            app.manage(DesktopState {
                agent: RwLock::new(agent),
                init_error: RwLock::new(init_error),
                runtime: rt,
            });

            info!("Tauri setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::get_config,
            commands::save_config,
            commands::send_message,
            commands::get_history,
            commands::get_chats,
            commands::reset_session,
            commands::new_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
