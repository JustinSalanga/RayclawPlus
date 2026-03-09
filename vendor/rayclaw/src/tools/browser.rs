use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

use crate::llm_types::ToolDefinition;
use crate::text::floor_char_boundary;
use super::{auth_context_from_input, schema_object, Tool, ToolResult};

pub struct BrowserTool {
    data_dir: PathBuf,
}

struct BrowserCommandSpec {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    source: &'static str,
}

fn browser_command_verb(command: &str) -> Option<&str> {
    command.split_whitespace().next()
}

fn default_timeout_secs_for_command(command: &str, source: &str) -> u64 {
    let base = match browser_command_verb(command) {
        Some("open" | "reload" | "wait" | "screenshot" | "pdf" | "tab") => 120,
        Some(
            "click"
            | "dblclick"
            | "fill"
            | "type"
            | "press"
            | "hover"
            | "select"
            | "check"
            | "uncheck"
            | "upload"
            | "drag"
            | "scroll"
            | "scrollintoview"
            | "find"
            | "eval",
        ) => 60,
        Some(_) | None => 60,
    };

    if matches!(source, "bundled-app" | "npx") {
        base.max(120)
    } else {
        base
    }
}

fn split_browser_command(command: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
            continue;
        }

        current.push(ch);
    }

    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("unclosed quote".into());
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

impl BrowserTool {
    pub fn new(data_dir: &str) -> Self {
        BrowserTool {
            data_dir: PathBuf::from(data_dir).join("groups"),
        }
    }

    fn profile_path(&self, chat_id: i64) -> PathBuf {
        self.data_dir
            .join(chat_id.to_string())
            .join("browser-profile")
    }

    fn session_name_for_chat(chat_id: i64) -> String {
        let normalized = if chat_id < 0 {
            format!("neg{}", chat_id.unsigned_abs())
        } else {
            chat_id.to_string()
        };
        format!("rayclaw-chat-{normalized}")
    }

    fn command_exists(command: &str) -> bool {
        if command.trim().is_empty() {
            return false;
        }

        let path_var = std::env::var_os("PATH").unwrap_or_default();

        #[cfg(target_os = "windows")]
        let candidates: Vec<String> = {
            let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
            let ext_list: Vec<String> = exts
                .split(';')
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect();

            let mut out = vec![command.to_string()];
            let lower = command.to_ascii_lowercase();
            if !ext_list.iter().any(|ext| lower.ends_with(ext)) {
                for ext in ext_list {
                    out.push(format!("{command}{ext}"));
                }
            }
            out
        };

        #[cfg(not(target_os = "windows"))]
        let candidates: Vec<String> = vec![command.to_string()];

        for base in std::env::split_paths(&path_var) {
            for candidate in &candidates {
                if base.join(candidate).is_file() {
                    return true;
                }
            }
        }
        false
    }

    fn browser_command_candidates() -> Vec<BrowserCommandSpec> {
        let mut out = Vec::new();

        if let (Ok(node), Ok(entry)) = (
            std::env::var("RAYCLAW_AGENT_BROWSER_NODE"),
            std::env::var("RAYCLAW_AGENT_BROWSER_ENTRY"),
        ) {
            let node_path = PathBuf::from(&node);
            let entry_path = PathBuf::from(&entry);
            if node_path.is_file() && entry_path.is_file() {
                let mut env = Vec::new();
                if let Ok(browsers_path) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
                    if !browsers_path.trim().is_empty() {
                        env.push(("PLAYWRIGHT_BROWSERS_PATH".to_string(), browsers_path));
                    }
                }

                out.push(BrowserCommandSpec {
                    program: node,
                    args: vec![entry],
                    env,
                    source: "bundled-app",
                });
            }
        }

        #[cfg(target_os = "windows")]
        {
            if Self::command_exists("agent-browser.cmd") {
                out.push(BrowserCommandSpec {
                    program: "agent-browser.cmd".to_string(),
                    args: Vec::new(),
                    env: Vec::new(),
                    source: "PATH",
                });
            }

            let mut add_path_candidate = |path: PathBuf, source: &'static str| {
                if path.is_file() {
                    out.push(BrowserCommandSpec {
                        program: path.to_string_lossy().to_string(),
                        args: Vec::new(),
                        env: Vec::new(),
                        source,
                    });
                }
            };

            if let Ok(app_data) = std::env::var("APPDATA") {
                let app_data = PathBuf::from(app_data);
                add_path_candidate(
                    app_data.join("npm").join("agent-browser.cmd"),
                    "APPDATA npm bin",
                );
            }
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                let local_app_data = PathBuf::from(local_app_data);
                add_path_candidate(
                    local_app_data.join("npm").join("agent-browser.cmd"),
                    "LOCALAPPDATA npm bin",
                );
            }
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                let user_profile = PathBuf::from(user_profile);
                add_path_candidate(
                    user_profile
                        .join("AppData")
                        .join("Roaming")
                        .join("npm")
                        .join("agent-browser.cmd"),
                    "USERPROFILE npm bin",
                );
            }

            if Self::command_exists("npx.cmd") {
                out.push(BrowserCommandSpec {
                    program: "npx.cmd".to_string(),
                    args: vec!["--yes".to_string(), "agent-browser".to_string()],
                    env: Vec::new(),
                    source: "npx",
                });
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if Self::command_exists("agent-browser") {
                out.push(BrowserCommandSpec {
                    program: "agent-browser".to_string(),
                    args: Vec::new(),
                    env: Vec::new(),
                    source: "PATH",
                });
            }

            if let Ok(home) = std::env::var("HOME") {
                let local_bin = PathBuf::from(home).join(".local").join("bin").join("agent-browser");
                if local_bin.is_file() {
                    out.push(BrowserCommandSpec {
                        program: local_bin.to_string_lossy().to_string(),
                        args: Vec::new(),
                        env: Vec::new(),
                        source: "~/.local/bin",
                    });
                }
            }

            if Self::command_exists("npx") {
                out.push(BrowserCommandSpec {
                    program: "npx".to_string(),
                    args: vec!["--yes".to_string(), "agent-browser".to_string()],
                    env: Vec::new(),
                    source: "npx",
                });
            }
        }

        out
    }
}

#[async_trait]
impl Tool for BrowserTool {
    fn name(&self) -> &str {
        "browser"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "browser".into(),
            description: "Headless browser automation via agent-browser CLI. Browser state (cookies, localStorage, login sessions) persists across calls and across conversations.\n\n\
                ## Basic workflow\n\
                1. `open <url>` — navigate to a URL\n\
                2. `snapshot -i` — get interactive elements with refs (@e1, @e2, ...)\n\
                3. `click @e1` / `fill @e2 \"text\"` — interact with elements\n\
                4. `get text @e3` — extract text content\n\
                5. Always run `snapshot -i` after navigation or interaction to see updated state\n\n\
                ## All available commands\n\
                **Navigation**: open, back, forward, reload, close\n\
                **Interaction**: click, dblclick, fill, type, press, hover, select, check, uncheck, upload, drag\n\
                **Scrolling**: scroll <dir> [px], scrollintoview <sel>\n\
                **Data extraction**: get text/html/value/attr/title/url/count/box <sel>\n\
                **State checks**: is visible/enabled/checked <sel>\n\
                **Snapshot**: snapshot (-i for interactive only, -c for compact)\n\
                **Screenshot/PDF**: screenshot [path] (--full for full page), pdf <path>\n\
                **JavaScript**: eval <js>\n\
                **Cookies**: cookies, cookies set <name> <val>, cookies clear\n\
                **Storage**: storage local [key], storage local set <k> <v>, storage local clear (same for session)\n\
                **Tabs**: tab, tab new [url], tab <n>, tab close [n]\n\
                **Frames**: frame <sel>, frame main\n\
                **Dialogs**: dialog accept [text], dialog dismiss\n\
                **Viewport**: set viewport <w> <h>, set device <name>, set media dark/light\n\
                **Network**: network route <url> [--abort|--body <json>], network requests\n\
                **Wait**: wait <sel|ms|--text|--url|--load|--fn>\n\
                **Auth state**: state save <path>, state load <path>\n\
                **Semantic find**: find role/text/label/placeholder <value> <action> [input]".into(),
            input_schema: schema_object(
                json!({
                    "command": {
                        "type": "string",
                        "description": "The agent-browser command to run (e.g. `open https://example.com`, `snapshot -i`, `fill @e2 \"hello\"`)"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds. Optional; if omitted, the tool uses a longer command-aware default."
                    }
                }),
                &["command"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let command = match input.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolResult::error("Missing 'command' parameter".into()),
        };

        let requested_timeout_secs = input
            .get("timeout_secs")
            .and_then(|v| v.as_u64());

        let auth = auth_context_from_input(&input);

        let session_name = auth
            .as_ref()
            .map(|auth| Self::session_name_for_chat(auth.caller_chat_id))
            .unwrap_or_else(|| "rayclaw".to_string());

        let mut args = vec!["--session".to_string(), session_name];
        if let Some(auth) = auth.as_ref() {
            let path = self.profile_path(auth.caller_chat_id);
            args.push("--profile".to_string());
            args.push(path.to_string_lossy().to_string());
        }

        let command_args = match split_browser_command(command) {
            Ok(parts) if !parts.is_empty() => parts,
            Ok(_) => return ToolResult::error("Empty browser command".into()),
            Err(e) => {
                return ToolResult::error(format!(
                    "Invalid browser command syntax (quote parsing failed): {e}"
                ));
            }
        };
        args.extend(command_args);

        let candidates = Self::browser_command_candidates();
        if candidates.is_empty() {
            return ToolResult::error(
                "Browser tool runtime is unavailable. Rebuild the desktop app bundle, or install `agent-browser` and run `agent-browser install` for external use."
                    .into(),
            )
            .with_error_type("missing_dependency");
        }

        let mut last_not_found_error: Option<String> = None;

        for candidate in candidates {
            info!(
                "Executing browser command via '{}' ({})",
                candidate.program, candidate.source
            );

            let effective_timeout_secs = requested_timeout_secs
                .unwrap_or_else(|| default_timeout_secs_for_command(command, candidate.source));

            let result = tokio::time::timeout(
                std::time::Duration::from_secs(effective_timeout_secs),
                {
                    let mut cmd = tokio::process::Command::new(&candidate.program);
                    cmd.kill_on_drop(true)
                        .args(&candidate.args)
                        .envs(candidate.env.iter().cloned())
                        .args(&args);
                    cmd.output()
                },
            )
            .await;

            match result {
                Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let exit_code = output.status.code().unwrap_or(-1);

                let mut result_text = String::new();
                if !stdout.is_empty() {
                    result_text.push_str(&stdout);
                }
                if !stderr.is_empty() {
                    if !result_text.is_empty() {
                        result_text.push('\n');
                    }
                    result_text.push_str("STDERR:\n");
                    result_text.push_str(&stderr);
                }
                if result_text.is_empty() {
                    result_text = format!("Command completed with exit code {exit_code}");
                }

                // Truncate very long output
                if result_text.len() > 30000 {
                    let cutoff = floor_char_boundary(&result_text, 30000);
                    result_text.truncate(cutoff);
                    result_text.push_str("\n... (output truncated)");
                }

                    if exit_code == 0 {
                        return ToolResult::success(result_text).with_status_code(exit_code);
                    } else {
                        return ToolResult::error(format!("Exit code {exit_code}\n{result_text}"))
                            .with_status_code(exit_code)
                            .with_error_type("process_exit");
                    }
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    last_not_found_error = Some(format!(
                        "{} ({}) not found: {}",
                        candidate.program, candidate.source, e
                    ));
                    continue;
                }
                Ok(Err(e)) => {
                    return ToolResult::error(format!(
                        "Failed to execute browser command via {} ({}): {e}",
                        candidate.program, candidate.source
                    ))
                    .with_error_type("spawn_error");
                }
                Err(_) => {
                    return ToolResult::error(format!(
                        "Browser command timed out after {effective_timeout_secs} seconds"
                    ))
                    .with_error_type("timeout");
                }
            }
        }

        ToolResult::error(format!(
            "Failed to execute browser runtime. {}. Rebuild the app bundle, or install `agent-browser` and run `agent-browser install` for external use.",
            last_not_found_error.unwrap_or_else(|| "No runnable agent-browser command was found".to_string())
        ))
        .with_error_type("missing_dependency")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_split_browser_command() {
        let args = split_browser_command("fill @e2 \"hello world\"").unwrap();
        assert_eq!(args, vec!["fill", "@e2", "hello world"]);
    }

    #[test]
    fn test_split_browser_command_unclosed_quote() {
        let err = split_browser_command("open \"https://example.com").unwrap_err();
        assert!(err.contains("unclosed quote"));
    }

    #[test]
    fn test_browser_tool_name_and_definition() {
        let tool = BrowserTool::new("/tmp/test-data");
        assert_eq!(tool.name(), "browser");
        let def = tool.definition();
        assert_eq!(def.name, "browser");
        assert!(def.description.contains("agent-browser"));
        assert!(def.description.contains("cookies"));
        assert!(def.description.contains("eval"));
        assert!(def.description.contains("pdf"));
        assert!(def.input_schema["properties"]["command"].is_object());
        assert!(def.input_schema["properties"]["timeout_secs"].is_object());
    }

    #[test]
    fn test_browser_profile_path() {
        let tool = BrowserTool::new("/tmp/test-data");
        let path = tool.profile_path(12345);
        assert_eq!(
            path,
            PathBuf::from("/tmp/test-data/groups/12345/browser-profile")
        );
    }

    #[test]
    fn test_browser_session_name_for_chat() {
        assert_eq!(
            BrowserTool::session_name_for_chat(12345),
            "rayclaw-chat-12345"
        );
        assert_eq!(
            BrowserTool::session_name_for_chat(-100987),
            "rayclaw-chat-neg100987"
        );
    }

    #[test]
    fn test_default_timeout_secs_for_command() {
        assert_eq!(default_timeout_secs_for_command("open https://example.com", "PATH"), 120);
        assert_eq!(default_timeout_secs_for_command("click @e1", "PATH"), 60);
        assert_eq!(default_timeout_secs_for_command("snapshot -i", "bundled-app"), 120);
    }

    #[tokio::test]
    async fn test_browser_missing_command() {
        let tool = BrowserTool::new("/tmp/test-data");
        let result = tool.execute(json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("Missing 'command'"));
    }
}
