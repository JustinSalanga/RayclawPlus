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
        let provided = input
            .get("path")
            .and_then(|v| v.as_str())
            .map(PathBuf::from);
        match provided {
            Some(path) if path.is_absolute() => path,
            Some(path) => base_dir.join(path),
            None => {
                let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
                base_dir.join(format!("desktop_screenshot_{timestamp}.png"))
            }
        }
    }

    fn parse_screen_id(input: &serde_json::Value) -> Result<Option<u32>, String> {
        let Some(value) = input.get("screen_id") else {
            return Ok(None);
        };

        if let Some(id) = value.as_u64() {
            return u32::try_from(id)
                .map(Some)
                .map_err(|_| "screen_id is too large".to_string());
        }

        if let Some(text) = value.as_str() {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }

            let id = trimmed
                .parse::<u32>()
                .map_err(|_| "screen_id must be a non-negative integer".to_string())?;
            return Ok(Some(id));
        }

        Err("screen_id must be a non-negative integer".to_string())
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
    fn build_capture_command(path: &Path, screen_id: Option<u32>) -> tokio::process::Command {
        let escaped_path = path.to_string_lossy().replace('\'', "''");
        let screen_id_line = screen_id
            .map(|id| format!("$screenId = {id}"))
            .unwrap_or_else(|| "$screenId = $null".to_string());
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public static class RayclawScreenshotNative {{
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}}
"@
[void][RayclawScreenshotNative]::SetProcessDPIAware()
{screen_id_line}
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screenId -ne $null) {{
  if ($screenId -lt 0 -or $screenId -ge $screens.Length) {{
    Write-Error "Invalid screen_id $screenId. Available screen ids: 0..$($screens.Length - 1)"
    exit 2
  }}
  $screen = $screens[$screenId]
  $bounds = $screen.Bounds
  $deviceName = $screen.DeviceName
}} else {{
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $deviceName = $null
}}
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)

$cursorPos = [System.Windows.Forms.Cursor]::Position
$cursorScreenX = $cursorPos.X
$cursorScreenY = $cursorPos.Y
$cx = $cursorPos.X - $bounds.Left
$cy = $cursorPos.Y - $bounds.Top
$cursorVisible = ($cx -ge 0 -and $cx -lt $bounds.Width -and $cy -ge 0 -and $cy -lt $bounds.Height)
if ($cursorVisible) {{
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $outerSize = 32
  $outerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 0, 0)), 3
  $graphics.DrawEllipse($outerPen, ($cx - $outerSize/2), ($cy - $outerSize/2), $outerSize, $outerSize)
  $outerPen.Dispose()
  $innerSize = 6
  $innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 0, 0))
  $graphics.FillEllipse($innerBrush, ($cx - $innerSize/2), ($cy - $innerSize/2), $innerSize, $innerSize)
  $innerBrush.Dispose()
  $crossLen = 8
  $crossPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 0, 0)), 2
  $graphics.DrawLine($crossPen, ($cx - $crossLen), $cy, ($cx + $crossLen), $cy)
  $graphics.DrawLine($crossPen, $cx, ($cy - $crossLen), $cx, ($cy + $crossLen))
  $crossPen.Dispose()
}}

$bitmap.Save('{escaped_path}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{{
  path = '{escaped_path}'
  screen_id = $screenId
  device_name = $deviceName
  origin_x = $bounds.Left
  origin_y = $bounds.Top
  width = $bounds.Width
  height = $bounds.Height
  scale = 1.0
  capture_scope = $(if ($screenId -ne $null) {{ 'screen' }} else {{ 'virtual_desktop' }})
  screen_count = $screens.Length
  cursor_x = $cursorScreenX
  cursor_y = $cursorScreenY
  cursor_visible = $cursorVisible
}} | ConvertTo-Json -Compress
"#,
            screen_id_line = screen_id_line
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
    fn build_capture_command(path: &Path, _screen_id: Option<u32>) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("screencapture");
        cmd.arg("-x").arg(path);
        cmd
    }

    #[cfg(target_os = "linux")]
    fn build_capture_command(
        path: &Path,
        _screen_id: Option<u32>,
    ) -> Result<tokio::process::Command, String> {
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
            description: "Capture the current desktop as a PNG image and return the saved file path plus screenshot coordinate metadata. Useful for taking a screenshot of the user's screen outside the browser tool and converting screenshot pixels back to screen coordinates.".into(),
            input_schema: schema_object(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Optional output PNG path. Absolute paths are used as-is; relative paths are saved inside the chat screenshot directory."
                    },
                    "screen_id": {
                        "type": ["integer", "string"],
                        "description": "Optional monitor index to capture on Windows. Uses Screen.AllScreens order with zero-based ids. If omitted, captures the full virtual desktop."
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
        let screen_id = match Self::parse_screen_id(&input) {
            Ok(value) => value,
            Err(err) => return ToolResult::error(err),
        };
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

        #[cfg(not(target_os = "windows"))]
        if screen_id.is_some() {
            return ToolResult::error("screen_id is currently supported on Windows only".into());
        }

        #[cfg(target_os = "linux")]
        let mut command = match Self::build_capture_command(&output_path, screen_id) {
            Ok(cmd) => cmd,
            Err(err) => return ToolResult::error(err).with_error_type("missing_dependency"),
        };

        #[cfg(not(target_os = "linux"))]
        let mut command = Self::build_capture_command(&output_path, screen_id);

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
                    Ok(metadata) if metadata.len() > 0 => {
                        #[cfg(target_os = "windows")]
                        {
                            if let Ok(mut value) =
                                serde_json::from_str::<serde_json::Value>(stdout.trim())
                            {
                                if let Some(obj) = value.as_object_mut() {
                                    obj.insert("bytes".to_string(), json!(metadata.len()));
                                }
                                return ToolResult::success(value.to_string());
                            }
                        }

                        ToolResult::success(format!(
                            "Saved desktop screenshot to {} ({} bytes)",
                            output_path.display(),
                            metadata.len()
                        ))
                    }
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
        assert!(def.input_schema["properties"]["screen_id"].is_object());
        assert!(def.input_schema["properties"]["timeout_secs"].is_object());
    }

    #[test]
    fn test_capture_screenshot_default_output_path_uses_png() {
        let tool = CaptureScreenshotTool::new("/tmp/rayclaw-data");
        let path = tool.resolve_output_path(&json!({}));
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("png"));
        assert!(path.to_string_lossy().contains("desktop_screenshot_"));
    }

    #[test]
    fn test_parse_screen_id_accepts_integer_and_string() {
        assert_eq!(
            CaptureScreenshotTool::parse_screen_id(&json!({ "screen_id": 1 })).unwrap(),
            Some(1)
        );
        assert_eq!(
            CaptureScreenshotTool::parse_screen_id(&json!({ "screen_id": "2" })).unwrap(),
            Some(2)
        );
        assert_eq!(
            CaptureScreenshotTool::parse_screen_id(&json!({ "screen_id": "   " })).unwrap(),
            None
        );
    }

    #[test]
    fn test_parse_screen_id_rejects_invalid_values() {
        assert!(CaptureScreenshotTool::parse_screen_id(&json!({ "screen_id": -1 })).is_err());
        assert!(CaptureScreenshotTool::parse_screen_id(&json!({ "screen_id": "abc" })).is_err());
    }
}
