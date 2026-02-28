use rayclaw::sdk::RayClawAgent;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct DesktopState {
    pub agent: RwLock<Option<Arc<RayClawAgent>>>,
    pub init_error: RwLock<Option<String>>,
}
