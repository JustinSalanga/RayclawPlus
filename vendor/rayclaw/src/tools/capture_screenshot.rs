use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use windows_capture::monitor::Monitor;

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

use crate::llm_types::ToolDefinition;
#[cfg(not(target_os = "windows"))]
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

    #[cfg(not(target_os = "windows"))]
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
                        "description": "Optional monitor index to capture on Windows. Uses the OS monitor order with zero-based ids (0 = primary). If omitted, captures the primary monitor."
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

        #[cfg(target_os = "windows")]
        {
            let path = output_path.clone();
            let sid = screen_id;
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(timeout_secs),
                tokio::task::spawn_blocking(move || capture_native_windows(&path, sid)),
            )
            .await;

            match result {
                Ok(Ok(Ok(json_output))) => return ToolResult::success(json_output),
                Ok(Ok(Err(e))) => {
                    return ToolResult::error(format!("Screenshot capture failed: {e}"))
                        .with_error_type("capture_error")
                }
                Ok(Err(e)) => {
                    return ToolResult::error(format!("Screenshot task failed: {e}"))
                        .with_error_type("spawn_error")
                }
                Err(_) => {
                    return ToolResult::error(format!(
                        "Desktop screenshot capture timed out after {timeout_secs} seconds"
                    ))
                    .with_error_type("timeout")
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            #[cfg(target_os = "linux")]
            let mut command = match Self::build_capture_command(&output_path, screen_id) {
                Ok(cmd) => cmd,
                Err(err) => return ToolResult::error(err).with_error_type("missing_dependency"),
            };

            #[cfg(target_os = "macos")]
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
}

#[cfg(target_os = "windows")]
fn capture_native_windows(
    path: &Path,
    screen_id: Option<u32>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use std::time::Duration;

    use windows_capture::settings::MinimumUpdateIntervalSettings;

    let min_interval = MinimumUpdateIntervalSettings::Custom(Duration::ZERO);

    // Build [primary, ...others] so screen_id 0 = primary, 1 = second, etc. (no inverted index).
    let monitors_ordered = monitors_primary_first()?;
    let screen_count = monitors_ordered.len();

    let monitor = match screen_id {
        None | Some(0) => monitors_ordered.first().cloned().ok_or("No monitors")?,
        Some(id) => {
            let idx = id as usize;
            monitors_ordered
                .get(idx)
                .cloned()
                .ok_or_else(|| format!("screen_id {} out of range (0..{})", id, screen_count))?
        }
    };

    capture_single_monitor(path, screen_id, monitor, screen_count, min_interval)
}

/// Returns monitors with primary first, then others in enumeration order.
#[cfg(target_os = "windows")]
fn monitors_primary_first(
) -> Result<Vec<Monitor>, Box<dyn std::error::Error + Send + Sync>> {
    use windows_capture::monitor::Monitor;

    let primary = Monitor::primary()?;
    let primary_raw = primary.as_raw_hmonitor();
    let list = Monitor::enumerate()?;
    let mut ordered = Vec::with_capacity(list.len());
    ordered.push(primary);
    for m in list {
        if m.as_raw_hmonitor() != primary_raw {
            ordered.push(m);
        }
    }
    Ok(ordered)
}

#[cfg(target_os = "windows")]
fn capture_single_monitor(
    path: &Path,
    screen_id: Option<u32>,
    monitor: Monitor,
    screen_count: usize,
    min_interval: windows_capture::settings::MinimumUpdateIntervalSettings,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        SecondaryWindowSettings, Settings,
    };

    // Use actual monitor rect so cursor position and highlight are correct for this monitor.
    let (origin_x, origin_y) = monitor_rect_origin(monitor.as_raw_hmonitor());

    #[derive(Clone)]
    struct CaptureFlags {
        path: PathBuf,
        origin_x: i32,
        origin_y: i32,
    }

    struct SingleFrameCapture {
        path: PathBuf,
        origin_x: i32,
        origin_y: i32,
        done: bool,
    }

    impl GraphicsCaptureApiHandler for SingleFrameCapture {
        type Flags = CaptureFlags;
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                path: ctx.flags.path,
                origin_x: ctx.flags.origin_x,
                origin_y: ctx.flags.origin_y,
                done: false,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            if self.done {
                return Ok(());
            }
            self.done = true;

            let (cursor_x, cursor_y) = unsafe {
                let mut pt = std::mem::zeroed();
                if GetCursorPos(&mut pt).is_ok() {
                    (pt.x, pt.y)
                } else {
                    (0, 0)
                }
            };

            let frame_w = frame.width();
            let frame_h = frame.height();
            let cx = cursor_x - self.origin_x;
            let cy = cursor_y - self.origin_y;
            let cursor_visible =
                cx >= 0 && cx < frame_w as i32 && cy >= 0 && cy < frame_h as i32;

            let mut buf = frame.buffer()?;
            let pixels = buf.as_nopadding_buffer()?;
            let mut pixels = pixels.to_vec();

            if cursor_visible {
                draw_cursor_highlight_raw(&mut pixels, frame_w, frame_h, cx, cy, 16);
            }

            save_png_fast(&self.path, &pixels, frame_w, frame_h)?;

            capture_control.stop();
            Ok(())
        }
    }

    let settings = Settings::new(
        monitor.clone(),
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        min_interval,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        CaptureFlags {
            path: path.to_path_buf(),
            origin_x,
            origin_y,
        },
    );

    SingleFrameCapture::start(settings)?;

    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let (cursor_x, cursor_y, cursor_visible) = unsafe {
        let mut pt = std::mem::zeroed();
        if GetCursorPos(&mut pt).is_ok() {
            let w = monitor.width().unwrap_or(0) as i32;
            let h = monitor.height().unwrap_or(0) as i32;
            let visible = pt.x >= origin_x
                && pt.x < origin_x + w
                && pt.y >= origin_y
                && pt.y < origin_y + h;
            (pt.x, pt.y, visible)
        } else {
            (0, 0, false)
        }
    };

    let capture_scope = if screen_id.is_some() {
        "screen"
    } else {
        "virtual_desktop"
    };

    Ok(json!({
        "path": path.to_string_lossy(),
        "screen_id": screen_id,
        "device_name": Option::<String>::None,
        "origin_x": origin_x,
        "origin_y": origin_y,
        "width": monitor.width().unwrap_or(0),
        "height": monitor.height().unwrap_or(0),
        "scale": 1.0,
        "capture_scope": capture_scope,
        "screen_count": screen_count,
        "cursor_x": cursor_x,
        "cursor_y": cursor_y,
        "cursor_visible": cursor_visible,
        "bytes": file_size
    })
    .to_string())
}

/// Encode and write PNG with fast compression to minimize capture time.
#[cfg(target_os = "windows")]
fn save_png_fast(
    path: &Path,
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use std::io::BufWriter;

    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    let f = std::fs::File::create(path)?;
    let w = BufWriter::new(f);
    let encoder = PngEncoder::new_with_quality(w, CompressionType::Fast, FilterType::NoFilter);
    encoder
        .write_image(pixels, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;
    Ok(())
}

/// Draw cursor highlight ring on raw RGBA buffer (row-major, 4 bytes per pixel).
#[cfg(target_os = "windows")]
fn draw_cursor_highlight_raw(
    buf: &mut [u8],
    width: u32,
    height: u32,
    cx: i32,
    cy: i32,
    radius: i32,
) {
    let [r, g, b, a] = [255u8, 0, 0, 200];
    let stroke = 2i32;
    let inner = (radius - stroke).max(0);
    let inner_sq = inner * inner;
    let outer_sq = radius * radius;
    let width_i = width as i32;
    let height_i = height as i32;
    for x in -radius..=radius {
        for y in -radius..=radius {
            let d_sq = x * x + y * y;
            if d_sq >= inner_sq && d_sq <= outer_sq {
                let px = cx + x;
                let py = cy + y;
                if px >= 0 && py >= 0 && px < width_i && py < height_i {
                    let idx = ((py as u32) * width + (px as u32)) as usize * 4;
                    if idx + 3 < buf.len() {
                        buf[idx] = r;
                        buf[idx + 1] = g;
                        buf[idx + 2] = b;
                        buf[idx + 3] = a;
                    }
                }
            }
        }
    }
}

/// Returns the (left, top) of the monitor in screen coordinates. Used so cursor position
/// and highlight are correct for the captured monitor (no wrong-screen highlight).
#[cfg(target_os = "windows")]
fn monitor_rect_origin(hmonitor: *mut std::ffi::c_void) -> (i32, i32) {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};

    unsafe {
        let mut info = MONITORINFO {
            rcMonitor: std::mem::zeroed(),
            rcWork: std::mem::zeroed(),
            dwFlags: 0,
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        };
        if GetMonitorInfoW(HMONITOR(hmonitor as *mut _), &mut info).as_bool() {
            (info.rcMonitor.left, info.rcMonitor.top)
        } else {
            (0, 0)
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
