use std::path::PathBuf;

pub(crate) const APP_DIR_NAME: &str = ".rayclaw";
pub(crate) const CONFIG_FILE_NAME: &str = "rayclaw.config.yaml";
pub(crate) const LOG_FILE_NAME: &str = "rayclaw-desktop.log";
pub(crate) const CHANNEL_ENABLED_FILE_NAME: &str = "channel-enabled.json";

pub(crate) fn user_home_dir() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("USERPROFILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            let home_drive = std::env::var("HOMEDRIVE").ok()?;
            let home_path = std::env::var("HOMEPATH").ok()?;
            let combined = format!("{home_drive}{home_path}");
            (!combined.trim().is_empty()).then_some(combined)
        })
        .unwrap_or_else(|| ".".into())
}

pub(crate) fn app_home_dir() -> PathBuf {
    PathBuf::from(user_home_dir()).join(APP_DIR_NAME)
}

pub(crate) fn config_path() -> PathBuf {
    app_home_dir().join(CONFIG_FILE_NAME)
}

pub(crate) fn logs_dir() -> PathBuf {
    app_home_dir().join("logs")
}

pub(crate) fn channel_enabled_path() -> PathBuf {
    app_home_dir().join(CHANNEL_ENABLED_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        ENV_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap()
    }

    #[test]
    fn prefers_home_when_present() {
        let _guard = env_lock();
        let prev_home = std::env::var("HOME").ok();
        let prev_userprofile = std::env::var("USERPROFILE").ok();
        let prev_homedrive = std::env::var("HOMEDRIVE").ok();
        let prev_homepath = std::env::var("HOMEPATH").ok();

        std::env::set_var("HOME", "C:/home");
        std::env::set_var("USERPROFILE", "C:/users/profile");
        std::env::set_var("HOMEDRIVE", "D:");
        std::env::set_var("HOMEPATH", "\\fallback");

        assert_eq!(user_home_dir(), "C:/home");

        restore_env("HOME", prev_home);
        restore_env("USERPROFILE", prev_userprofile);
        restore_env("HOMEDRIVE", prev_homedrive);
        restore_env("HOMEPATH", prev_homepath);
    }

    #[test]
    fn falls_back_to_userprofile_on_windows() {
        let _guard = env_lock();
        let prev_home = std::env::var("HOME").ok();
        let prev_userprofile = std::env::var("USERPROFILE").ok();
        let prev_homedrive = std::env::var("HOMEDRIVE").ok();
        let prev_homepath = std::env::var("HOMEPATH").ok();

        std::env::remove_var("HOME");
        std::env::set_var("USERPROFILE", "C:/users/profile");
        std::env::set_var("HOMEDRIVE", "D:");
        std::env::set_var("HOMEPATH", "\\fallback");

        assert_eq!(user_home_dir(), "C:/users/profile");

        restore_env("HOME", prev_home);
        restore_env("USERPROFILE", prev_userprofile);
        restore_env("HOMEDRIVE", prev_homedrive);
        restore_env("HOMEPATH", prev_homepath);
    }

    fn restore_env(key: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}
