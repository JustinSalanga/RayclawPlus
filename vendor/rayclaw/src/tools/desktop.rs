use async_trait::async_trait;
use serde_json::json;
use tokio::process::Command;

use crate::llm_types::ToolDefinition;
use crate::text::floor_char_boundary;

use super::{schema_object, Tool, ToolResult};

const DEFAULT_TIMEOUT_SECS: u64 = 30;

pub struct ClickTool;
pub struct TypeTextTool;
pub struct PressKeyTool;
pub struct ScrollTool;
pub struct FindTextTool;
pub struct ListWindowsTool;
pub struct FocusWindowTool;

fn truncate_output(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }

    let cutoff = floor_char_boundary(text, limit);
    let mut truncated = text[..cutoff].to_string();
    truncated.push_str("\n... (output truncated)");
    truncated
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn parse_timeout_secs(input: &serde_json::Value) -> u64 {
    input
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
}

fn parse_number(input: &serde_json::Value, key: &str) -> Option<f64> {
    let value = input.get(key)?;
    if let Some(num) = value.as_f64() {
        Some(num)
    } else if let Some(text) = value.as_str() {
        text.trim().parse::<f64>().ok()
    } else {
        None
    }
}

fn parse_stringish(input: &serde_json::Value, key: &str) -> Option<String> {
    let value = input.get(key)?;
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else if value.is_number() {
        Some(value.to_string())
    } else {
        None
    }
}

fn ps_number_or_null(value: Option<f64>) -> String {
    value
        .map(|v| {
            if v.fract() == 0.0 {
                format!("{v:.0}")
            } else {
                v.to_string()
            }
        })
        .unwrap_or_else(|| "$null".to_string())
}

#[cfg(target_os = "windows")]
async fn run_powershell(script: String, timeout_secs: u64) -> ToolResult {
    let mut command = Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-STA")
        .arg("-Command")
        .arg(script);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        command.kill_on_drop(true).output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let exit_code = output.status.code().unwrap_or(-1);

            let mut text = String::new();
            if !stdout.trim().is_empty() {
                text.push_str(stdout.trim());
            }
            if !stderr.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str("STDERR:\n");
                text.push_str(stderr.trim());
            }
            if text.is_empty() {
                text = format!("Command completed with exit code {exit_code}");
            }

            let text = truncate_output(&text, 12000);
            if exit_code == 0 {
                ToolResult::success(text).with_status_code(exit_code)
            } else {
                ToolResult::error(text)
                    .with_status_code(exit_code)
                    .with_error_type("desktop_automation_failed")
            }
        }
        Ok(Err(err)) => ToolResult::error(format!("Failed to launch PowerShell: {err}"))
            .with_error_type("desktop_automation_failed"),
        Err(_) => ToolResult::error(format!(
            "Desktop automation command timed out after {timeout_secs} seconds"
        ))
        .with_error_type("timeout"),
    }
}

#[cfg(not(target_os = "windows"))]
async fn run_powershell(_script: String, _timeout_secs: u64) -> ToolResult {
    ToolResult::error("Desktop automation tools are currently supported on Windows only.".into())
        .with_error_type("unsupported_platform")
}

fn send_keys_token(key: &str) -> Result<String, String> {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("Missing 'key' parameter".into());
    }

    let token = match normalized.as_str() {
        "enter" | "return" => "{ENTER}".to_string(),
        "tab" => "{TAB}".to_string(),
        "esc" | "escape" => "{ESC}".to_string(),
        "space" => " ".to_string(),
        "backspace" => "{BACKSPACE}".to_string(),
        "delete" | "del" => "{DELETE}".to_string(),
        "insert" | "ins" => "{INSERT}".to_string(),
        "home" => "{HOME}".to_string(),
        "end" => "{END}".to_string(),
        "pageup" | "page_up" => "{PGUP}".to_string(),
        "pagedown" | "page_down" => "{PGDN}".to_string(),
        "up" | "arrowup" => "{UP}".to_string(),
        "down" | "arrowdown" => "{DOWN}".to_string(),
        "left" | "arrowleft" => "{LEFT}".to_string(),
        "right" | "arrowright" => "{RIGHT}".to_string(),
        "f1" => "{F1}".to_string(),
        "f2" => "{F2}".to_string(),
        "f3" => "{F3}".to_string(),
        "f4" => "{F4}".to_string(),
        "f5" => "{F5}".to_string(),
        "f6" => "{F6}".to_string(),
        "f7" => "{F7}".to_string(),
        "f8" => "{F8}".to_string(),
        "f9" => "{F9}".to_string(),
        "f10" => "{F10}".to_string(),
        "f11" => "{F11}".to_string(),
        "f12" => "{F12}".to_string(),
        _ => {
            if key.chars().count() == 1 {
                encode_send_keys_text(key)
            } else {
                return Err(format!("Unsupported key '{key}'"));
            }
        }
    };

    Ok(token)
}

fn encode_send_keys_text(text: &str) -> String {
    let mut encoded = String::new();
    for ch in text.chars() {
        match ch {
            '\r' => {}
            '\n' => encoded.push_str("{ENTER}"),
            '\t' => encoded.push_str("{TAB}"),
            '+' => encoded.push_str("{+}"),
            '^' => encoded.push_str("{^}"),
            '%' => encoded.push_str("{%}"),
            '~' => encoded.push_str("{~}"),
            '(' => encoded.push_str("{(}"),
            ')' => encoded.push_str("{)}"),
            '{' => encoded.push_str("{{}"),
            '}' => encoded.push_str("{}}"),
            '[' => encoded.push_str("{[}"),
            ']' => encoded.push_str("{]}"),
            _ => encoded.push(ch),
        }
    }
    encoded
}

fn send_keys_with_modifiers(key: &str, modifiers: &[String]) -> Result<String, String> {
    let mut encoded = String::new();
    for modifier in modifiers {
        match modifier.trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => encoded.push('^'),
            "alt" => encoded.push('%'),
            "shift" => encoded.push('+'),
            "win" | "meta" | "super" => {
                return Err("The Windows/meta modifier is not supported by press_key".into())
            }
            other => return Err(format!("Unsupported modifier '{other}'")),
        }
    }
    encoded.push_str(&send_keys_token(key)?);
    Ok(encoded)
}

fn user32_script() -> &'static str {
    r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DesktopAutomationNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
"#
}

#[async_trait]
impl Tool for ClickTool {
    fn name(&self) -> &str {
        "click"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "click".into(),
            description: "Click at screen coordinates. Supports raw screen coordinates, window-relative coordinates, and screenshot metadata for deterministic coordinate conversion.".into(),
            input_schema: schema_object(
                json!({
                    "x": {
                        "type": "number",
                        "description": "Screen X coordinate"
                    },
                    "y": {
                        "type": "number",
                        "description": "Screen Y coordinate"
                    },
                    "window_x": {
                        "type": "number",
                        "description": "X coordinate relative to the target window"
                    },
                    "window_y": {
                        "type": "number",
                        "description": "Y coordinate relative to the target window"
                    },
                    "window_id": {
                        "type": ["string", "integer"],
                        "description": "Window handle from list_windows, used with window_x/window_y"
                    },
                    "hwnd": {
                        "type": ["string", "integer"],
                        "description": "Alias for window_id"
                    },
                    "screenshot_x": {
                        "type": "number",
                        "description": "X pixel coordinate from a screenshot"
                    },
                    "screenshot_y": {
                        "type": "number",
                        "description": "Y pixel coordinate from a screenshot"
                    },
                    "screenshot_origin_x": {
                        "type": "number",
                        "description": "Screenshot origin X from capture_screenshot metadata"
                    },
                    "screenshot_origin_y": {
                        "type": "number",
                        "description": "Screenshot origin Y from capture_screenshot metadata"
                    },
                    "screenshot_scale": {
                        "type": "number",
                        "description": "Screenshot scale from capture_screenshot metadata (default: 1.0)"
                    },
                    "screenshot_window_id": {
                        "type": ["string", "integer"],
                        "description": "Window handle the screenshot was taken from, used for window-scoped screenshots"
                    },
                    "button": {
                        "type": "string",
                        "description": "Mouse button: left, right, center, or middle (default: left)"
                    },
                    "clicks": {
                        "type": "integer",
                        "description": "Alias for click_count"
                    },
                    "click_count": {
                        "type": "integer",
                        "description": "How many times to click (default: 1)"
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
        let x = parse_number(&input, "x");
        let y = parse_number(&input, "y");
        let window_x = parse_number(&input, "window_x");
        let window_y = parse_number(&input, "window_y");
        let screenshot_x = parse_number(&input, "screenshot_x");
        let screenshot_y = parse_number(&input, "screenshot_y");
        let screenshot_origin_x = parse_number(&input, "screenshot_origin_x");
        let screenshot_origin_y = parse_number(&input, "screenshot_origin_y");
        let screenshot_scale = parse_number(&input, "screenshot_scale");
        let window_id =
            parse_stringish(&input, "window_id").or_else(|| parse_stringish(&input, "hwnd"));
        let screenshot_window_id = parse_stringish(&input, "screenshot_window_id");
        let button = input
            .get("button")
            .and_then(|v| v.as_str())
            .unwrap_or("left")
            .to_ascii_lowercase();
        let click_count = input
            .get("click_count")
            .and_then(|v| v.as_u64())
            .or_else(|| input.get("clicks").and_then(|v| v.as_u64()))
            .unwrap_or(1)
            .max(1);
        let timeout_secs = parse_timeout_secs(&input);

        let has_screen_coords = x.is_some() || y.is_some();
        let has_window_coords = window_x.is_some() || window_y.is_some();
        let has_screenshot_coords = screenshot_x.is_some() || screenshot_y.is_some();
        if has_screen_coords && (x.is_none() || y.is_none()) {
            return ToolResult::error("Provide both 'x' and 'y' together".into());
        }
        if has_window_coords && (window_x.is_none() || window_y.is_none()) {
            return ToolResult::error("Provide both 'window_x' and 'window_y' together".into());
        }
        if has_screenshot_coords && (screenshot_x.is_none() || screenshot_y.is_none()) {
            return ToolResult::error(
                "Provide both 'screenshot_x' and 'screenshot_y' together".into(),
            );
        }
        if !has_screen_coords && !has_window_coords && !has_screenshot_coords {
            return ToolResult::error(
                "Provide x/y, window_x/window_y + window_id, or screenshot_x/screenshot_y + screenshot metadata"
                    .into(),
            );
        }

        let (down_flag, up_flag) = match button.as_str() {
            "left" => ("0x0002", "0x0004"),
            "right" => ("0x0008", "0x0010"),
            "middle" | "center" => ("0x0020", "0x0040"),
            _ => {
                return ToolResult::error(format!(
                    "Unsupported button '{button}'. Use left, right, center, or middle."
                ))
            }
        };

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
{}
[void][DesktopAutomationNative]::SetProcessDPIAware()
$rawX = {}
$rawY = {}
$windowX = {}
$windowY = {}
$windowIdInput = {}
$screenshotX = {}
$screenshotY = {}
$screenshotOriginX = {}
$screenshotOriginY = {}
$screenshotScale = {}
$screenshotWindowIdInput = {}

function Parse-WindowHandle([string]$value) {{
    if ([string]::IsNullOrWhiteSpace($value)) {{
        throw "Window handle is required"
    }}
    $trimmed = $value.Trim()
    if ($trimmed.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {{
        return [IntPtr]::new([Convert]::ToInt64($trimmed.Substring(2), 16))
    }}
    return [IntPtr]::new([Convert]::ToInt64($trimmed, 10))
}}

function Get-WindowBounds([IntPtr]$hWnd) {{
    $rect = New-Object DesktopAutomationNative+RECT
    if (-not [DesktopAutomationNative]::GetWindowRect($hWnd, [ref]$rect)) {{
        throw "Failed to query window bounds"
    }}
    [pscustomobject]@{{
        left = $rect.Left
        top = $rect.Top
        width = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
    }}
}}

$screenX = $null
$screenY = $null
$mode = $null

if ($rawX -ne $null -and $rawY -ne $null) {{
    $screenX = $rawX
    $screenY = $rawY
    $mode = 'screen'
}} elseif ($windowX -ne $null -and $windowY -ne $null) {{
    $targetWindow = Parse-WindowHandle $windowIdInput
    $bounds = Get-WindowBounds $targetWindow
    $screenX = $bounds.left + $windowX
    $screenY = $bounds.top + $windowY
    $mode = 'window'
}} elseif ($screenshotX -ne $null -and $screenshotY -ne $null) {{
    if ($screenshotOriginX -ne $null -and $screenshotOriginY -ne $null) {{
        if ($screenshotScale -eq $null -or $screenshotScale -le 0) {{
            $screenshotScale = 1.0
        }}
        $screenX = $screenshotOriginX + ($screenshotX / $screenshotScale)
        $screenY = $screenshotOriginY + ($screenshotY / $screenshotScale)
        $mode = 'screenshot_meta'
    }} elseif (-not [string]::IsNullOrWhiteSpace($screenshotWindowIdInput)) {{
        $targetWindow = Parse-WindowHandle $screenshotWindowIdInput
        $bounds = Get-WindowBounds $targetWindow
        $screenX = $bounds.left + $screenshotX
        $screenY = $bounds.top + $screenshotY
        $mode = 'screenshot_window'
    }} else {{
        throw "screenshot_x/screenshot_y require screenshot_origin_x/screenshot_origin_y (+ optional screenshot_scale) or screenshot_window_id"
    }}
}} else {{
    throw "Unable to resolve click coordinates"
}}

$screenXInt = [int][Math]::Round($screenX)
$screenYInt = [int][Math]::Round($screenY)
[void][DesktopAutomationNative]::SetCursorPos($screenXInt, $screenYInt)
for ($i = 0; $i -lt {}; $i++) {{
    [DesktopAutomationNative]::mouse_event({}, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [DesktopAutomationNative]::mouse_event({}, 0, 0, 0, [UIntPtr]::Zero)
    if ($i + 1 -lt {}) {{
        Start-Sleep -Milliseconds 90
    }}
}}
[pscustomobject]@{{
    action = 'click'
    mode = $mode
    resolved_x = $screenXInt
    resolved_y = $screenYInt
    button = '{}'
    click_count = {}
}} | ConvertTo-Json -Compress
"#,
            user32_script(),
            ps_number_or_null(x),
            ps_number_or_null(y),
            ps_number_or_null(window_x),
            ps_number_or_null(window_y),
            ps_quote(window_id.as_deref().unwrap_or("")),
            ps_number_or_null(screenshot_x),
            ps_number_or_null(screenshot_y),
            ps_number_or_null(screenshot_origin_x),
            ps_number_or_null(screenshot_origin_y),
            ps_number_or_null(screenshot_scale),
            ps_quote(screenshot_window_id.as_deref().unwrap_or("")),
            click_count,
            down_flag,
            up_flag,
            click_count,
            button,
            click_count
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for TypeTextTool {
    fn name(&self) -> &str {
        "type_text"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "type_text".into(),
            description: "Type text into the currently focused desktop window. Use after focus_window or click places the caret in the target input.".into(),
            input_schema: schema_object(
                json!({
                    "text": {
                        "type": "string",
                        "description": "The exact text to type into the focused window"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)"
                    }
                }),
                &["text"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let text = match input.get("text").and_then(|v| v.as_str()) {
            Some(value) => value,
            None => return ToolResult::error("Missing 'text' parameter".into()),
        };
        let timeout_secs = parse_timeout_secs(&input);
        let encoded = encode_send_keys_text(text);

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait({})
[pscustomobject]@{{
    action = 'type_text'
    length = {}
}} | ConvertTo-Json -Compress
"#,
            ps_quote(&encoded),
            text.chars().count()
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for PressKeyTool {
    fn name(&self) -> &str {
        "press_key"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "press_key".into(),
            description: "Press a key or key combination in the currently focused desktop window. Supports modifiers ctrl, alt, and shift.".into(),
            input_schema: schema_object(
                json!({
                    "key": {
                        "type": "string",
                        "description": "Key to press, for example enter, tab, escape, up, down, f5, a"
                    },
                    "modifiers": {
                        "type": "array",
                        "description": "Optional modifiers: ctrl, alt, shift",
                        "items": {
                            "type": "string"
                        }
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)"
                    }
                }),
                &["key"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let key = match input.get("key").and_then(|v| v.as_str()) {
            Some(value) => value,
            None => return ToolResult::error("Missing 'key' parameter".into()),
        };
        let modifiers: Vec<String> = input
            .get("modifiers")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let timeout_secs = parse_timeout_secs(&input);

        let encoded = match send_keys_with_modifiers(key, &modifiers) {
            Ok(value) => value,
            Err(err) => return ToolResult::error(err),
        };
        let modifiers_json = serde_json::to_string(&modifiers).unwrap_or_else(|_| "[]".to_string());

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$modifiers = {} | ConvertFrom-Json
[System.Windows.Forms.SendKeys]::SendWait({})
[pscustomobject]@{{
    action = 'press_key'
    key = {}
    modifiers = $modifiers
}} | ConvertTo-Json -Compress
"#,
            ps_quote(&modifiers_json),
            ps_quote(&encoded),
            ps_quote(key),
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for ScrollTool {
    fn name(&self) -> &str {
        "scroll"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "scroll".into(),
            description: "Scroll the mouse wheel on the desktop. Positive delta scrolls up; negative delta scrolls down.".into(),
            input_schema: schema_object(
                json!({
                    "delta": {
                        "type": "integer",
                        "description": "Wheel delta. Use positive values to scroll up and negative values to scroll down. Typical step: 120."
                    },
                    "x": {
                        "type": "integer",
                        "description": "Optional X coordinate to move the cursor before scrolling"
                    },
                    "y": {
                        "type": "integer",
                        "description": "Optional Y coordinate to move the cursor before scrolling"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)"
                    }
                }),
                &["delta"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let delta = match input.get("delta").and_then(|v| v.as_i64()) {
            Some(value) => value,
            None => return ToolResult::error("Missing 'delta' parameter".into()),
        };
        let x = input.get("x").and_then(|v| v.as_i64());
        let y = input.get("y").and_then(|v| v.as_i64());
        if x.is_some() ^ y.is_some() {
            return ToolResult::error(
                "Provide both 'x' and 'y' together when positioning the cursor".into(),
            );
        }
        let timeout_secs = parse_timeout_secs(&input);

        let cursor_move = match (x, y) {
            (Some(x), Some(y)) => {
                format!("[void][DesktopAutomationNative]::SetCursorPos({x}, {y})")
            }
            _ => String::new(),
        };

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
{}
[void][DesktopAutomationNative]::SetProcessDPIAware()
{}
$wheelData = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]({})), 0)
[DesktopAutomationNative]::mouse_event(0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
[pscustomobject]@{{
    action = 'scroll'
    delta = {}
    x = {}
    y = {}
}} | ConvertTo-Json -Compress
"#,
            user32_script(),
            cursor_move,
            delta,
            delta,
            x.map(|v| v.to_string())
                .unwrap_or_else(|| "$null".to_string()),
            y.map(|v| v.to_string())
                .unwrap_or_else(|| "$null".to_string())
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for FindTextTool {
    fn name(&self) -> &str {
        "find_text"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "find_text".into(),
            description: "Find text on screen using Windows UI Automation and return screen coordinates ready for click. Prefer this over guessing coordinates from screenshots for buttons, labels, and menu items.".into(),
            input_schema: schema_object(
                json!({
                    "text": {
                        "type": "string",
                        "description": "Text or label to search for"
                    },
                    "window_id": {
                        "type": ["string", "integer"],
                        "description": "Optional window handle from list_windows to scope the search"
                    },
                    "hwnd": {
                        "type": ["string", "integer"],
                        "description": "Alias for window_id"
                    },
                    "app_name": {
                        "type": "string",
                        "description": "Optional process/app name filter"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of matches to return (default: 10)"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)"
                    }
                }),
                &["text"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let text = match input.get("text").and_then(|v| v.as_str()) {
            Some(value) if !value.trim().is_empty() => value.trim(),
            _ => return ToolResult::error("Missing 'text' parameter".into()),
        };
        let window_id =
            parse_stringish(&input, "window_id").or_else(|| parse_stringish(&input, "hwnd"));
        let app_name = input.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
        let max_results = input
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(10)
            .max(1);
        let timeout_secs = parse_timeout_secs(&input);

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
{}
[void][DesktopAutomationNative]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$searchText = {}
$windowIdInput = {}
$appNameFilter = {}
$maxResults = {}

function Parse-WindowHandle([string]$value) {{
    if ([string]::IsNullOrWhiteSpace($value)) {{
        throw "Window handle is required"
    }}
    $trimmed = $value.Trim()
    if ($trimmed.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {{
        return [IntPtr]::new([Convert]::ToInt64($trimmed.Substring(2), 16))
    }}
    return [IntPtr]::new([Convert]::ToInt64($trimmed, 10))
}}

$root = [System.Windows.Automation.AutomationElement]::RootElement
if (-not [string]::IsNullOrWhiteSpace($windowIdInput)) {{
    $root = [System.Windows.Automation.AutomationElement]::FromHandle((Parse-WindowHandle $windowIdInput))
    if ($null -eq $root) {{
        throw "Window not found for the provided window_id"
    }}
}}

$pidNameCache = @{{}}
function Get-ProcessNameForPid([int]$pid) {{
    if ($pidNameCache.ContainsKey($pid)) {{
        return $pidNameCache[$pid]
    }}
    $name = ''
    try {{
        $name = (Get-Process -Id $pid -ErrorAction Stop).ProcessName
    }} catch {{}}
    $pidNameCache[$pid] = $name
    return $name
}}

$matches = New-Object System.Collections.Generic.List[object]
$available = New-Object System.Collections.Generic.HashSet[string]
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
for ($i = 0; $i -lt $all.Count; $i++) {{
    $el = $all.Item($i)
    try {{
        $name = $el.Current.Name
        $pid = [int]$el.Current.ProcessId
        $controlType = $el.Current.ControlType.ProgrammaticName
        $rect = $el.Current.BoundingRectangle
    }} catch {{
        continue
    }}

    if ([string]::IsNullOrWhiteSpace($name)) {{
        continue
    }}
    [void]$available.Add($name)

    if ($rect.Width -le 0 -or $rect.Height -le 0) {{
        continue
    }}

    $processName = Get-ProcessNameForPid $pid
    $processNameForMatch = if ($null -eq $processName) {{ '' }} else {{ [string]$processName }}
    if (-not [string]::IsNullOrEmpty($appNameFilter) -and ($processNameForMatch.IndexOf($appNameFilter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) {{
        continue
    }}
    if ($name.IndexOf($searchText, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {{
        continue
    }}

    $matches.Add([pscustomobject]@{{
        name = $name
        process_id = $pid
        process_name = $processName
        control_type = $controlType
        x = [int][Math]::Round($rect.Left)
        y = [int][Math]::Round($rect.Top)
        width = [int][Math]::Round($rect.Width)
        height = [int][Math]::Round($rect.Height)
        center_x = [int][Math]::Round($rect.Left + ($rect.Width / 2))
        center_y = [int][Math]::Round($rect.Top + ($rect.Height / 2))
    }}) | Out-Null

    if ($matches.Count -ge $maxResults) {{
        break
    }}
}}

if ($matches.Count -gt 0) {{
    [pscustomobject]@{{
        query = $searchText
        matches = $matches
    }} | ConvertTo-Json -Depth 5 -Compress
}} else {{
    [pscustomobject]@{{
        query = $searchText
        matches = @()
        available_elements = @($available | Select-Object -First 50)
    }} | ConvertTo-Json -Depth 5 -Compress
}}
"#,
            user32_script(),
            ps_quote(text),
            ps_quote(window_id.as_deref().unwrap_or("")),
            ps_quote(app_name),
            max_results
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for ListWindowsTool {
    fn name(&self) -> &str {
        "list_windows"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "list_windows".into(),
            description: "List visible top-level desktop windows with their titles, window handles, process ids, and foreground status.".into(),
            input_schema: schema_object(
                json!({
                    "title_filter": {
                        "type": "string",
                        "description": "Optional substring filter for window titles"
                    },
                    "app_name": {
                        "type": "string",
                        "description": "Optional substring filter for process/app name"
                    },
                    "include_hidden": {
                        "type": "boolean",
                        "description": "Whether to include hidden windows (default: false)"
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
        let title_filter = input
            .get("title_filter")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let app_name = input.get("app_name").and_then(|v| v.as_str()).unwrap_or("");
        let include_hidden = input
            .get("include_hidden")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let timeout_secs = parse_timeout_secs(&input);

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
{}
[void][DesktopAutomationNative]::SetProcessDPIAware()
$titleFilter = {}
$appNameFilter = {}
$includeHidden = {}
$foreground = [DesktopAutomationNative]::GetForegroundWindow()
$items = New-Object System.Collections.Generic.List[object]

[DesktopAutomationNative]::EnumWindows({{
    param($hWnd, $lParam)

    $visible = [DesktopAutomationNative]::IsWindowVisible($hWnd)
    if (-not $includeHidden -and -not $visible) {{
        return $true
    }}

    $length = [DesktopAutomationNative]::GetWindowTextLengthW($hWnd)
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][DesktopAutomationNative]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) {{
        return $true
    }}
    if (-not [string]::IsNullOrEmpty($titleFilter) -and $title.IndexOf($titleFilter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {{
        return $true
    }}

    $windowPid = 0
    [void][DesktopAutomationNative]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    $processName = $null
    try {{
        $processName = (Get-Process -Id $windowPid -ErrorAction Stop).ProcessName
    }} catch {{}}
    $processNameForMatch = if ($null -eq $processName) {{ '' }} else {{ [string]$processName }}
    if (-not [string]::IsNullOrEmpty($appNameFilter) -and ($processNameForMatch.IndexOf($appNameFilter, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) {{
        return $true
    }}

    $rect = New-Object DesktopAutomationNative+RECT
    if (-not [DesktopAutomationNative]::GetWindowRect($hWnd, [ref]$rect)) {{
        return $true
    }}

    $items.Add([pscustomobject]@{{
        hwnd = ('0x{{0:X}}' -f $hWnd.ToInt64())
        title = $title
        process_id = $windowPid
        process_name = $processName
        x = $rect.Left
        y = $rect.Top
        width = ($rect.Right - $rect.Left)
        height = ($rect.Bottom - $rect.Top)
        bounds = [pscustomobject]@{{
            left = $rect.Left
            top = $rect.Top
            right = $rect.Right
            bottom = $rect.Bottom
            width = ($rect.Right - $rect.Left)
            height = ($rect.Bottom - $rect.Top)
        }}
        is_visible = $visible
        is_foreground = ($hWnd -eq $foreground)
    }}) | Out-Null
    return $true
}}, [IntPtr]::Zero) | Out-Null

$items | ConvertTo-Json -Depth 4 -Compress
"#,
            user32_script(),
            ps_quote(title_filter),
            ps_quote(app_name),
            if include_hidden { "$true" } else { "$false" }
        );

        run_powershell(script, timeout_secs).await
    }
}

#[async_trait]
impl Tool for FocusWindowTool {
    fn name(&self) -> &str {
        "focus_window"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "focus_window".into(),
            description: "Bring a desktop window to the foreground by window handle or title match. Prefer list_windows first when you need to inspect titles.".into(),
            input_schema: schema_object(
                json!({
                    "hwnd": {
                        "type": "string",
                        "description": "Window handle from list_windows, for example 0x12345"
                    },
                    "title": {
                        "type": "string",
                        "description": "Exact window title match"
                    },
                    "title_contains": {
                        "type": "string",
                        "description": "Case-insensitive substring match for a window title"
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
        let hwnd = input.get("hwnd").and_then(|v| v.as_str());
        let title = input.get("title").and_then(|v| v.as_str());
        let title_contains = input.get("title_contains").and_then(|v| v.as_str());
        let timeout_secs = parse_timeout_secs(&input);

        if hwnd.is_none() && title.is_none() && title_contains.is_none() {
            return ToolResult::error("Provide one of 'hwnd', 'title', or 'title_contains'".into());
        }

        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
{}
$hwndInput = {}
$titleExact = {}
$titleContains = {}

function Get-WindowTitle([IntPtr]$hWnd) {{
    $length = [DesktopAutomationNative]::GetWindowTextLengthW($hWnd)
    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][DesktopAutomationNative]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
    $builder.ToString()
}}

$target = [IntPtr]::Zero
$matchedTitle = $null

if (-not [string]::IsNullOrWhiteSpace($hwndInput)) {{
    $raw = $hwndInput.Trim()
    if ($raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)) {{
        $value = [Convert]::ToInt64($raw.Substring(2), 16)
    }} else {{
        $value = [Convert]::ToInt64($raw, 10)
    }}
    $target = [IntPtr]::new($value)
    $matchedTitle = Get-WindowTitle $target
}}

if ($target -eq [IntPtr]::Zero) {{
    [DesktopAutomationNative]::EnumWindows({{
        param($hWnd, $lParam)
        if (-not [DesktopAutomationNative]::IsWindowVisible($hWnd)) {{
            return $true
        }}

        $windowTitle = Get-WindowTitle $hWnd
        if ([string]::IsNullOrWhiteSpace($windowTitle)) {{
            return $true
        }}

        $isMatch = $false
        if (-not [string]::IsNullOrWhiteSpace($titleExact)) {{
            $isMatch = $windowTitle.Equals($titleExact, [System.StringComparison]::OrdinalIgnoreCase)
        }} elseif (-not [string]::IsNullOrWhiteSpace($titleContains)) {{
            $isMatch = $windowTitle.IndexOf($titleContains, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }}

        if ($isMatch) {{
            $script:target = $hWnd
            $script:matchedTitle = $windowTitle
            return $false
        }}

        return $true
    }}, [IntPtr]::Zero) | Out-Null
}}

if ($target -eq [IntPtr]::Zero) {{
    throw 'No matching window found'
}}

[void][DesktopAutomationNative]::ShowWindowAsync($target, 9)
Start-Sleep -Milliseconds 120
$focused = [DesktopAutomationNative]::SetForegroundWindow($target)

[pscustomobject]@{{
    action = 'focus_window'
    hwnd = ('0x{{0:X}}' -f $target.ToInt64())
    title = $matchedTitle
    focused = [bool]$focused
}} | ConvertTo-Json -Compress
"#,
            user32_script(),
            ps_quote(hwnd.unwrap_or("")),
            ps_quote(title.unwrap_or("")),
            ps_quote(title_contains.unwrap_or(""))
        );

        run_powershell(script, timeout_secs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_send_keys_text_escapes_special_chars() {
        assert_eq!(
            encode_send_keys_text("+^%~(){}[]\n\t"),
            "{+}{^}{%}{~}{(}{)}{{}{}}{[}{]}{ENTER}{TAB}"
        );
    }

    #[test]
    fn test_send_keys_token_named_key() {
        assert_eq!(send_keys_token("enter").unwrap(), "{ENTER}");
        assert_eq!(send_keys_token("F5").unwrap(), "{F5}");
    }

    #[test]
    fn test_send_keys_with_modifiers() {
        let modifiers = vec!["ctrl".to_string(), "shift".to_string()];
        assert_eq!(send_keys_with_modifiers("a", &modifiers).unwrap(), "^+a");
    }
}
