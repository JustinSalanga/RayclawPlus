use rayclaw::runtime::AppState;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct DesktopState {
    pub app_state: RwLock<Option<Arc<AppState>>>,
    pub init_error: RwLock<Option<String>>,
    pub runtime: tokio::runtime::Runtime,
    /// Named handles for spawned channel adapter tasks — aborted on reinit.
    pub channel_handles: std::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}
