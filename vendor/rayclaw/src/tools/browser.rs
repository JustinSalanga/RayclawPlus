use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

use super::{auth_context_from_input, schema_object, Tool, ToolResult};
use crate::llm_types::ToolDefinition;
use crate::text::floor_char_boundary;

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
        Some("open" | "reload" | "wait" | "screenshot" | "pdf" | "tab") => 360,
        Some(
            "click" | "dblclick" | "fill" | "type" | "press" | "hover" | "select" | "check"
            | "uncheck" | "upload" | "drag" | "scroll" | "scrollintoview" | "find" | "eval",
        ) => 180,
        Some(_) | None => 180,
    };

    if matches!(source, "bundled-app" | "npx") {
        base.max(360)
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

    fn screenshot_path(&self, chat_id: i64, name: &str) -> PathBuf {
        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
        let safe_name = if name.is_empty() { "screenshot" } else { name };
        self.data_dir
            .join(chat_id.to_string())
            .join("screenshots")
            .join(format!("{safe_name}_{ts}.png"))
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

    fn base_env() -> Vec<(String, String)> {
        // Force headless mode for the bundled agent-browser daemon unless the
        // user has explicitly overridden it. The agent-browser docs specify
        // treated as disabled. We set it to "0" so that even if a config file
        // requests headed mode, the environment keeps the daemon headless.
        let mut env = Vec::new();
       
        if let Ok(browsers_path) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
            if !browsers_path.trim().is_empty() {
                env.push(("PLAYWRIGHT_BROWSERS_PATH".to_string(), browsers_path));
            }
        }
        env
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
                out.push(BrowserCommandSpec {
                    program: node,
                    args: vec![entry],
                    env: Self::base_env(),
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
                    env: Self::base_env(),
                    source: "PATH",
                });
            }

            let mut add_path_candidate = |path: PathBuf, source: &'static str| {
                if path.is_file() {
                    out.push(BrowserCommandSpec {
                        program: path.to_string_lossy().to_string(),
                        args: Vec::new(),
                        env: Self::base_env(),
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
                    env: Self::base_env(),
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
                    env: Self::base_env(),
                    source: "PATH",
                });
            }

            if let Ok(home) = std::env::var("HOME") {
                let local_bin = PathBuf::from(home)
                    .join(".local")
                    .join("bin")
                    .join("agent-browser");
                if local_bin.is_file() {
                    out.push(BrowserCommandSpec {
                        program: local_bin.to_string_lossy().to_string(),
                        args: Vec::new(),
                        env: Self::base_env(),
                        source: "~/.local/bin",
                    });
                }
            }

            if Self::command_exists("npx") {
                out.push(BrowserCommandSpec {
                    program: "npx".to_string(),
                    args: vec!["--yes".to_string(), "agent-browser".to_string()],
                    env: Self::base_env(),
                    source: "npx",
                });
            }
        }

        out
    }

    /// Close the browser daemon for a given chat session. Called before and
    /// after an agent turn so the Chromium process doesn't linger and new
    /// options like profile/headed take effect.
    pub async fn close_session(chat_id: i64) {
        let session_name = Self::session_name_for_chat(chat_id);
        let candidates = Self::browser_command_candidates();
        for candidate in candidates {
            // Try to close just this session first.
            for args in [
                vec!["--session".to_string(), session_name.clone(), "close".to_string()],
                // Then fall back to a global close without an explicit session
                // in case the daemon was started with a different session name.
                vec!["close".to_string()],
            ] {
                let mut cmd = tokio::process::Command::new(&candidate.program);
                cmd.args(&candidate.args)
                    .envs(candidate.env.iter().cloned())
                    .args(&args)
                    .kill_on_drop(true);
                match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
                {
                    Ok(Ok(output)) => {
                        info!(
                            "browser close_session(chat_id={chat_id}) via {} {:?}: exit={:?}",
                            candidate.source,
                            args,
                            output.status.code()
                        );
                        // If we got any response at all, stop trying further candidates.
                        return;
                    }
                    Ok(Err(e)) => {
                        info!(
                            "browser close_session error via {} {:?}: {e}",
                            candidate.source, args
                        );
                        continue;
                    }
                    Err(_) => {
                        info!(
                            "browser close_session timed out via {} {:?}",
                            candidate.source, args
                        );
                        return;
                    }
                }
            }
        }
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
            description: "Headless browser automation via agent-browser CLI. Fast Rust CLI with Node.js fallback. \
                Browser state (cookies, localStorage, login sessions) persists across calls via a background daemon.\n\n\
                ## Basic workflow\n\
                1. `open <url>` — navigate to a URL\n\
                2. `snapshot -i` — get interactive elements with refs (@e1, @e2, ...)\n\
                3. `click @e1` / `fill @e2 \"text\"` — interact using refs from snapshot\n\
                4. `get text @e3` — extract text by ref\n\
                5. Always re-run `snapshot -i` after navigation or interaction to see updated state\n\n\
                ## Selectors\n\
                **Refs (recommended)**: `@e1`, `@e2` — deterministic refs from `snapshot`. Fast, no DOM re-query.\n\
                **CSS**: `\"#id\"`, `\".class\"`, `\"div > button\"`\n\
                **Text/XPath**: `\"text=Submit\"`, `\"xpath=//button\"`\n\
                **Semantic find**: `find role button click --name \"Submit\"`, `find label \"Email\" fill \"test@test.com\"`, \
                `find text \"Sign In\" click`, `find first \".item\" click`, `find nth 2 \"a\" text`\n\n\
                ## All available commands\n\
                **Navigation**: `open <url>`, `back`, `forward`, `reload`, `close`\n\
                **Interaction**: `click <sel>` (--new-tab), `dblclick <sel>`, `fill <sel> <text>`, `type <sel> <text>`, \
                `press <key>`, `keyboard type <text>`, `keyboard inserttext <text>`, `keydown <key>`, `keyup <key>`, \
                `hover <sel>`, `focus <sel>`, `select <sel> <val>`, `check <sel>`, `uncheck <sel>`, \
                `upload <sel> <files>`, `drag <src> <tgt>`\n\
                **Mouse**: `mouse move <x> <y>`, `mouse down [button]`, `mouse up [button]`, `mouse wheel <dy> [dx]`\n\
                **Scrolling**: `scroll <dir> [px]` (--selector <sel>), `scrollintoview <sel>`\n\
                **Data extraction**: `get text/html/value/attr/title/url/count/box/styles <sel>`\n\
                **State checks**: `is visible/enabled/checked <sel>`\n\
                **Snapshot**: `snapshot` (-i interactive, -C cursor-interactive, -c compact, -d <depth>, -s <selector>)\n\
                **Screenshot/PDF**: `screenshot [path]` (--full, --annotate for numbered element labels), `pdf <path>`\n\
                **JavaScript**: `eval <js>` (-b for base64, --stdin for piped input)\n\
                **Wait**: `wait <selector>`, `wait <ms>`, `wait --text \"...\"`, `wait --url \"**/...\"`, \
                `wait --load networkidle|load|domcontentloaded`, `wait --fn \"condition\"`, `wait --download [path]`\n\
                **Downloads**: `download <sel> <path>`, `wait --download [path]`\n\
                **Cookies**: `cookies`, `cookies set <name> <val>`, `cookies clear`\n\
                **Storage**: `storage local [key]`, `storage local set <k> <v>`, `storage local clear` (same for session)\n\
                **Tabs/Windows**: `tab`, `tab new [url]`, `tab <n>`, `tab close [n]`, `window new`\n\
                **Frames**: `frame <sel>`, `frame main`\n\
                **Dialogs**: `dialog accept [text]`, `dialog dismiss`\n\
                **Settings**: `set viewport <w> <h> [scale]`, `set device <name>`, `set geo <lat> <lng>`, \
                `set offline [on|off]`, `set headers <json>`, `set credentials <u> <p>`, `set media [dark|light]`\n\
                **Network**: `network route <url>` [--abort|--body <json>], `network unroute [url]`, \
                `network requests` [--filter <pat>|--clear]\n\
                **Auth vault**: `auth save <name> --url <url> --username <u> --password-stdin`, `auth login <name>`, \
                `auth list`, `auth show <name>`, `auth delete <name>`\n\
                **State**: `state save/load <path>`, `state list`, `state show <file>`, \
                `state rename <old> <new>`, `state clear [name|--all]`, `state clean --older-than <days>`\n\
                **Diff**: `diff snapshot` [--baseline <path>] [--selector <sel>] [--compact], \
                `diff screenshot --baseline <path>` [-o <path>] [-t <tolerance>], \
                `diff url <url1> <url2>` [--screenshot] [--wait-until networkidle] [--selector <sel>]\n\
                **Debug**: `trace start/stop [path]`, `profiler start`, `profiler stop [path]`, \
                `console` [--clear], `errors` [--clear], `highlight <sel>`\n\
                **Sessions**: `session`, `session list`. Use `--session <name>` for isolated instances.\n\n\
                ## Annotated screenshots\n\
                `screenshot --annotate` overlays numbered labels [N] on interactive elements. \
                Each label corresponds to ref @eN so you can immediately `click @e2` after. \
                Useful for visual reasoning about layout, icon buttons, and canvas elements.\n\n\
                ## Command chaining\n\
                Chain with `&&` in a single command string for efficiency:\n\
                `open example.com && wait --load networkidle && snapshot -i`\n\
                Use separate calls when you need to parse intermediate output (e.g. snapshot refs before clicking).\n\n\
                ## Tips\n\
                - Prefer refs (`@e1`) over CSS selectors for reliability.\n\
                - Use `snapshot -i` (interactive only) to reduce output size.\n\
                - Use `wait --load networkidle` after `open` for SPAs that load dynamically.\n\
                - Use `--json` for machine-readable output.\n\
                - Default Playwright timeout is 25s. Override with `timeout_secs` parameter if needed."
                .into(),
            input_schema: schema_object(
                json!({
                    "command": {
                        "type": "string",
                        "description": "The agent-browser command to run (e.g. `open https://example.com`, `snapshot -i`, `fill @e2 \"hello\"`)"
                    },
                    "timeout_secs": {
                        "type": "number",
                        "description": "Timeout in seconds. Optional; if omitted, the tool uses a longer command-aware default."
                    },
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

        let requested_timeout_secs = input.get("timeout_secs").and_then(|v| v.as_u64());

        let auth = auth_context_from_input(&input);

        let session_name = auth
            .as_ref()
            .map(|auth| Self::session_name_for_chat(auth.caller_chat_id))
            .unwrap_or_else(|| "rayclaw".to_string());

        let mut args = vec![
            "--session".to_string(), session_name,
        ];
        if let Some(auth) = auth.as_ref() {
            let path = self.profile_path(auth.caller_chat_id);
            args.push("--profile".to_string());
            args.push(path.to_string_lossy().to_string());
        }

        let chat_id_for_cleanup = auth.as_ref().map(|auth| auth.caller_chat_id);

        let mut command_args = match split_browser_command(command) {
            Ok(parts) if !parts.is_empty() => parts,
            Ok(_) => return ToolResult::error("Empty browser command".into()),
            Err(e) => {
                return ToolResult::error(format!(
                    "Invalid browser command syntax (quote parsing failed): {e}"
                ));
            }
        };

        // Force all screenshot commands to save into the standardised path
        // groups/{chat_id}/screenshots/ regardless of what the agent requested.
        if let Some(auth_ctx) = auth.as_ref() {
            let verb = command_args.first().map(|s| s.as_str());
            if verb == Some("screenshot") {
                // Derive a name from the agent-provided path (if any), otherwise default.
                let existing_path_idx = command_args
                    .iter()
                    .enumerate()
                    .skip(1)
                    .find(|(_, a)| !a.starts_with('-'))
                    .map(|(i, _)| i);
                let base_name = existing_path_idx
                    .and_then(|i| {
                        std::path::Path::new(&command_args[i])
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .map(String::from)
                    })
                    .unwrap_or_else(|| "browser_screenshot".to_string());
                let out = self.screenshot_path(auth_ctx.caller_chat_id, &base_name);
                if let Some(parent) = out.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let out_str = out.to_string_lossy().to_string();
                if let Some(idx) = existing_path_idx {
                    command_args[idx] = out_str;
                } else {
                    command_args.push(out_str);
                }
            }
        }

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

            let mut cmd = tokio::process::Command::new(&candidate.program);
            cmd.kill_on_drop(true)
                .args(&candidate.args)
                .envs(candidate.env.iter().cloned())
                .args(&args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    last_not_found_error = Some(format!(
                        "{} ({}) not found: {}",
                        candidate.program, candidate.source, e
                    ));
                    continue;
                }
                Err(e) => {
                    return ToolResult::error(format!(
                        "Failed to execute browser command via {} ({}): {e}",
                        candidate.program, candidate.source
                    ))
                    .with_error_type("spawn_error");
                }
            };

            // Take stdout/stderr handles before wait so we can read them on timeout
            let child_stdout = child.stdout.take();
            let child_stderr = child.stderr.take();

            let stdout_task = tokio::spawn(async move {
                let mut buf = Vec::new();
                if let Some(mut s) = child_stdout {
                    let _ = tokio::io::AsyncReadExt::read_to_end(&mut s, &mut buf).await;
                }
                buf
            });
            let stderr_task = tokio::spawn(async move {
                let mut buf = Vec::new();
                if let Some(mut s) = child_stderr {
                    let _ = tokio::io::AsyncReadExt::read_to_end(&mut s, &mut buf).await;
                }
                buf
            });

            let wait_result = tokio::time::timeout(
                std::time::Duration::from_secs(effective_timeout_secs),
                child.wait(),
            )
            .await;

            let timed_out = wait_result.is_err();
            if timed_out {
                let _ = child.kill().await;
            }

            let stdout_bytes = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stdout_task,
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

            let stderr_bytes = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stderr_task,
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

            let format_output = |stdout: &[u8], stderr: &[u8], fallback: &str| -> String {
                let out = String::from_utf8_lossy(stdout);
                let err = String::from_utf8_lossy(stderr);
                let mut text = String::new();
                if !out.is_empty() {
                    text.push_str(&out);
                }
                if !err.is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str("STDERR:\n");
                    text.push_str(&err);
                }
                if text.is_empty() {
                    text = fallback.to_string();
                }
                if text.len() > 30000 {
                    let cutoff = floor_char_boundary(&text, 30000);
                    text.truncate(cutoff);
                    text.push_str("\n... (output truncated)");
                }
                text
            };

            if timed_out {
                let partial = format_output(
                    &stdout_bytes,
                    &stderr_bytes,
                    "(no output captured before timeout)",
                );
                return ToolResult::error(format!(
                    "Browser command timed out after {effective_timeout_secs} seconds\n{partial}"
                ))
                .with_error_type("timeout");
            }

            match wait_result {
                Ok(Ok(status)) => {
                    let exit_code = status.code().unwrap_or(-1);
                    let raw_text = format_output(
                        &stdout_bytes,
                        &stderr_bytes,
                        &format!("Command completed with exit code {exit_code}"),
                    );
                    // Normalize a few known, noisy but harmless lines to keep the UI output
                    // focused on actionable information.
                    let cleaned_text = raw_text
                        .lines()
                        .filter(|line| {
                            // agent-browser prints this when a daemon is already running with a
                            // different profile; it does not represent a failure for our tool.
                            !line.contains("--profile ignored: daemon already running")
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let result_text = if cleaned_text.trim().is_empty() {
                        raw_text
                    } else {
                        cleaned_text
                    };

                    // Soft-timeout handling: when agent-browser reports a Playwright page.goto
                    // timeout for an `open` command, the page is often still partially loaded
                    // and subsequent commands (`wait --load networkidle`, `snapshot -i`) can
                    // succeed. Treat this as a soft timeout instead of a hard tool failure.
                    if exit_code != 0 {
                        let is_open = args
                            .get(2)
                            .map(|verb| verb == "open" || verb == "goto" || verb == "navigate")
                            .unwrap_or(false);
                        let is_goto_timeout = result_text
                            .contains("page.goto: Timeout 25000ms exceeded")
                            || result_text.contains("Timeout 25000ms exceeded.");

                        if is_open && is_goto_timeout {
                            let mut message = String::new();
                            message.push_str(
                                "Browser navigation hit page.goto timeout (Playwright internal 25000ms), \
but the session remains usable.\n",
                            );
                            message.push_str(
                                "You can usually continue with `wait --load networkidle` or `snapshot -i`.\n\n",
                            );
                            message.push_str(&result_text);
                            if let Some(cid) = chat_id_for_cleanup {
                                Self::close_session(cid).await;
                            }
                            return ToolResult::success(message)
                                .with_status_code(0)
                                .with_error_type("soft_timeout");
                        }

                        if let Some(cid) = chat_id_for_cleanup {
                            Self::close_session(cid).await;
                        }
                        return ToolResult::error(format!("Exit code {exit_code}\n{result_text}"))
                            .with_status_code(exit_code)
                            .with_error_type("process_exit");
                    }

                    if let Some(cid) = chat_id_for_cleanup {
                        Self::close_session(cid).await;
                    }
                    return ToolResult::success(result_text).with_status_code(exit_code);
                }
                Ok(Err(e)) => {
                    let partial = format_output(
                        &stdout_bytes,
                        &stderr_bytes,
                        "(no output captured)",
                    );
                    if let Some(cid) = chat_id_for_cleanup {
                        Self::close_session(cid).await;
                    }
                    return ToolResult::error(format!(
                        "Failed to wait on browser command via {} ({}): {e}\n{partial}",
                        candidate.program, candidate.source
                    ))
                    .with_error_type("spawn_error");
                }
                Err(_) => unreachable!(),
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
        assert_eq!(
            default_timeout_secs_for_command("open https://example.com", "PATH"),
            360
        );
        assert_eq!(default_timeout_secs_for_command("click @e1", "PATH"), 180);
        assert_eq!(
            default_timeout_secs_for_command("snapshot -i", "bundled-app"),
            360
        );
    }

    #[tokio::test]
    async fn test_browser_missing_command() {
        let tool = BrowserTool::new("/tmp/test-data");
        let result = tool.execute(json!({})).await;
        assert!(result.is_error);
        assert!(result.content.contains("Missing 'command'"));
    }
}
