/// Tauri commands for RGB lighting control.
///
/// These replace the Electron `ipcMain.handle()` handlers in `electron-main.cjs`.
/// All commands are called from the renderer via `invoke('command_name', args)`.

use std::time::Duration;
use tauri::State;
use hidapi::HidApi;

use crate::hid::protocol::{
    RgbParams, SideRgbParams, LightingMode, ColorType,
    build_rgb_packet, build_side_rgb_packet, build_rgb_packet as build_perkey_approx_packet,
    speed_pct_to_wire, brightness_pct_to_wire,
};
use crate::hid::device::{find_rgb_device_path, send_feature_report};
use crate::hid::poller::PollGuard;

/// IPC response payload — matches the JS `{ success: bool, message: string }` shape.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct IpcResult {
    pub success: bool,
    pub message: String,
}

impl IpcResult {
    pub fn ok(message: impl Into<String>) -> Self { Self { success: true,  message: message.into() } }
    pub fn err(message: impl Into<String>) -> Self { Self { success: false, message: message.into() } }
}

// ─── Helper: resolve mode number from string-or-number ───────────────────────

/// The JS renderer sends `effectMode` as a string name (e.g. `"static"`) or
/// occasionally as a raw number. Resolve to `LightingMode`.
fn resolve_mode(effect_mode: &serde_json::Value) -> LightingMode {
    match effect_mode {
        serde_json::Value::Number(n) => {
            n.as_u64()
                .and_then(|v| LightingMode::from_wire(v as u8))
                .unwrap_or(LightingMode::Static)
        }
        serde_json::Value::String(s) => {
            LightingMode::from_name(s).unwrap_or(LightingMode::Static)
        }
        _ => LightingMode::Static,
    }
}

// ─── Command: send_native_hid_rgb ────────────────────────────────────────────

/// Payload from the renderer for the main RGB lighting command.
/// Matches the JS `{ r, g, b, effectMode, speed, brightness, colorType, direction }`.
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendRgbPayload {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// Effect mode: string name ("static", "wave", …) or raw mode number.
    pub effect_mode: serde_json::Value,
    /// Speed as a UI percentage (25 / 50 / 75 / 100).
    pub speed: Option<u8>,
    /// Brightness as a UI percentage (0..=100).
    pub brightness: Option<u8>,
    /// Color type: "custom" or "rainbow". If absent, determined from mode.
    pub color_type: Option<String>,
    /// Direction: 0=left, 1=right, 2=up, 3=down.
    pub direction: Option<u8>,
}

/// `send-native-hid-rgb` — replaces `ipcMain.handle('send-native-hid-rgb', ...)`.
#[tauri::command]
pub fn send_native_hid_rgb(
    payload: SendRgbPayload,
    guard: State<'_, PollGuard>,
) -> IpcResult {
    // Suppress hardware poller for 1 second after sending
    guard.suppress(Duration::from_secs(1));

    let api = match HidApi::new() {
        Ok(a) => a,
        Err(e) => return IpcResult::err(format!("HidApi init failed: {e}")),
    };

    let path = match find_rgb_device_path(&api) {
        Some(p) => p,
        None => return IpcResult::err(format!(
            "Klavye RGB arayüzü bulunamadı. (VID:0x3151 IF:2 UP:0xffff)"
        )),
    };

    let mode = resolve_mode(&payload.effect_mode);

    let color_type = match payload.color_type.as_deref() {
        Some("rainbow") => ColorType::Rainbow,
        Some("custom")  => ColorType::Custom,
        _ => ColorType::default_for_mode(mode),
    };

    let speed_pct      = payload.speed.unwrap_or(75).clamp(25, 100);
    let brightness_pct = payload.brightness.unwrap_or(100).clamp(0, 100);
    let speed_wire     = speed_pct_to_wire(speed_pct);
    let brightness_wire= brightness_pct_to_wire(brightness_pct);
    let direction      = payload.direction.unwrap_or(0) & 0x0F;

    let params = RgbParams {
        r: payload.r,
        g: payload.g,
        b: payload.b,
        mode,
        speed_wire,
        brightness_wire,
        color_type,
        direction,
    };

    let packet = build_rgb_packet(&params);

    match send_feature_report(&api, &path, &packet) {
        Ok(()) => {
            tracing::info!(
                mode = ?mode,
                speed_wire,
                brightness_wire,
                flags = ?color_type,
                "HID RGB packet sent"
            );
            IpcResult::ok(format!(
                "✅ Donanım Modu #{} uygulandı (Hız Tel:{}, Parlaklık:{}/4)",
                mode.wire_byte(), speed_wire, brightness_wire
            ))
        }
        Err(e) => {
            tracing::error!(error = %e, "HID send failed");
            IpcResult::err(format!("HID Hatası: {e}"))
        }
    }
}

// ─── Command: send_native_side_rgb ───────────────────────────────────────────

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendSideRgbPayload {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// Side light mode: 0=off, 1=static, 2=breathing, 3=spectrum, 4=wave, 5=snake.
    pub side_mode: Option<u8>,
    pub speed: Option<u8>,
    pub brightness: Option<u8>,
    /// Raw flags byte (0x07=custom, 0x08=rainbow). If None, derived from color_type.
    pub flags: Option<u8>,
}

/// `send-native-side-rgb` — replaces `ipcMain.handle('send-native-side-rgb', ...)`.
#[tauri::command]
pub fn send_native_side_rgb(payload: SendSideRgbPayload) -> IpcResult {
    let api = match HidApi::new() {
        Ok(a) => a,
        Err(e) => return IpcResult::err(format!("HidApi init failed: {e}")),
    };

    let path = match find_rgb_device_path(&api) {
        Some(p) => p,
        None => return IpcResult::err("Klavye bulunamadı.".to_string()),
    };

    // JS side speed range for side light: 10..=100
    let speed_pct = payload.speed.unwrap_or(60).clamp(10, 100);
    // JS formula: Math.round(1 + ((speedPct - 10) / 90) * 4)
    let speed_wire = (1.0 + ((speed_pct as f64 - 10.0) / 90.0) * 4.0).round() as u8;
    let speed_wire = speed_wire.clamp(1, 5);

    let brightness_pct  = payload.brightness.unwrap_or(100).clamp(0, 100);
    let brightness_wire = brightness_pct_to_wire(brightness_pct);

    let color_type = if let Some(f) = payload.flags {
        if f == 0x08 { ColorType::Rainbow } else { ColorType::Custom }
    } else {
        ColorType::Custom
    };

    let params = SideRgbParams {
        r: payload.r,
        g: payload.g,
        b: payload.b,
        side_mode: payload.side_mode.unwrap_or(1).clamp(0, 5),
        speed_wire,
        brightness_wire,
        color_type,
    };

    let packet = build_side_rgb_packet(&params);

    match send_feature_report(&api, &path, &packet) {
        Ok(()) => IpcResult::ok("✅ Yan ışık ayarları güncellendi."),
        Err(e) => IpcResult::err(format!("Yan Işık Hatası: {e}")),
    }
}

// ─── Command: send_native_perkey_rgb ─────────────────────────────────────────

/// Per-key color map: key code → hex color string (e.g. `"KeyW" → "#06b6d4"`).
/// Since this keyboard firmware doesn't support true per-key matrix write via
/// normal SET_LEDPARAM, we use the dominant-color approximation (Mode 1 Static).
#[tauri::command]
pub fn send_native_perkey_rgb(
    per_key_color_map: std::collections::HashMap<String, String>,
    guard: State<'_, PollGuard>,
) -> IpcResult {
    guard.suppress(Duration::from_secs(1));

    let api = match HidApi::new() {
        Ok(a) => a,
        Err(e) => return IpcResult::err(format!("HidApi init failed: {e}")),
    };

    let path = match find_rgb_device_path(&api) {
        Some(p) => p,
        None => return IpcResult::err("Klavye bulunamadı."),
    };

    // Find the most-used color in the map (dominant color strategy).
    let best_color = dominant_color(&per_key_color_map);
    let (r, g, b) = parse_hex_color(&best_color);

    let params = RgbParams {
        r, g, b,
        mode: LightingMode::Static,
        speed_wire: 1,
        brightness_wire: 4,
        color_type: ColorType::Custom,
        direction: 0,
    };

    let packet = build_rgb_packet(&params);

    match send_feature_report(&api, &path, &packet) {
        Ok(()) => {
            tracing::info!(dominant_color = %best_color, "Per-key dominant color applied");
            IpcResult::ok("Özel tuş renkleri klavyeye uygulandı!")
        }
        Err(e) => IpcResult::err(format!("Özel RGB Hatası: {e}")),
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Parse "#rrggbb" hex string to (r, g, b). Defaults to purple on error.
pub fn parse_hex_color(hex: &str) -> (u8, u8, u8) {
    let hex = hex.trim_start_matches('#');
    if hex.len() < 6 {
        return (139, 92, 246); // default purple
    }
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
    (r, g, b)
}

/// Find the most-frequently-occurring color value in the map.
fn dominant_color(map: &std::collections::HashMap<String, String>) -> String {
    if map.is_empty() {
        return "#8b5cf6".to_string();
    }
    let mut freq: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for color in map.values() {
        *freq.entry(color.as_str()).or_insert(0) += 1;
    }
    freq.into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(color, _)| color.to_string())
        .unwrap_or_else(|| "#8b5cf6".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn parse_hex_purple() {
        assert_eq!(parse_hex_color("#8b5cf6"), (139, 92, 246));
    }

    #[test]
    fn parse_hex_cyan() {
        assert_eq!(parse_hex_color("#06b6d4"), (6, 182, 212));
    }

    #[test]
    fn parse_hex_missing_hash() {
        assert_eq!(parse_hex_color("ff0000"), (255, 0, 0));
    }

    #[test]
    fn parse_hex_too_short_defaults() {
        // Bad input → default purple
        assert_eq!(parse_hex_color("#abc"), (139, 92, 246));
    }

    #[test]
    fn dominant_color_picks_most_frequent() {
        let mut map = HashMap::new();
        map.insert("KeyW".to_string(), "#06b6d4".to_string());
        map.insert("KeyA".to_string(), "#06b6d4".to_string());
        map.insert("KeyS".to_string(), "#ef4444".to_string());
        assert_eq!(dominant_color(&map), "#06b6d4");
    }

    #[test]
    fn dominant_color_empty_map_returns_default() {
        let map = HashMap::new();
        assert_eq!(dominant_color(&map), "#8b5cf6");
    }

    #[test]
    fn resolve_mode_from_string() {
        let v = serde_json::Value::String("breathing".to_string());
        assert_eq!(resolve_mode(&v).wire_byte(), 2);
    }

    #[test]
    fn resolve_mode_from_number() {
        let v = serde_json::json!(4u64);
        assert_eq!(resolve_mode(&v).wire_byte(), 4); // Wave
    }

    #[test]
    fn resolve_mode_unknown_defaults_to_static() {
        let v = serde_json::Value::String("custom_per_key".to_string());
        assert_eq!(resolve_mode(&v).wire_byte(), 1); // Static
    }
}
