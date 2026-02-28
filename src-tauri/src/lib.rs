mod commands;
mod state;

use state::DesktopState;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
            let agent = rt.block_on(async {
                let config = rayclaw::config::Config::load()
                    .expect("failed to load rayclaw config — run `rayclaw setup` first");
                rayclaw::sdk::RayClawAgent::new(config)
                    .await
                    .expect("failed to initialize RayClaw agent")
            });

            app.manage(DesktopState {
                agent: Arc::new(agent),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::send_message,
            commands::get_history,
            commands::get_chats,
            commands::reset_session,
            commands::new_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
