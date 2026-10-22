/// Tauri commands for RGB lighting control.
///
/// These replace the Electron `ipcMain.handle()` handlers in `electron-main.cjs`.
/// All commands are called from the renderer via `invoke('command_name', args)`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::State;
use hidapi::HidApi;

use crate::hid::protocol::{
    RgbParams, SideRgbParams, LightingMode, ColorType,
    build_rgb_packet, build_side_rgb_packet,
    speed_pct_to_wire, brightness_pct_to_wire,
    blank_matrix, keycode_to_matrix_index, matrix_to_bytes,
    build_userpic_page_yc500, build_userpic_activate_packet,
};
use crate::hid::device::{find_rgb_device_path, send_feature_report, last_known_mode, RgbLink};
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
#[tauri::command(async)]
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
                "Mod {} uygulandı (hız {}, parlaklık {}/4)",
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
#[tauri::command(async)]
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
        Ok(()) => IpcResult::ok("Yan ışık güncellendi."),
        Err(e) => IpcResult::err(format!("Yan Işık Hatası: {e}")),
    }
}

// ─── Command: send_native_perkey_rgb ─────────────────────────────────────────

/// Id of the latest per-key request. Each upload takes ~1s through the dongle,
/// so rapid key clicks queue up; only the newest map is worth sending.
static PERKEY_REQUEST: AtomicU64 = AtomicU64::new(0);

/// SET_LEDPARAM mode that displays the uploaded per-key picture.
const USERPIC_MODE: u8 = 13;

/// Per-key color map: key code → hex color string (e.g. `"KeyW" → "#06b6d4"`).
///
/// Uses the real SET_USERPIC (opcode 0x0C) protocol:
///   1. Build a 128-slot LED matrix from the JS key-code map
///   2. Serialize to 384 bytes (R,G,B × 128 slots)
///   3. Split into 7 pages of 56 bytes and send via HID feature report
///      (with a 10 ms settle delay between pages as required by the firmware)
///   4. Activate mode 13 (Userpic) via SET_LEDPARAM 0x07
#[tauri::command(async)]
pub fn send_native_perkey_rgb(
    per_key_color_map: std::collections::HashMap<String, String>,
    guard: State<'_, PollGuard>,
) -> IpcResult {
    // Suppress the hardware poller for 4 seconds so concurrent GET_LEDPARAM doesn't interfere.
    guard.suppress(Duration::from_secs(4));
    let request = PERKEY_REQUEST.fetch_add(1, Ordering::SeqCst) + 1;

    let api = match HidApi::new() {
        Ok(a) => a,
        Err(e) => return IpcResult::err(format!("HidApi init failed: {e}")),
    };

    let path = match find_rgb_device_path(&api) {
        Some(p) => p,
        None => return IpcResult::err("Klavye RGB arayüzü bulunamadı."),
    };

    // ── Build the LED matrix ──────────────────────────────────────────────
    let mut matrix = blank_matrix();

    for (code, hex_color) in &per_key_color_map {
        if let Some(idx) = keycode_to_matrix_index(code) {
            let (r, g, b) = parse_hex_color(hex_color);
            matrix[idx] = (r, g, b);
        }
    }

    let rgb_bytes = matrix_to_bytes(&matrix);

    // One link for the whole upload: the dongle target is selected once and
    // the poller cannot interleave between pages.
    let mut link = match RgbLink::open(&api, &path) {
        Ok(l) => l,
        Err(e) => return IpcResult::err(format!("HID Hatası: {e}")),
    };

    // ── Upload 7 pages via SET_USERPIC (yc500 protocol) ──────────────────
    // (gen2 pages were also sent here before; the W-Granite ignores them.)
    for page in 0..7usize {
        // A newer map is queued behind us: drop this one, the next upload overwrites it.
        if PERKEY_REQUEST.load(Ordering::SeqCst) != request {
            return IpcResult::ok("Daha yeni tuş haritası gönderiliyor, bu istek atlandı.");
        }
        let packet = build_userpic_page_yc500(page, &rgb_bytes);
        if let Err(e) = link.send(&packet) {
            return IpcResult::err(format!("SET_USERPIC page {page} hatası: {e}"));
        }
        std::thread::sleep(Duration::from_millis(15));
    }

    // ── Activate mode 13 (Userpic display) ───────────────────────────────
    // Already in mode 13 → the new pages show live; re-activating would blink the LEDs.
    if last_known_mode() != Some(USERPIC_MODE) {
        // Settle delay before activating mode 13
        std::thread::sleep(Duration::from_millis(50));
        let activate = build_userpic_activate_packet();
        if let Err(e) = link.send(&activate) {
            return IpcResult::err(format!("Mode 13 aktivasyon hatası: {e}"));
        }
    }

    let key_count = per_key_color_map.len();
    tracing::info!(keys = key_count, "Per-key RGB matrix uploaded (SET_USERPIC 0x0C, mode 13)");
    IpcResult::ok(format!("Tuş bazlı RGB uygulandı ({key_count} tuş)."))
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
