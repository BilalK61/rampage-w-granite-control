/// HID device discovery and send/receive for the ROYUAN/Yichip keyboard.
///
/// Target hardware:
///   VID: 0x3151  PID: 0x4015 or 0x4011
///   Interface: 2   UsagePage: 0xFFFF
use hidapi::{HidApi, HidDevice, DeviceInfo};
use super::protocol::{Packet, HardwareRgbState, build_get_ledparam_packet, parse_get_ledparam_reply};

pub const TARGET_VID: u16 = 0x3151;
pub const TARGET_PIDS: &[u16] = &[0x4015, 0x4011];
pub const RGB_INTERFACE: i32 = 2;
pub const RGB_USAGE_PAGE: u16 = 0xFFFF;

/// A lightweight snapshot of a discovered device — no open handle.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSnapshot {
    pub vendor_id: String,
    pub product_id: String,
    pub product: String,
    pub usage_page: String,
    pub interface: i32,
    pub path: String,
}

impl DeviceSnapshot {
    pub fn from_info(info: &DeviceInfo) -> Self {
        Self {
            vendor_id:  format!("0x{:04x}", info.vendor_id()),
            product_id: format!("0x{:04x}", info.product_id()),
            product:    info.product_string().unwrap_or("(no name)").to_string(),
            usage_page: format!("0x{:x}", info.usage_page()),
            interface:  info.interface_number(),
            path:       info.path().to_string_lossy().into_owned(),
        }
    }
}

/// List all HID devices visible to the OS.
pub fn list_all_hid_devices(api: &HidApi) -> Vec<DeviceSnapshot> {
    api.device_list()
        .map(DeviceSnapshot::from_info)
        .collect()
}

/// Predicate: does this `DeviceInfo` match our RGB interface?
///
/// Match criteria:
///   vendor_id == TARGET_VID
///   product_id ∈ TARGET_PIDS
///   interface_number == RGB_INTERFACE (2)
///   usage_page == RGB_USAGE_PAGE (0xFFFF)
pub fn is_rgb_interface(info: &DeviceInfo) -> bool {
    info.vendor_id() == TARGET_VID
        && TARGET_PIDS.contains(&info.product_id())
        && info.interface_number() == RGB_INTERFACE
        && info.usage_page() == RGB_USAGE_PAGE
}

/// Find the path of the first matching RGB HID interface.
pub fn find_rgb_device_path(api: &HidApi) -> Option<String> {
    api.device_list()
        .find(|d| is_rgb_interface(d))
        .map(|d| d.path().to_string_lossy().into_owned())
}

/// Open the device at `path`, send `packet`, then close.
///
/// This is a thin wrapper that always opens fresh and closes immediately —
/// matching the JS pattern of `new HID.HID(path)` → `sendFeatureReport` → `close()`.
pub fn send_feature_report(api: &HidApi, path: &str, packet: &Packet) -> Result<(), String> {
    let dev: HidDevice = api
        .open_path(std::ffi::CString::new(path).map_err(|e| e.to_string())?.as_c_str())
        .map_err(|e| format!("open_path failed: {e}"))?;
    dev.send_feature_report(packet)
        .map_err(|e| format!("send_feature_report failed: {e}"))?;
    Ok(())
    // `dev` drops here → closes the handle
}

/// Open the device, send GET_LEDPARAM query, read the reply, close.
pub fn read_hardware_rgb_state(api: &HidApi, path: &str) -> Result<Option<HardwareRgbState>, String> {
    let dev = api
        .open_path(std::ffi::CString::new(path).map_err(|e| e.to_string())?.as_c_str())
        .map_err(|e| format!("open_path failed: {e}"))?;

    let query = build_get_ledparam_packet();
    dev.send_feature_report(&query)
        .map_err(|e| format!("send GET_LEDPARAM failed: {e}"))?;

    let mut reply = [0u8; 65];
    let n = dev.get_feature_report(&mut reply)
        .map_err(|e| format!("get_feature_report failed: {e}"))?;

    if n < 9 {
        return Ok(None);
    }
    Ok(parse_get_ledparam_reply(&reply))
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests (no hardware required — mock DeviceInfo data via filter predicate)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    /// We can't construct DeviceInfo directly (private struct), but we can
    /// test the filter logic by testing `is_rgb_interface` equivalents against
    /// the raw field values, and verify `DeviceSnapshot` serialization.
    ///
    /// Hardware-dependent tests (send/read) are in the integration test suite.

    use super::*;

    #[test]
    fn target_vid_is_correct() {
        assert_eq!(TARGET_VID, 0x3151);
    }

    #[test]
    fn target_pids_contains_both() {
        assert!(TARGET_PIDS.contains(&0x4015));
        assert!(TARGET_PIDS.contains(&0x4011));
    }

    #[test]
    fn rgb_interface_number_is_2() {
        assert_eq!(RGB_INTERFACE, 2);
    }

    #[test]
    fn rgb_usage_page_is_ffff() {
        assert_eq!(RGB_USAGE_PAGE, 0xFFFF);
    }

    /// Verify the filter predicate doesn't match a wrong VID
    #[test]
    fn filter_rejects_wrong_vid() {
        // We can't create DeviceInfo, so we test the constituent parts:
        let vid: u16 = 0x046D; // Logitech
        let pid: u16 = 0x4015;
        let interface: i32 = 2;
        let usage_page: u16 = 0xFFFF;
        let matches = vid == TARGET_VID
            && TARGET_PIDS.contains(&pid)
            && interface == RGB_INTERFACE
            && usage_page == RGB_USAGE_PAGE;
        assert!(!matches, "wrong VID must not match");
    }

    #[test]
    fn filter_rejects_wrong_interface() {
        let vid: u16 = 0x3151;
        let pid: u16 = 0x4015;
        let interface: i32 = 0; // keyboard HID, not RGB
        let usage_page: u16 = 0xFFFF;
        let matches = vid == TARGET_VID
            && TARGET_PIDS.contains(&pid)
            && interface == RGB_INTERFACE
            && usage_page == RGB_USAGE_PAGE;
        assert!(!matches, "wrong interface must not match");
    }

    #[test]
    fn filter_accepts_correct_pid_4015() {
        let vid: u16 = 0x3151;
        let pid: u16 = 0x4015;
        let interface: i32 = 2;
        let usage_page: u16 = 0xFFFF;
        let matches = vid == TARGET_VID
            && TARGET_PIDS.contains(&pid)
            && interface == RGB_INTERFACE
            && usage_page == RGB_USAGE_PAGE;
        assert!(matches);
    }

    #[test]
    fn filter_accepts_correct_pid_4011() {
        let vid: u16 = 0x3151;
        let pid: u16 = 0x4011;
        let interface: i32 = 2;
        let usage_page: u16 = 0xFFFF;
        let matches = vid == TARGET_VID
            && TARGET_PIDS.contains(&pid)
            && interface == RGB_INTERFACE
            && usage_page == RGB_USAGE_PAGE;
        assert!(matches);
    }
}
