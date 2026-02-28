mod commands;
mod state;

use state::DesktopState;
use tauri::Manager;
use tokio::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

            let (agent, init_error) = rt.block_on(async {
                match rayclaw::config::Config::load() {
                    Ok(mut config) => {
                        // Expand tilde in paths for desktop context
                        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                        if config.data_dir.starts_with("~/") {
                            config.data_dir = format!("{}/{}", home, &config.data_dir[2..]);
                        }
                        if config.working_dir.starts_with("~/") {
                            config.working_dir = format!("{}/{}", home, &config.working_dir[2..]);
                        }
                        match rayclaw::sdk::RayClawAgent::new(config).await {
                            Ok(agent) => (Some(std::sync::Arc::new(agent)), None),
                            Err(e) => (None, Some(format!("Failed to initialize agent: {e}"))),
                        }
                    }
                    Err(_) => (None, None), // No config yet — not an error, just needs setup
                }
            });

            app.manage(DesktopState {
                agent: RwLock::new(agent),
                init_error: RwLock::new(init_error),
                runtime: rt,
            });

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
