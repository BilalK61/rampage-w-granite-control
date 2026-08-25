/// Tauri commands for HID device listing and hardware state query.
use hidapi::HidApi;
use crate::hid::device::{list_all_hid_devices, find_rgb_device_path, read_hardware_rgb_state, DeviceSnapshot};
use crate::hid::protocol::HardwareRgbState;

/// `list-hid-devices` — replaces `ipcMain.handle('list-hid-devices', ...)`.
/// Returns all HID devices as a flat list (renderer uses this for diagnostics).
#[tauri::command]
pub fn list_hid_devices() -> Vec<DeviceSnapshot> {
    match HidApi::new() {
        Ok(api) => list_all_hid_devices(&api),
        Err(_)  => vec![],
    }
}

/// `get-hardware-rgb-state` — replaces `ipcMain.handle('get-hardware-rgb-state', ...)`.
/// Returns the current keyboard lighting state or null if unavailable.
#[tauri::command]
pub fn get_hardware_rgb_state() -> Option<HardwareRgbState> {
    let api = HidApi::new().ok()?;
    let path = find_rgb_device_path(&api)?;
    read_hardware_rgb_state(&api, &path).ok().flatten()
}

#[cfg(test)]
mod tests {
    // Device commands require live hardware; tested via manual verification (Step 8).
    // The filter logic is unit-tested in hid::device.
}
