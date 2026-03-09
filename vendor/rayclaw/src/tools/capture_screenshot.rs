use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

use crate::llm_types::ToolDefinition;
use crate::text::floor_char_boundary;

use super::{auth_context_from_input, schema_object, Tool, ToolResult};

pub struct CaptureScreenshotTool {
    data_dir: PathBuf,
}

impl CaptureScreenshotTool {
    pub fn new(data_dir: &str) -> Self {
        Self {
            data_dir: PathBuf::from(data_dir),
        }
    }

    fn screenshot_dir_for_input(&self, input: &serde_json::Value) -> PathBuf {
        if let Some(auth) = auth_context_from_input(input) {
            self.data_dir
                .join("groups")
                .join(auth.caller_chat_id.to_string())
                .join("screenshots")
        } else {
            self.data_dir.join("screenshots")
        }
    }

    fn resolve_output_path(&self, input: &serde_json::Value) -> PathBuf {
        let base_dir = self.screenshot_dir_for_input(input);
        let provided = input.get("path").and_then(|v| v.as_str()).map(PathBuf::from);
        match provided {
            Some(path) if path.is_absolute() => path,
            Some(path) => base_dir.join(path),
            None => {
                let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
                base_dir.join(format!("desktop_screenshot_{timestamp}.png"))
            }
        }
    }

    #[cfg(target_os = "linux")]
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

    #[cfg(target_os = "windows")]
    fn build_capture_command(path: &Path) -> tokio::process::Command {
        let escaped_path = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save('{escaped_path}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
"#
        );

        let mut cmd = tokio::process::Command::new("powershell");
        cmd.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-STA")
            .arg("-Command")
            .arg(script);
        cmd
    }

    #[cfg(target_os = "macos")]
    fn build_capture_command(path: &Path) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("screencapture");
        cmd.arg("-x").arg(path);
        cmd
    }

    #[cfg(target_os = "linux")]
    fn build_capture_command(path: &Path) -> Result<tokio::process::Command, String> {
        if Self::command_exists("grim") {
            let mut cmd = tokio::process::Command::new("grim");
            cmd.arg(path);
            return Ok(cmd);
        }

        if Self::command_exists("gnome-screenshot") {
            let mut cmd = tokio::process::Command::new("gnome-screenshot");
            cmd.arg("-f").arg(path);
            return Ok(cmd);
        }

        if Self::command_exists("scrot") {
            let mut cmd = tokio::process::Command::new("scrot");
            cmd.arg(path);
            return Ok(cmd);
        }

        if Self::command_exists("import") {
            let mut cmd = tokio::process::Command::new("import");
            cmd.arg("-window").arg("root").arg(path);
            return Ok(cmd);
        }

        Err(
            "No screenshot utility found. Install `grim`, `gnome-screenshot`, `scrot`, or ImageMagick `import`."
                .to_string(),
        )
    }

    fn truncate_output(text: &str) -> String {
        if text.len() > 8000 {
            let cutoff = floor_char_boundary(text, 8000);
            let mut truncated = text[..cutoff].to_string();
            truncated.push_str("\n... (output truncated)");
            truncated
        } else {
            text.to_string()
        }
    }
}

#[async_trait]
impl Tool for CaptureScreenshotTool {
    fn name(&self) -> &str {
        "capture_screenshot"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "capture_screenshot".into(),
            description: "Capture the current desktop as a PNG image and return the saved file path. Useful for taking a screenshot of the user's screen outside the browser tool.".into(),
            input_schema: schema_object(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Optional output PNG path. Absolute paths are used as-is; relative paths are saved inside the chat screenshot directory."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)"
                    }
                }),
                &[],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let timeout_secs = input
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(30);
        let output_path = self.resolve_output_path(&input);
        let output_path_str = output_path.to_string_lossy().to_string();

        if let Err(msg) = crate::tools::path_guard::check_path(&output_path_str) {
            return ToolResult::error(msg);
        }

        if output_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| !ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false)
        {
            return ToolResult::error("Screenshot output path must end with .png".into());
        }

        if let Some(parent) = output_path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return ToolResult::error(format!(
                    "Failed to create screenshot directory {}: {e}",
                    parent.display()
                ));
            }
        }

        info!("Capturing desktop screenshot to {}", output_path.display());

        #[cfg(target_os = "linux")]
        let mut command = match Self::build_capture_command(&output_path) {
            Ok(cmd) => cmd,
            Err(err) => return ToolResult::error(err).with_error_type("missing_dependency"),
        };

        #[cfg(not(target_os = "linux"))]
        let mut command = Self::build_capture_command(&output_path);

        let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), async {
            command.kill_on_drop(true).output().await
        })
        .await;

        match result {
            Ok(Ok(output)) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let exit_code = output.status.code().unwrap_or(-1);

                if exit_code != 0 {
                    let mut details = String::new();
                    if !stdout.trim().is_empty() {
                        details.push_str(&stdout);
                    }
                    if !stderr.trim().is_empty() {
                        if !details.is_empty() {
                            details.push('\n');
                        }
                        details.push_str("STDERR:\n");
                        details.push_str(&stderr);
                    }
                    let details = if details.is_empty() {
                        format!("Screenshot command exited with code {exit_code}")
                    } else {
                        Self::truncate_output(&details)
                    };
                    return ToolResult::error(details)
                        .with_status_code(exit_code)
                        .with_error_type("process_exit");
                }

                match tokio::fs::metadata(&output_path).await {
                    Ok(metadata) if metadata.len() > 0 => ToolResult::success(format!(
                        "Saved desktop screenshot to {} ({} bytes)",
                        output_path.display(),
                        metadata.len()
                    )),
                    Ok(_) => ToolResult::error(format!(
                        "Screenshot command completed but produced an empty file at {}",
                        output_path.display()
                    ))
                    .with_error_type("empty_output"),
                    Err(e) => ToolResult::error(format!(
                        "Screenshot command completed but the file was not found at {}: {e}",
                        output_path.display()
                    ))
                    .with_error_type("missing_output"),
                }
            }
            Ok(Err(e)) => ToolResult::error(format!("Failed to execute screenshot command: {e}"))
                .with_error_type("spawn_error"),
            Err(_) => ToolResult::error(format!(
                "Desktop screenshot capture timed out after {timeout_secs} seconds"
            ))
            .with_error_type("timeout"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_screenshot_tool_definition() {
        let tool = CaptureScreenshotTool::new("/tmp/rayclaw-data");
        let def = tool.definition();
        assert_eq!(def.name, "capture_screenshot");
        assert!(def.description.contains("desktop"));
        assert!(def.input_schema["properties"]["path"].is_object());
        assert!(def.input_schema["properties"]["timeout_secs"].is_object());
    }

    #[test]
    fn test_capture_screenshot_default_output_path_uses_png() {
        let tool = CaptureScreenshotTool::new("/tmp/rayclaw-data");
        let path = tool.resolve_output_path(&json!({}));
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("png"));
        assert!(path.to_string_lossy().contains("desktop_screenshot_"));
    }
}
