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
                    Ok(config) => match rayclaw::sdk::RayClawAgent::new(config).await {
                        Ok(agent) => (Some(std::sync::Arc::new(agent)), None),
                        Err(e) => (None, Some(format!("Failed to initialize agent: {e}"))),
                    },
                    Err(e) => (None, Some(format!("{e}"))),
                }
            });

            app.manage(DesktopState {
                agent: RwLock::new(agent),
                init_error: RwLock::new(init_error),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::send_message,
            commands::get_history,
            commands::get_chats,
            commands::reset_session,
            commands::new_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
