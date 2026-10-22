/// Tauri commands for HID device listing and hardware state query.
use hidapi::HidApi;
use crate::hid::device::{list_all_hid_devices, find_rgb_device_path, read_hardware_rgb_state, DeviceSnapshot, RgbLink, TARGET_VID, is_dongle_pid};
use crate::hid::protocol::{HardwareRgbState, DongleStatus};

/// `list-hid-devices` — replaces `ipcMain.handle('list-hid-devices', ...)`.
/// Returns all HID devices as a flat list (renderer uses this for diagnostics).
#[tauri::command]
pub fn list_hid_devices() -> Vec<DeviceSnapshot> {
    match HidApi::new() {
        Ok(api) => list_all_hid_devices(&api),
        Err(_)  => vec![],
    }
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct LASTINPUTINFO {
    cb_size: u32,
    dw_time: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetLastInputInfo(plii: *mut LASTINPUTINFO) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

/// Returns system-wide idle time in milliseconds (since last physical key/mouse event anywhere on PC).
#[tauri::command]
pub fn get_system_idle_ms() -> u64 {
    #[cfg(target_os = "windows")]
    unsafe {
        let mut lii = LASTINPUTINFO {
            cb_size: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dw_time: 0,
        };
        if GetLastInputInfo(&mut lii) != 0 {
            let tick = GetTickCount();
            let diff = tick.wrapping_sub(lii.dw_time);
            return diff as u64;
        }
    }
    0
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub connection_type: String, // "wired" | "dongle_24g" | "none"
    pub product_name: String,
}

/// Returns live connection mode: Wired, 2.4G Wireless Dongle, or None.
#[tauri::command]
pub fn get_connection_status() -> ConnectionStatus {
    let Ok(api) = HidApi::new() else {
        return ConnectionStatus {
            connected: false,
            connection_type: "none".to_string(),
            product_name: "Bağlantı Yok".to_string(),
        };
    };

    let mut is_wired = false;
    let mut is_dongle = false;

    for d in api.device_list() {
        if d.vendor_id() == 0x3151 {
            if d.product_id() == 0x4015 {
                is_wired = true;
                break;
            } else if d.product_id() == 0x4011 {
                is_dongle = true;
            }
        }
    }

    if is_wired {
        ConnectionStatus {
            connected: true,
            connection_type: "wired".to_string(),
            product_name: "Rampage W-Granite (Kablolu)".to_string(),
        }
    } else if is_dongle {
        ConnectionStatus {
            connected: true,
            connection_type: "dongle_24g".to_string(),
            product_name: "Rampage W-Granite (2.4G Alıcı)".to_string(),
        }
    } else {
        ConnectionStatus {
            connected: false,
            connection_type: "none".to_string(),
            product_name: "Bağlantı Aranıyor...".to_string(),
        }
    }
}

/// `get-hardware-rgb-state` — replaces `ipcMain.handle('get-hardware-rgb-state', ...)`.
/// Returns the current keyboard lighting state or null if unavailable.
#[tauri::command(async)]
pub fn get_hardware_rgb_state() -> Option<HardwareRgbState> {
    let api = HidApi::new().ok()?;
    let path = find_rgb_device_path(&api)?;
    read_hardware_rgb_state(&api, &path).ok().flatten()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryStatus {
    pub percentage: u8,
    pub is_charging: bool,
    pub is_connected: bool,
    pub connection_type: String, // "wired" | "dongle_24g" | "none"
    pub status_text: String,
}

/// Reads the keyboard link status from the 2.4G receiver (0xF7).
fn read_dongle_status(api: &HidApi, path: &str) -> Option<DongleStatus> {
    RgbLink::open(api, path).ok()?.dongle_status().ok().flatten()
}

/// Returns live keyboard battery and charging status.
#[tauri::command(async)]
pub fn get_battery_status() -> BatteryStatus {
    let Ok(api) = HidApi::new() else {
        return BatteryStatus {
            percentage: 0,
            is_charging: false,
            is_connected: false,
            connection_type: "none".to_string(),
            status_text: "Bağlantı Yok".to_string(),
        };
    };

    let is_wired = api.device_list()
        .any(|d| d.vendor_id() == TARGET_VID && d.product_id() == 0x4015);
    let dongle_path = find_rgb_device_path(&api)
        .filter(|p| api.device_list().any(|d| is_dongle_pid(d.product_id()) && d.path().to_string_lossy() == *p));

    if is_wired {
        BatteryStatus {
            percentage: 100,
            is_charging: true,
            is_connected: true,
            connection_type: "wired".to_string(),
            status_text: "Kablolu (pil seviyesi kabloda okunamıyor)".to_string(),
        }
    } else if let Some(path) = dongle_path {
        let (percentage, is_connected, status_text) = match read_dongle_status(&api, &path) {
            Some(s) if s.online => (s.battery.min(100), true, format!("%{} (2.4G Kablosuz)", s.battery.min(100))),
            Some(s) => (s.battery.min(100), false, "Klavye uykuda (2.4G)".to_string()),
            None => (0, true, "2.4G (pil okunamadı)".to_string()),
        };
        BatteryStatus {
            percentage,
            is_charging: false,
            is_connected,
            connection_type: "dongle_24g".to_string(),
            status_text,
        }
    } else {
        BatteryStatus {
            percentage: 0,
            is_charging: false,
            is_connected: false,
            connection_type: "none".to_string(),
            status_text: "Bağlantı Yok".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    // Device commands require live hardware; tested via manual verification (Step 8).
    // The filter logic is unit-tested in hid::device.
}
