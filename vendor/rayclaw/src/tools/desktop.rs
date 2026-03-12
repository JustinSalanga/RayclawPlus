use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::json;

use crate::llm_types::ToolDefinition;
use crate::text::floor_char_boundary;

use super::{schema_object, Tool, ToolResult};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const FIND_TEXT_MATCH_MODE: &str = "contains_ignore_case";
const FIND_TEXT_VISION_FALLBACK: &str =
    "No matching text was found via UI Automation. Capture a screenshot and use vision to locate the target visually.";

pub struct MouseClickTool;
pub struct MouseMoveTool;
pub struct TypeTextTool;
pub struct PressKeyTool;
pub struct MouseScrollTool;
pub struct FindTextTool;
pub struct ListWindowsTool;
pub struct FocusWindowTool;
pub struct GetMousePositionTool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MouseButtonKind {
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyModifier {
    Control,
    Alt,
    Shift,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NamedKey {
    Return,
    Tab,
    Escape,
    Space,
    Backspace,
    Delete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    F(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyInput {
    Named(NamedKey),
    Character(char),
}

#[derive(Clone, Debug)]
struct ClickRequest {
    x: Option<f64>,
    y: Option<f64>,
    window_x: Option<f64>,
    window_y: Option<f64>,
    window_id: Option<String>,
    screenshot_x: Option<f64>,
    screenshot_y: Option<f64>,
    screenshot_origin_x: Option<f64>,
    screenshot_origin_y: Option<f64>,
    screenshot_scale: Option<f64>,
    screenshot_window_id: Option<String>,
    button: MouseButtonKind,
    button_name: String,
    click_count: u64,
}

#[derive(Clone, Debug)]
struct ScrollRequest {
    delta: i64,
    x: Option<i64>,
    y: Option<i64>,
}

#[derive(Clone, Debug)]
struct FindTextRequest {
    text: String,
    window_id: Option<String>,
    app_name: String,
    max_results: usize,
}

#[derive(Clone, Debug)]
struct FocusWindowRequest {
    hwnd: Option<String>,
    title: Option<String>,
    title_contains: Option<String>,
}

fn truncate_output(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }

    let cutoff = floor_char_boundary(text, limit);
    let mut truncated = text[..cutoff].to_string();
    truncated.push_str("\n... (output truncated)");
    truncated
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

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn build_find_text_response<T: serde::Serialize>(
    query: &str,
    matches: &[T],
    available_elements: &[String],
) -> String {
    let mut response = json!({
        "query": query,
        "match_type": FIND_TEXT_MATCH_MODE,
        "matches": matches,
    });

    if matches.is_empty() {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("available_elements".to_string(), json!(available_elements));
            obj.insert(
                "fallback_strategy".to_string(),
                json!("capture_screenshot_with_vision"),
            );
            obj.insert(
                "fallback_message".to_string(),
                json!(FIND_TEXT_VISION_FALLBACK),
            );
        }
    }

    response.to_string()
}

fn parse_button_kind(button: &str) -> Result<MouseButtonKind, String> {
    match button.trim().to_ascii_lowercase().as_str() {
        "left" => Ok(MouseButtonKind::Left),
        "right" => Ok(MouseButtonKind::Right),
        "middle" | "center" => Ok(MouseButtonKind::Middle),
        other => Err(format!(
            "Unsupported button '{other}'. Use left, right, center, or middle."
        )),
    }
}

fn parse_key_input(key: &str) -> Result<KeyInput, String> {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("Missing 'key' parameter".into());
    }

    let named = match normalized.as_str() {
        "enter" | "return" => Some(NamedKey::Return),
        "tab" => Some(NamedKey::Tab),
        "esc" | "escape" => Some(NamedKey::Escape),
        "space" => Some(NamedKey::Space),
        "backspace" => Some(NamedKey::Backspace),
        "delete" | "del" => Some(NamedKey::Delete),
        "insert" | "ins" => Some(NamedKey::Insert),
        "home" => Some(NamedKey::Home),
        "end" => Some(NamedKey::End),
        "pageup" | "page_up" => Some(NamedKey::PageUp),
        "pagedown" | "page_down" => Some(NamedKey::PageDown),
        "up" | "arrowup" => Some(NamedKey::Up),
        "down" | "arrowdown" => Some(NamedKey::Down),
        "left" | "arrowleft" => Some(NamedKey::Left),
        "right" | "arrowright" => Some(NamedKey::Right),
        "f1" => Some(NamedKey::F(1)),
        "f2" => Some(NamedKey::F(2)),
        "f3" => Some(NamedKey::F(3)),
        "f4" => Some(NamedKey::F(4)),
        "f5" => Some(NamedKey::F(5)),
        "f6" => Some(NamedKey::F(6)),
        "f7" => Some(NamedKey::F(7)),
        "f8" => Some(NamedKey::F(8)),
        "f9" => Some(NamedKey::F(9)),
        "f10" => Some(NamedKey::F(10)),
        "f11" => Some(NamedKey::F(11)),
        "f12" => Some(NamedKey::F(12)),
        _ => None,
    };

    if let Some(named) = named {
        return Ok(KeyInput::Named(named));
    }

    let mut chars = key.chars();
    let ch = chars
        .next()
        .ok_or_else(|| "Missing 'key' parameter".to_string())?;
    if chars.next().is_none() {
        Ok(KeyInput::Character(ch))
    } else {
        Err(format!("Unsupported key '{key}'"))
    }
}

fn parse_modifiers(raw: &[String]) -> Result<Vec<KeyModifier>, String> {
    raw.iter()
        .map(
            |modifier| match modifier.trim().to_ascii_lowercase().as_str() {
                "ctrl" | "control" => Ok(KeyModifier::Control),
                "alt" => Ok(KeyModifier::Alt),
                "shift" => Ok(KeyModifier::Shift),
                "win" | "meta" | "super" => {
                    Err("The Windows/meta modifier is not supported by press_key".into())
                }
                other => Err(format!("Unsupported modifier '{other}'")),
            },
        )
        .collect()
}

async fn run_desktop_operation<F>(timeout_secs: u64, operation: F) -> ToolResult
where
    F: FnOnce() -> Result<String> + Send + 'static,
{
    if !cfg!(target_os = "windows") {
        return ToolResult::error(
            "Desktop automation tools are currently supported on Windows only.".into(),
        )
        .with_error_type("unsupported_platform");
    }

    match tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(operation),
    )
    .await
    {
        Ok(Ok(Ok(output))) => ToolResult::success(truncate_output(&output, 12000)),
        Ok(Ok(Err(err))) => {
            ToolResult::error(err.to_string()).with_error_type("desktop_automation_failed")
        }
        Ok(Err(err)) => ToolResult::error(format!("Desktop automation task failed: {err}"))
            .with_error_type("desktop_automation_failed"),
        Err(_) => ToolResult::error(format!(
            "Desktop automation command timed out after {timeout_secs} seconds"
        ))
        .with_error_type("timeout"),
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::collections::{HashMap, HashSet};
    use std::path::Path;
    use std::sync::Once;
    use std::thread;
    use std::time::Duration;

    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use serde::Serialize;
    use uiautomation::core::UIAutomation;
    use uiautomation::types::Handle;
    use uiautomation::{UIElement, UITreeWalker};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, IsWindow, IsWindowVisible, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
    };

    use super::{
        anyhow, build_find_text_response, contains_ignore_case, json, ClickRequest, Context,
        FindTextRequest, FocusWindowRequest, KeyInput, KeyModifier, MouseButtonKind, NamedKey,
        Result, ScrollRequest,
    };

    static DPI_AWARE: Once = Once::new();

    #[derive(Clone, Serialize)]
    struct Bounds {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        width: i32,
        height: i32,
    }

    #[derive(Serialize)]
    struct WindowInfo {
        hwnd: String,
        title: String,
        process_id: u32,
        process_name: Option<String>,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        bounds: Bounds,
        is_visible: bool,
        is_foreground: bool,
    }

    #[derive(Serialize)]
    struct TextMatch {
        name: String,
        process_id: u32,
        process_name: Option<String>,
        control_type: String,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        center_x: i32,
        center_y: i32,
    }

    fn ensure_dpi_awareness() {
        DPI_AWARE.call_once(|| {});
    }

    fn automation() -> Result<UIAutomation> {
        ensure_dpi_awareness();
        UIAutomation::new().map_err(|err| anyhow!(err.to_string()))
    }

    fn format_hwnd(hwnd: isize) -> String {
        format!("0x{hwnd:X}")
    }

    fn parse_window_handle(raw: &str) -> Result<isize> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Window handle is required"));
        }

        if let Some(hex) = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
        {
            i64::from_str_radix(hex, 16)
                .map(|value| value as isize)
                .with_context(|| format!("Invalid window handle '{raw}'"))
        } else {
            trimmed
                .parse::<i64>()
                .map(|value| value as isize)
                .with_context(|| format!("Invalid window handle '{raw}'"))
        }
    }

    fn hwnd_as_handle(hwnd: isize) -> Handle {
        Handle::from(hwnd_from_isize(hwnd))
    }

    fn hwnd_from_isize(hwnd: isize) -> HWND {
        HWND(std::ptr::with_exposed_provenance_mut(hwnd as usize))
    }

    fn hwnd_to_isize(hwnd: HWND) -> isize {
        hwnd.0 as isize
    }

    fn is_window_valid(hwnd: isize) -> bool {
        unsafe { IsWindow(Some(hwnd_from_isize(hwnd))).as_bool() }
    }

    fn window_title(hwnd: isize) -> Option<String> {
        unsafe {
            let mut buffer = vec![0u16; 512];
            let len = GetWindowTextW(hwnd_from_isize(hwnd), &mut buffer);
            if len > 0 {
                buffer.truncate(len as usize);
                String::from_utf16(&buffer).ok()
            } else {
                None
            }
        }
    }

    fn child_elements(walker: &UITreeWalker, parent: &UIElement) -> Vec<UIElement> {
        let mut elements = Vec::new();
        if let Ok(first) = walker.get_first_child(parent) {
            elements.push(first);
            while let Some(current) = elements.last() {
                match walker.get_next_sibling(current) {
                    Ok(sibling) => elements.push(sibling),
                    Err(_) => break,
                }
            }
        }
        elements
    }

    fn is_window_visible(hwnd: isize) -> bool {
        unsafe { IsWindowVisible(hwnd_from_isize(hwnd)).as_bool() }
    }

    fn to_bounds(rect: &uiautomation::types::Rect) -> Bounds {
        let left = rect.get_left();
        let top = rect.get_top();
        let width = rect.get_width().max(0);
        let height = rect.get_height().max(0);
        Bounds {
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
        }
    }

    fn round_to_i32(value: f64, name: &str) -> Result<i32> {
        if !value.is_finite() {
            return Err(anyhow!("{name} must be a finite number"));
        }

        let rounded = value.round();
        if rounded < i32::MIN as f64 || rounded > i32::MAX as f64 {
            return Err(anyhow!("{name} is out of range"));
        }
        Ok(rounded as i32)
    }

    fn create_enigo() -> Result<Enigo> {
        Enigo::new(&Settings::default()).map_err(|err| anyhow!(err.to_string()))
    }

    fn to_enigo_button(button: MouseButtonKind) -> Button {
        match button {
            MouseButtonKind::Left => Button::Left,
            MouseButtonKind::Right => Button::Right,
            MouseButtonKind::Middle => Button::Middle,
        }
    }

    fn to_enigo_key(input: KeyInput) -> Key {
        match input {
            KeyInput::Character(ch) => Key::Unicode(ch),
            KeyInput::Named(NamedKey::Return) => Key::Return,
            KeyInput::Named(NamedKey::Tab) => Key::Tab,
            KeyInput::Named(NamedKey::Escape) => Key::Escape,
            KeyInput::Named(NamedKey::Space) => Key::Space,
            KeyInput::Named(NamedKey::Backspace) => Key::Backspace,
            KeyInput::Named(NamedKey::Delete) => Key::Delete,
            KeyInput::Named(NamedKey::Insert) => Key::Insert,
            KeyInput::Named(NamedKey::Home) => Key::Home,
            KeyInput::Named(NamedKey::End) => Key::End,
            KeyInput::Named(NamedKey::PageUp) => Key::PageUp,
            KeyInput::Named(NamedKey::PageDown) => Key::PageDown,
            KeyInput::Named(NamedKey::Up) => Key::UpArrow,
            KeyInput::Named(NamedKey::Down) => Key::DownArrow,
            KeyInput::Named(NamedKey::Left) => Key::LeftArrow,
            KeyInput::Named(NamedKey::Right) => Key::RightArrow,
            KeyInput::Named(NamedKey::F(1)) => Key::F1,
            KeyInput::Named(NamedKey::F(2)) => Key::F2,
            KeyInput::Named(NamedKey::F(3)) => Key::F3,
            KeyInput::Named(NamedKey::F(4)) => Key::F4,
            KeyInput::Named(NamedKey::F(5)) => Key::F5,
            KeyInput::Named(NamedKey::F(6)) => Key::F6,
            KeyInput::Named(NamedKey::F(7)) => Key::F7,
            KeyInput::Named(NamedKey::F(8)) => Key::F8,
            KeyInput::Named(NamedKey::F(9)) => Key::F9,
            KeyInput::Named(NamedKey::F(10)) => Key::F10,
            KeyInput::Named(NamedKey::F(11)) => Key::F11,
            KeyInput::Named(NamedKey::F(12)) => Key::F12,
            KeyInput::Named(NamedKey::F(_)) => unreachable!(),
        }
    }

    fn to_modifier_key(modifier: KeyModifier) -> Key {
        match modifier {
            KeyModifier::Control => Key::Control,
            KeyModifier::Alt => Key::Alt,
            KeyModifier::Shift => Key::Shift,
        }
    }

    fn process_name(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(process);

            if !ok || size == 0 {
                return None;
            }

            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            Path::new(&path)
                .file_stem()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        }
    }

    fn element_from_window_id(automation: &UIAutomation, raw: &str) -> Result<UIElement> {
        let hwnd = parse_window_handle(raw)?;
        automation
            .element_from_handle(hwnd_as_handle(hwnd))
            .map_err(|err| anyhow!(err.to_string()))
            .context("Window not found for the provided window_id")
    }

    fn element_bounds(automation: &UIAutomation, raw: &str) -> Result<Bounds> {
        let element = element_from_window_id(automation, raw)?;
        let rect = element
            .get_bounding_rectangle()
            .map_err(|err| anyhow!(err.to_string()))?;
        Ok(to_bounds(&rect))
    }

    fn list_windows_internal(
        title_filter: &str,
        app_name: &str,
        include_hidden: bool,
    ) -> Result<Vec<WindowInfo>> {
        let automation = automation()?;
        let root = automation
            .get_root_element()
            .map_err(|err| anyhow!(err.to_string()))?;
        let walker = automation
            .get_control_view_walker()
            .map_err(|err| anyhow!(err.to_string()))?;
        let foreground = hwnd_to_isize(unsafe { GetForegroundWindow() });

        let mut windows = Vec::new();
        for element in child_elements(&walker, &root) {
            let title = match element.get_name() {
                Ok(value) => value.trim().to_string(),
                Err(_) => continue,
            };
            if title.is_empty() {
                continue;
            }
            if !title_filter.is_empty() && !contains_ignore_case(&title, title_filter) {
                continue;
            }

            let hwnd = match element.get_native_window_handle() {
                Ok(handle) => {
                    let hwnd: isize = handle.into();
                    if hwnd == 0 {
                        continue;
                    }
                    hwnd
                }
                Err(_) => continue,
            };

            let visible = is_window_visible(hwnd);
            if !include_hidden && !visible {
                continue;
            }

            let process_id = element.get_process_id().unwrap_or_default();
            let process_name = if app_name.is_empty() {
                None
            } else {
                let name = process_name(process_id as u32);
                if !name
                    .as_deref()
                    .is_some_and(|n| contains_ignore_case(n, app_name))
                {
                    continue;
                }
                name
            };

            let rect = match element.get_bounding_rectangle() {
                Ok(rect) => rect,
                Err(_) => continue,
            };
            let bounds = to_bounds(&rect);

            windows.push(WindowInfo {
                hwnd: format_hwnd(hwnd),
                title,
                process_id,
                process_name,
                x: bounds.left,
                y: bounds.top,
                width: bounds.width,
                height: bounds.height,
                bounds,
                is_visible: visible,
                is_foreground: hwnd == foreground,
            });
        }

        Ok(windows)
    }

    pub fn click(request: ClickRequest) -> Result<String> {
        let automation = automation()?;
        let has_screen_coords = request.x.is_some() || request.y.is_some();
        let has_window_coords = request.window_x.is_some() || request.window_y.is_some();
        let has_screenshot_coords =
            request.screenshot_x.is_some() || request.screenshot_y.is_some();

        let (screen_x, screen_y, mode) = if has_screen_coords {
            let x = request.x.context("Provide both 'x' and 'y' together")?;
            let y = request.y.context("Provide both 'x' and 'y' together")?;
            (round_to_i32(x, "x")?, round_to_i32(y, "y")?, "screen")
        } else if has_window_coords {
            let window_x = request
                .window_x
                .context("Provide both 'window_x' and 'window_y' together")?;
            let window_y = request
                .window_y
                .context("Provide both 'window_x' and 'window_y' together")?;
            let window_id = request
                .window_id
                .as_deref()
                .context("window_x/window_y require 'window_id' or 'hwnd'")?;
            let bounds = element_bounds(&automation, window_id)?;
            (
                round_to_i32(bounds.left as f64 + window_x, "window_x")?,
                round_to_i32(bounds.top as f64 + window_y, "window_y")?,
                "window",
            )
        } else if has_screenshot_coords {
            let screenshot_x = request
                .screenshot_x
                .context("Provide both 'screenshot_x' and 'screenshot_y' together")?;
            let screenshot_y = request
                .screenshot_y
                .context("Provide both 'screenshot_x' and 'screenshot_y' together")?;

            if let (Some(origin_x), Some(origin_y)) =
                (request.screenshot_origin_x, request.screenshot_origin_y)
            {
                let scale = request
                    .screenshot_scale
                    .filter(|value| *value > 0.0)
                    .unwrap_or(1.0);
                (
                    round_to_i32(origin_x + (screenshot_x / scale), "screenshot_x")?,
                    round_to_i32(origin_y + (screenshot_y / scale), "screenshot_y")?,
                    "screenshot_meta",
                )
            } else if let Some(window_id) = request.screenshot_window_id.as_deref() {
                let bounds = element_bounds(&automation, window_id)?;
                (
                    round_to_i32(bounds.left as f64 + screenshot_x, "screenshot_x")?,
                    round_to_i32(bounds.top as f64 + screenshot_y, "screenshot_y")?,
                    "screenshot_window",
                )
            } else {
                return Err(anyhow!(
                    "screenshot_x/screenshot_y require screenshot_origin_x/screenshot_origin_y (+ optional screenshot_scale) or screenshot_window_id"
                ));
            }
        } else {
            return Err(anyhow!(
                "Provide x/y, window_x/window_y + window_id, or screenshot_x/screenshot_y + screenshot metadata"
            ));
        };

        let mut enigo = create_enigo()?;
        enigo
            .move_mouse(screen_x, screen_y, Coordinate::Abs)
            .map_err(|err| anyhow!(err.to_string()))?;

        let button = to_enigo_button(request.button);
        for index in 0..request.click_count {
            enigo
                .button(button, Direction::Click)
                .map_err(|err| anyhow!(err.to_string()))?;
            if index + 1 < request.click_count {
                thread::sleep(Duration::from_millis(90));
            }
        }

        Ok(json!({
            "action": "click",
            "mode": mode,
            "resolved_x": screen_x,
            "resolved_y": screen_y,
            "button": request.button_name,
            "click_count": request.click_count
        })
        .to_string())
    }

    pub fn type_text(text: String) -> Result<String> {
        let mut enigo = create_enigo()?;
        enigo.text(&text).map_err(|err| anyhow!(err.to_string()))?;
        Ok(json!({
            "action": "type_text",
            "length": text.chars().count()
        })
        .to_string())
    }

    pub fn press_key(
        key: KeyInput,
        modifiers: Vec<KeyModifier>,
        key_name: String,
    ) -> Result<String> {
        let mut enigo = create_enigo()?;
        for modifier in &modifiers {
            enigo
                .key(to_modifier_key(*modifier), Direction::Press)
                .map_err(|err| anyhow!(err.to_string()))?;
        }

        let key_result = enigo
            .key(to_enigo_key(key), Direction::Click)
            .map_err(|err| anyhow!(err.to_string()));

        let mut release_error = None;
        for modifier in modifiers.iter().rev() {
            if let Err(err) = enigo.key(to_modifier_key(*modifier), Direction::Release) {
                release_error.get_or_insert_with(|| anyhow!(err.to_string()));
            }
        }

        key_result?;
        if let Some(err) = release_error {
            return Err(err);
        }

        Ok(json!({
            "action": "press_key",
            "key": key_name,
            "modifiers": modifiers.iter().map(|modifier| match modifier {
                KeyModifier::Control => "ctrl",
                KeyModifier::Alt => "alt",
                KeyModifier::Shift => "shift",
            }).collect::<Vec<_>>()
        })
        .to_string())
    }

    pub fn scroll(request: ScrollRequest) -> Result<String> {
        let mut enigo = create_enigo()?;
        if let (Some(x), Some(y)) = (request.x, request.y) {
            enigo
                .move_mouse(x as i32, y as i32, Coordinate::Abs)
                .map_err(|err| anyhow!(err.to_string()))?;
        }

        let steps = if request.delta == 0 {
            0
        } else {
            let magnitude = ((request.delta.abs() + 299) / 300) as i32;
            if request.delta > 0 {
                -magnitude
            } else {
                magnitude
            }
        };

        if steps != 0 {
            enigo
                .scroll(steps, Axis::Vertical)
                .map_err(|err| anyhow!(err.to_string()))?;
        }

        Ok(json!({
            "action": "scroll",
            "delta": request.delta,
            "applied_steps": steps,
            "x": request.x,
            "y": request.y
        })
        .to_string())
    }

    pub fn find_text(request: FindTextRequest) -> Result<String> {
        let automation = automation()?;
        let root = if let Some(window_id) = request.window_id.as_deref() {
            element_from_window_id(&automation, window_id)?
        } else {
            automation
                .get_root_element()
                .map_err(|err| anyhow!(err.to_string()))?
        };
        let walker = automation
            .get_control_view_walker()
            .map_err(|err| anyhow!(err.to_string()))?;

        let mut available_elements = Vec::new();
        let mut seen_names = HashSet::new();
        let mut matches = Vec::new();
        let mut process_name_cache = HashMap::<u32, Option<String>>::new();

        let mut stack = child_elements(&walker, &root);
        stack.reverse();

        while let Some(element) = stack.pop() {
            let mut children = child_elements(&walker, &element);
            children.reverse();
            stack.extend(children);

            let name = match element.get_name() {
                Ok(name) => name.trim().to_string(),
                Err(_) => continue,
            };
            if name.is_empty() {
                continue;
            }

            if seen_names.len() < 50 && seen_names.insert(name.clone()) {
                available_elements.push(name.clone());
            }

            // Cheap text filter first to skip expensive work for non-matching elements
            if !contains_ignore_case(&name, &request.text) {
                continue;
            }

            let process_id = element.get_process_id().unwrap_or_default();
            let process_name = if request.app_name.is_empty() {
                None
            } else {
                process_name_cache
                    .entry(process_id)
                    .or_insert_with(|| process_name(process_id))
                    .clone()
            };
            if !request.app_name.is_empty()
                && !process_name
                    .as_deref()
                    .is_some_and(|value| contains_ignore_case(value, &request.app_name))
            {
                continue;
            }
            if element.is_offscreen().unwrap_or(false) {
                continue;
            }

            let rect = match element.get_bounding_rectangle() {
                Ok(rect) => rect,
                Err(_) => continue,
            };
            let bounds = to_bounds(&rect);
            if bounds.width <= 0 || bounds.height <= 0 {
                continue;
            }

            let control_type = element
                .get_control_type()
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|_| "Unknown".to_string());

            matches.push(TextMatch {
                name,
                process_id,
                process_name,
                control_type,
                x: bounds.left,
                y: bounds.top,
                width: bounds.width,
                height: bounds.height,
                center_x: bounds.left + (bounds.width / 2),
                center_y: bounds.top + (bounds.height / 2),
            });

            if matches.len() >= request.max_results {
                break;
            }
        }

        Ok(build_find_text_response(
            &request.text,
            &matches,
            &available_elements,
        ))
    }

    pub fn list_windows(
        title_filter: String,
        app_name: String,
        include_hidden: bool,
    ) -> Result<String> {
        Ok(serde_json::to_string(&list_windows_internal(
            &title_filter,
            &app_name,
            include_hidden,
        )?)?)
    }

    pub fn focus_window(request: FocusWindowRequest) -> Result<String> {
        let (hwnd, hwnd_str, title) = if let Some(raw) = request.hwnd.as_deref() {
            let hwnd = parse_window_handle(raw)?;
            let hwnd_str = format_hwnd(hwnd);
            if !is_window_valid(hwnd) {
                return Err(anyhow!("Window handle {hwnd_str} is not valid"));
            }
            let title = window_title(hwnd).unwrap_or_default();
            (hwnd, hwnd_str, title)
        } else {
            let windows = list_windows_internal("", "", true)?;
            let target = if let Some(title) = request.title.as_deref() {
                windows
                    .into_iter()
                    .find(|window| window.title.eq_ignore_ascii_case(title))
                    .context("No matching window found")?
            } else if let Some(title_contains) = request.title_contains.as_deref() {
                windows
                    .into_iter()
                    .find(|window| contains_ignore_case(&window.title, title_contains))
                    .context("No matching window found")?
            } else {
                return Err(anyhow!(
                    "Provide one of 'hwnd', 'title', or 'title_contains'"
                ));
            };
            let hwnd = parse_window_handle(&target.hwnd)?;
            (hwnd, target.hwnd.clone(), target.title)
        };

        unsafe {
            let _ = ShowWindow(hwnd_from_isize(hwnd), SW_RESTORE);
        }
        thread::sleep(Duration::from_millis(120));
        let focused = unsafe { SetForegroundWindow(hwnd_from_isize(hwnd)).as_bool() };

        let automation = automation()?;
        if let Ok(element) = automation.element_from_handle(hwnd_as_handle(hwnd)) {
            let _ = element.set_focus();
        }

        let is_foreground = hwnd_to_isize(unsafe { GetForegroundWindow() }) == hwnd;
        Ok(json!({
            "action": "focus_window",
            "hwnd": hwnd_str,
            "title": title,
            "focused": focused || is_foreground
        })
        .to_string())
    }

    pub fn get_mouse_position() -> Result<String> {
        let enigo = create_enigo()?;
        let (x, y) = enigo.location().map_err(|err| anyhow!(err.to_string()))?;
        Ok(json!({
            "x": x,
            "y": y
        })
        .to_string())
    }

    pub fn mouse_move(x: i32, y: i32) -> Result<String> {
        let mut enigo = create_enigo()?;
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|err| anyhow!(err.to_string()))?;
        Ok(json!({
            "action": "mouse_move",
            "x": x,
            "y": y
        })
        .to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::*;

    fn unsupported() -> Result<String> {
        Err(anyhow!(
            "Desktop automation tools are currently supported on Windows only."
        ))
    }

    pub fn click(_request: ClickRequest) -> Result<String> {
        unsupported()
    }

    pub fn type_text(_text: String) -> Result<String> {
        unsupported()
    }

    pub fn press_key(
        _key: KeyInput,
        _modifiers: Vec<KeyModifier>,
        _key_name: String,
    ) -> Result<String> {
        unsupported()
    }

    pub fn scroll(_request: ScrollRequest) -> Result<String> {
        unsupported()
    }

    pub fn find_text(_request: FindTextRequest) -> Result<String> {
        unsupported()
    }

    pub fn list_windows(
        _title_filter: String,
        _app_name: String,
        _include_hidden: bool,
    ) -> Result<String> {
        unsupported()
    }

    pub fn focus_window(_request: FocusWindowRequest) -> Result<String> {
        unsupported()
    }

    pub fn get_mouse_position() -> Result<String> {
        unsupported()
    }

    pub fn mouse_move(_x: i32, _y: i32) -> Result<String> {
        unsupported()
    }
}

#[async_trait]
impl Tool for MouseClickTool {
    fn name(&self) -> &str {
        "mouse_click"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mouse_click".into(),
            description: "Click at a position on screen. Supports three coordinate modes: (1) absolute screen coordinates via x/y, (2) window-relative coordinates via window_x/window_y + window_id, and (3) screenshot coordinates via screenshot_x/screenshot_y plus either screenshot origin metadata or a screenshot_window_id. Prefer screenshot or window-relative coordinates when you derived the target from find_text or capture_screenshot; use raw screen coordinates only as a last resort."
                .into(),
            input_schema: schema_object(
                json!({
                    "x": {
                        "type": "number",
                        "description": "Absolute screen X coordinate."
                    },
                    "y": {
                        "type": "number",
                        "description": "Absolute screen Y coordinate."
                    },
                    "window_x": {
                        "type": "number",
                        "description": "X coordinate relative to the top-left of a target window (requires window_id/hwnd)."
                    },
                    "window_y": {
                        "type": "number",
                        "description": "Y coordinate relative to the top-left of a target window (requires window_id/hwnd)."
                    },
                    "window_id": {
                        "type": ["string", "integer"],
                        "description": "Window handle from list_windows used with window_x/window_y for window-relative clicks."
                    },
                    "hwnd": {
                        "type": ["string", "integer"],
                        "description": "Alias for window_id."
                    },
                    "screenshot_x": {
                        "type": "number",
                        "description": "X pixel coordinate from a screenshot (in screenshot pixels, not screen coordinates)."
                    },
                    "screenshot_y": {
                        "type": "number",
                        "description": "Y pixel coordinate from a screenshot (in screenshot pixels, not screen coordinates)."
                    },
                    "screenshot_origin_x": {
                        "type": "number",
                        "description": "Screenshot origin X from capture_screenshot metadata, used to convert screenshot_x into absolute screen coordinates."
                    },
                    "screenshot_origin_y": {
                        "type": "number",
                        "description": "Screenshot origin Y from capture_screenshot metadata, used to convert screenshot_y into absolute screen coordinates."
                    },
                    "screenshot_scale": {
                        "type": "number",
                        "description": "Screenshot scale from capture_screenshot metadata (default: 1.0). Use when the screenshot is scaled relative to the native desktop resolution."
                    },
                    "screenshot_window_id": {
                        "type": ["string", "integer"],
                        "description": "Window handle the screenshot was taken from, used to convert screenshot_x/screenshot_y relative to that window into absolute screen coordinates."
                    },
                    "button": {
                        "type": "string",
                        "description": "Mouse button: left, right, center, or middle (default: left). Use right for context menus, and click_count 2 for double-click."
                    },
                    "clicks": {
                        "type": "integer",
                        "description": "Alias for click_count."
                    },
                    "click_count": {
                        "type": "integer",
                        "description": "How many times to click (default: 1). Use 2 for a double-click."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
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

        let button_kind = match parse_button_kind(&button) {
            Ok(value) => value,
            Err(err) => return ToolResult::error(err),
        };

        let request = ClickRequest {
            x,
            y,
            window_x,
            window_y,
            window_id,
            screenshot_x,
            screenshot_y,
            screenshot_origin_x,
            screenshot_origin_y,
            screenshot_scale,
            screenshot_window_id,
            button: button_kind,
            button_name: button,
            click_count,
        };

        run_desktop_operation(timeout_secs, move || platform::click(request)).await
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
            description: "Type a string into the currently focused desktop window using OS-level keyboard input. Use after focus_window and a mouse_click have placed the caret in the correct input field; for special keys or shortcuts, use press_key instead."
                .into(),
            input_schema: schema_object(
                json!({
                    "text": {
                        "type": "string",
                        "description": "The exact text to type into the focused window. Text is sent as if typed on a physical keyboard."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
                    }
                }),
                &["text"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let text = match input.get("text").and_then(|v| v.as_str()) {
            Some(value) => value.to_string(),
            None => return ToolResult::error("Missing 'text' parameter".into()),
        };
        let timeout_secs = parse_timeout_secs(&input);

        run_desktop_operation(timeout_secs, move || platform::type_text(text)).await
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
            description: "Press a single key or key combination (with ctrl, alt, and/or shift) in the currently focused desktop window. Use for shortcuts such as Ctrl+S, Alt+Tab, or navigation keys like Enter, Tab, and arrows."
                .into(),
            input_schema: schema_object(
                json!({
                    "key": {
                        "type": "string",
                        "description": "Key to press, for example enter, tab, escape, space, backspace, delete, up, down, left, right, f5, or a single character like a or 1."
                    },
                    "modifiers": {
                        "type": "array",
                        "description": "Optional modifiers combined with key for shortcuts. Supported: ctrl, alt, shift. The Windows/meta modifier is intentionally not supported.",
                        "items": {
                            "type": "string"
                        }
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
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
        let modifiers_raw: Vec<String> = input
            .get("modifiers")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|value| value.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let timeout_secs = parse_timeout_secs(&input);

        let key_input = match parse_key_input(key) {
            Ok(value) => value,
            Err(err) => return ToolResult::error(err),
        };
        let modifiers = match parse_modifiers(&modifiers_raw) {
            Ok(value) => value,
            Err(err) => return ToolResult::error(err),
        };
        let key_name = key.to_string();

        run_desktop_operation(timeout_secs, move || {
            platform::press_key(key_input, modifiers, key_name)
        })
        .await
    }
}

#[async_trait]
impl Tool for MouseScrollTool {
    fn name(&self) -> &str {
        "mouse_scroll"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mouse_scroll".into(),
            description: "Scroll the mouse wheel at the current cursor position (or an optional target position). Positive delta scrolls up; negative delta scrolls down. Use to navigate scrollable content after positioning the cursor with mouse_move if needed."
                .into(),
            input_schema: schema_object(
                json!({
                    "delta": {
                        "type": "integer",
                        "description": "Wheel delta. Use positive values to scroll up and negative values to scroll down. Typical step magnitude: around 300 for a visible scroll."
                    },
                    "x": {
                        "type": "integer",
                        "description": "Optional absolute screen X coordinate. If provided with y, the cursor is moved here before scrolling."
                    },
                    "y": {
                        "type": "integer",
                        "description": "Optional absolute screen Y coordinate. If provided with x, the cursor is moved here before scrolling."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
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

        let request = ScrollRequest { delta, x, y };
        run_desktop_operation(timeout_secs, move || platform::scroll(request)).await
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
            description: "Search for text on screen using Windows UI Automation with case-insensitive contains matching and return matching UI elements with screen coordinates ready for mouse_click. Prefer this over screenshots when you know the label or text of a UI element; when there are no matches, the response includes available element names and a screenshot-plus-vision fallback strategy."
                .into(),
            input_schema: schema_object(
                json!({
                    "text": {
                        "type": "string",
                        "description": "Text or label substring to search for using case-insensitive contains matching. For example: 'Save', 'OK', or part of a menu item label."
                    },
                    "window_id": {
                        "type": ["string", "integer"],
                        "description": "Optional window handle from list_windows to scope the search to a single window."
                    },
                    "hwnd": {
                        "type": ["string", "integer"],
                        "description": "Alias for window_id."
                    },
                    "app_name": {
                        "type": "string",
                        "description": "Optional process/app name filter. When set, only elements belonging to matching processes are considered."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of matches to return (default: 10). Each match includes name, control_type, bounding box, and center_x/center_y ready for mouse_click."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
                    }
                }),
                &["text"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let text = match input.get("text").and_then(|v| v.as_str()) {
            Some(value) if !value.trim().is_empty() => value.trim().to_string(),
            _ => return ToolResult::error("Missing 'text' parameter".into()),
        };
        let window_id =
            parse_stringish(&input, "window_id").or_else(|| parse_stringish(&input, "hwnd"));
        let app_name = input
            .get("app_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let max_results = input
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(10)
            .max(1) as usize;
        let timeout_secs = parse_timeout_secs(&input);

        let request = FindTextRequest {
            text,
            window_id,
            app_name,
            max_results,
        };
        run_desktop_operation(timeout_secs, move || platform::find_text(request)).await
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
            description: "Enumerate visible top-level desktop windows with their titles, window handles (hwnd), process ids, process names, positions, sizes, and foreground status. Use this before any window-targeted operation to discover the correct hwnd and confirm which window is active."
                .into(),
            input_schema: schema_object(
                json!({
                    "title_filter": {
                        "type": "string",
                        "description": "Optional case-insensitive substring filter for window titles to narrow results, for example 'chrome' or 'notepad'."
                    },
                    "app_name": {
                        "type": "string",
                        "description": "Optional case-insensitive substring filter for process/app name, for example 'chrome' or 'notepad'."
                    },
                    "include_hidden": {
                        "type": "boolean",
                        "description": "Whether to include non-visible (hidden or off-screen) windows (default: false)."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
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
            .unwrap_or("")
            .to_string();
        let app_name = input
            .get("app_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let include_hidden = input
            .get("include_hidden")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let timeout_secs = parse_timeout_secs(&input);

        run_desktop_operation(timeout_secs, move || {
            platform::list_windows(title_filter, app_name, include_hidden)
        })
        .await
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
            description: "Bring a desktop window to the foreground by window handle or title match, restoring it if minimized. Use this before clicking or typing so input goes to the correct application window; typically you call list_windows first to discover the right hwnd or title."
                .into(),
            input_schema: schema_object(
                json!({
                    "hwnd": {
                        "type": "string",
                        "description": "Window handle from list_windows, for example '0x12345'. Use this when you already know the exact window to focus."
                    },
                    "title": {
                        "type": "string",
                        "description": "Exact window title match. Case-insensitive equality is used."
                    },
                    "title_contains": {
                        "type": "string",
                        "description": "Case-insensitive substring match for a window title, useful when the full title may vary (e.g. includes a file name)."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
                    }
                }),
                &[],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let hwnd = input
            .get("hwnd")
            .and_then(|v| v.as_str())
            .map(|value| value.to_string());
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .map(|value| value.to_string());
        let title_contains = input
            .get("title_contains")
            .and_then(|v| v.as_str())
            .map(|value| value.to_string());
        let timeout_secs = parse_timeout_secs(&input);

        if hwnd.is_none() && title.is_none() && title_contains.is_none() {
            return ToolResult::error("Provide one of 'hwnd', 'title', or 'title_contains'".into());
        }

        let request = FocusWindowRequest {
            hwnd,
            title,
            title_contains,
        };
        run_desktop_operation(timeout_secs, move || platform::focus_window(request)).await
    }
}

#[async_trait]
impl Tool for MouseMoveTool {
    fn name(&self) -> &str {
        "mouse_move"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "mouse_move".into(),
            description: "Move the mouse cursor to an absolute screen position without clicking. Use this to hover over elements (for tooltips or hover states), to prepare for a subsequent mouse_click, or to position the cursor before scrolling."
                .into(),
            input_schema: schema_object(
                json!({
                    "x": {
                        "type": "number",
                        "description": "Target absolute screen X coordinate."
                    },
                    "y": {
                        "type": "number",
                        "description": "Target absolute screen Y coordinate."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
                    }
                }),
                &["x", "y"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let x = match parse_number(&input, "x") {
            Some(v) if v.is_finite() => v.round() as i32,
            Some(_) => return ToolResult::error("'x' must be a finite number".into()),
            None => return ToolResult::error("Missing required parameter 'x'".into()),
        };
        let y = match parse_number(&input, "y") {
            Some(v) if v.is_finite() => v.round() as i32,
            Some(_) => return ToolResult::error("'y' must be a finite number".into()),
            None => return ToolResult::error("Missing required parameter 'y'".into()),
        };
        let timeout_secs = parse_timeout_secs(&input);

        run_desktop_operation(timeout_secs, move || platform::mouse_move(x, y)).await
    }
}

#[async_trait]
impl Tool for GetMousePositionTool {
    fn name(&self) -> &str {
        "get_mouse_position"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "get_mouse_position".into(),
            description: "Get the current mouse cursor position in absolute screen coordinates. Use this to verify where the cursor landed after mouse_move or mouse_click, or to debug unexpected click locations."
                .into(),
            input_schema: schema_object(
                json!({
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30)."
                    }
                }),
                &[],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let timeout_secs = parse_timeout_secs(&input);
        run_desktop_operation(timeout_secs, platform::get_mouse_position).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn test_parse_key_input_named_key() {
        assert_eq!(
            parse_key_input("enter").unwrap(),
            KeyInput::Named(NamedKey::Return)
        );
        assert_eq!(
            parse_key_input("F5").unwrap(),
            KeyInput::Named(NamedKey::F(5))
        );
    }

    #[test]
    fn test_parse_key_input_character() {
        assert_eq!(parse_key_input("a").unwrap(), KeyInput::Character('a'));
    }

    #[test]
    fn test_parse_modifiers() {
        let modifiers = vec!["ctrl".to_string(), "shift".to_string()];
        assert_eq!(
            parse_modifiers(&modifiers).unwrap(),
            vec![KeyModifier::Control, KeyModifier::Shift]
        );
    }

    #[test]
    fn test_contains_ignore_case_uses_substring_matching() {
        assert!(contains_ignore_case("Save As", "save"));
        assert!(contains_ignore_case("Save As", "as"));
        assert!(!contains_ignore_case("Save As", "open"));
    }

    #[test]
    fn test_build_find_text_response_includes_fallback_when_empty() {
        let response =
            build_find_text_response::<Value>("submit", &[], &["Save".into(), "Cancel".into()]);
        let parsed: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(parsed["query"], "submit");
        assert_eq!(parsed["match_type"], FIND_TEXT_MATCH_MODE);
        assert_eq!(
            parsed["fallback_strategy"],
            "capture_screenshot_with_vision"
        );
        assert_eq!(parsed["fallback_message"], FIND_TEXT_VISION_FALLBACK);
        assert!(parsed["available_elements"].is_array());
    }

    #[test]
    fn test_build_find_text_response_omits_fallback_when_matches_exist() {
        let response = build_find_text_response(&"submit", &[json!({ "name": "Submit" })], &[]);
        let parsed: Value = serde_json::from_str(&response).unwrap();

        assert_eq!(parsed["query"], "submit");
        assert_eq!(parsed["match_type"], FIND_TEXT_MATCH_MODE);
        assert!(parsed.get("fallback_strategy").is_none());
        assert!(parsed.get("fallback_message").is_none());
    }
}
