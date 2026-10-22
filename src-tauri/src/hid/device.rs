/// HID device discovery and send/receive for the ROYUAN/Yichip keyboard.
///
/// Target hardware:
///   VID: 0x3151  PID: 0x4015 or 0x4011
///   Interface: 2   UsagePage: 0xFFFF
use std::ffi::CString;
use std::sync::{Mutex, MutexGuard, atomic::{AtomicU8, Ordering}};
use std::time::Duration;
use hidapi::{HidApi, HidDevice, DeviceInfo};
use super::protocol::{
    Packet, PACKET_LEN, HardwareRgbState, DongleStatus,
    build_get_ledparam_packet, parse_get_ledparam_reply,
    build_dongle_packet, parse_dongle_status,
    DONGLE_OP_STATUS, DONGLE_OP_TARGET, DONGLE_OP_FETCH, DONGLE_TARGET_KEYBOARD,
};

pub const TARGET_VID: u16 = 0x3151;
pub const TARGET_PIDS: &[u16] = &[
    0x4015, 0x4011, 0x4010, 0x4012, 0x4013, 0x4014, 
    0x4016, 0x4017, 0x4018, 0x4019, 0x4020, 0x4025,
    0x0011, 0x0012, 0x0015
];
/// 2.4G receiver PIDs (from the vendor driver's dongle table).
pub const DONGLE_PIDS: &[u16] = &[0x4011, 0x4014, 0x4017, 0x4021, 0x4027, 0x402D, 0x4038];

pub fn is_dongle_pid(pid: u16) -> bool {
    DONGLE_PIDS.contains(&pid)
}

pub const RGB_INTERFACE: i32 = 2;
pub const RGB_USAGE_PAGE: u16 = 0xFFFF;
/// Vendor usage page of the Bluetooth (HID-over-GATT) command collection.
pub const BT_USAGE_PAGE: u16 = 0xFF55;

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

/// Predicate: does this `DeviceInfo` match our RGB interface (Wired, 2.4G Dongle, Bluetooth)?
pub fn is_rgb_interface(info: &DeviceInfo) -> bool {
    let vid = info.vendor_id();
    let is_vendor_match = vid == TARGET_VID
        || info.manufacturer_string().map(|m| m.contains("ROYUAN") || m.contains("Yichip")).unwrap_or(false)
        || info.product_string().map(|p| p.contains("Wireless Keyboard") || p.contains("W-Granite") || p.contains("Rampage")).unwrap_or(false);

    if !is_vendor_match {
        return false;
    }

    // Must be the custom vendor Feature Report interface (Usage Page 0xFFFF or 0xFF00)
    info.usage_page() == RGB_USAGE_PAGE || info.usage_page() == 0xFF00 || info.usage_page() == BT_USAGE_PAGE
}

/// Find the path of the best matching RGB HID interface across Wired, 2.4G Dongle, and Bluetooth.
pub fn find_rgb_device_path(api: &HidApi) -> Option<String> {
    let mut best_path = None;
    let mut best_score = 0;

    for d in api.device_list() {
        if !is_rgb_interface(d) {
            continue;
        }

        let mut score = 10;
        if d.usage_page() == 0xFFFF || d.usage_page() == BT_USAGE_PAGE {
            score += 100;
        }
        if d.usage() == 2 {
            score += 50;
        } else if d.usage() == 1 {
            score += 30;
        }
        if d.interface_number() == 2 {
            score += 40;
        } else if d.interface_number() == 1 {
            score += 20;
        }
        // With both cable and dongle plugged in, the cable is the live link.
        if !is_dongle_pid(d.product_id()) {
            score += 5;
        }

        if score > best_score {
            best_score = score;
            best_path = Some(d.path().to_string_lossy().into_owned());
        }
    }

    best_path
}

const SET_LEDPARAM_OPCODE: u8 = 0x07;
const MODE_UNKNOWN: u8 = 0xFF;

/// Last lighting mode the keyboard is known to be in (from our own SET_LEDPARAM
/// or the poller's reads). Lets per-key uploads skip re-activating mode 13,
/// which makes the LEDs blink off and on.
static LAST_KNOWN_MODE: AtomicU8 = AtomicU8::new(MODE_UNKNOWN);

pub fn note_hardware_mode(mode: u8) {
    LAST_KNOWN_MODE.store(mode, Ordering::SeqCst);
}

pub fn last_known_mode() -> Option<u8> {
    match LAST_KNOWN_MODE.load(Ordering::SeqCst) {
        MODE_UNKNOWN => None,
        mode => Some(mode),
    }
}

/// Serializes all RGB-interface I/O. The dongle relay is a multi-step
/// handshake, so the poller must never interleave with a command.
static HID_IO_LOCK: Mutex<()> = Mutex::new(());

const DONGLE_STEP_DELAY: Duration = Duration::from_millis(10);
const DONGLE_POLL_DELAY: Duration = Duration::from_millis(100);
const DONGLE_POLL_TRIES: usize = 10;
const WIRED_REPLY_DELAY: Duration = Duration::from_millis(30);
/// Bluetooth framing: commands go out as output report 6 carrying `0x55` + the
/// usual packet; replies come back as input report 6 with the same prefix.
const BT_REPORT_ID: u8 = 0x06;
const BT_PREFIX: u8 = 0x55;
const BT_OP_BATTERY: u8 = 0x77;
const BT_REPLY_WAIT: Duration = Duration::from_millis(1500);

const STABLE_READ_TRIES: usize = 12;
const STABLE_READ_RETRY_DELAY: Duration = Duration::from_millis(400);

/// An open handle on the RGB interface: cable, 2.4G dongle or Bluetooth.
/// Holds the global I/O lock for its whole lifetime.
pub struct RgbLink {
    dev: HidDevice,
    is_dongle: bool,
    is_bluetooth: bool,
    target_selected: bool,
    _io: MutexGuard<'static, ()>,
}

impl RgbLink {
    pub fn open(api: &HidApi, path: &str) -> Result<Self, String> {
        let io = HID_IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dev = api
            .open_path(CString::new(path).map_err(|e| e.to_string())?.as_c_str())
            .map_err(|e| format!("open_path failed: {e}"))?;
        let is_dongle = dev
            .get_device_info()
            .map(|i| is_dongle_pid(i.product_id()))
            .unwrap_or(false);
        let is_bluetooth = dev
            .get_device_info()
            .map(|i| i.usage_page() == BT_USAGE_PAGE)
            .unwrap_or(false);
        Ok(Self { dev, is_dongle, is_bluetooth, target_selected: false, _io: io })
    }

    pub fn is_dongle(&self) -> bool {
        self.is_dongle
    }

    /// Slow links (dongle relay, Bluetooth) are polled less often.
    pub fn is_wireless(&self) -> bool {
        self.is_dongle || self.is_bluetooth
    }

    /// Send a command packet to the keyboard.
    pub fn send(&mut self, packet: &Packet) -> Result<(), String> {
        if self.is_dongle {
            self.wait_dongle(|s| s.can_send)?;
            if !self.target_selected {
                std::thread::sleep(DONGLE_STEP_DELAY);
                self.raw_send(&build_dongle_packet(&[DONGLE_OP_TARGET, DONGLE_TARGET_KEYBOARD]))?;
                self.target_selected = true;
            }
            std::thread::sleep(DONGLE_STEP_DELAY);
        }
        if self.is_bluetooth {
            self.bt_drain();
        }
        self.raw_send(packet)?;
        if packet[1] == SET_LEDPARAM_OPCODE {
            note_hardware_mode(packet[2]);
        }
        Ok(())
    }

    /// Send a query packet and return the keyboard's reply (Report ID at [0]).
    pub fn query(&mut self, packet: &Packet) -> Result<[u8; PACKET_LEN], String> {
        self.send(packet)?;
        if self.is_bluetooth {
            return self.bt_read_reply();
        }
        if self.is_dongle {
            self.wait_dongle(|s| s.can_read)?;
            std::thread::sleep(DONGLE_STEP_DELAY);
            self.raw_send(&build_dongle_packet(&[DONGLE_OP_FETCH]))?;
            std::thread::sleep(DONGLE_STEP_DELAY);
        } else {
            std::thread::sleep(WIRED_REPLY_DELAY);
        }
        self.raw_get()
    }

    /// Like `query`, but only returns a reply once two consecutive reads agree.
    /// The dongle relay sometimes hands back a stale buffer (an old reply, the
    /// status packet or zeros); anything that gets written back must not be one.
    pub fn query_stable(&mut self, packet: &Packet) -> Result<[u8; PACKET_LEN], String> {
        let mut previous: Option<[u8; PACKET_LEN]> = None;
        let mut last_err = String::from("cevap alınamadı");
        for _ in 0..STABLE_READ_TRIES {
            match self.query(packet) {
                Ok(reply) if previous == Some(reply) => return Ok(reply),
                Ok(reply) => previous = Some(reply),
                Err(e) => {
                    last_err = e;
                    std::thread::sleep(STABLE_READ_RETRY_DELAY);
                }
            }
        }
        Err(format!("Okuma kararsız: {last_err}"))
    }

    /// Ask the dongle for the keyboard link status (0xF7). `None` when not a dongle.
    pub fn dongle_status(&self) -> Result<Option<DongleStatus>, String> {
        if !self.is_dongle {
            return Ok(None);
        }
        std::thread::sleep(DONGLE_STEP_DELAY);
        self.raw_send(&build_dongle_packet(&[DONGLE_OP_STATUS]))?;
        std::thread::sleep(DONGLE_STEP_DELAY);
        let reply = self.raw_get()?;
        Ok(parse_dongle_status(&reply[1..]))
    }

    /// Battery level of the keyboard over 2.4G or Bluetooth; `None` on the cable
    /// (which reports nothing) or when the keyboard is asleep.
    pub fn battery(&self) -> Option<u8> {
        if self.is_bluetooth {
            self.bt_battery()
        } else {
            self.dongle_status().ok().flatten().filter(|d| d.online).map(|d| d.battery)
        }
    }

    fn bt_write(&self, bytes: &[u8]) -> Result<(), String> {
        let mut out = [0u8; 66];
        out[0] = BT_REPORT_ID;
        out[1..1 + bytes.len()].copy_from_slice(bytes);
        self.dev.write(&out).map(|_| ()).map_err(|e| format!("Bluetooth yazma başarısız: {e}"))
    }

    /// Throw away input reports that arrived before this command.
    fn bt_drain(&self) {
        let mut buf = [0u8; 80];
        while matches!(self.dev.read_timeout(&mut buf, 0), Ok(n) if n > 0) {}
    }

    /// Wait for the keyboard's reply report and rebuild the feature-report shaped reply.
    /// Key-matrix and macro pages come back as raw data without an opcode echo,
    /// so any `0x55` report after the (drained) send counts as the answer.
    fn bt_read_reply(&self) -> Result<[u8; PACKET_LEN], String> {
        let deadline = std::time::Instant::now() + BT_REPLY_WAIT;
        let mut buf = [0u8; 80];
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            let n = self.dev.read_timeout(&mut buf, left.as_millis().max(1) as i32)
                .map_err(|e| format!("Bluetooth okuma başarısız: {e}"))?;
            if n >= 3 && buf[0] == BT_REPORT_ID && buf[1] == BT_PREFIX {
                let mut reply = [0u8; PACKET_LEN];
                let len = (n - 2).min(PACKET_LEN - 1);
                reply[1..1 + len].copy_from_slice(&buf[2..2 + len]);
                return Ok(reply);
            }
        }
        Err("Bluetooth: klavye cevap vermedi (uykuda olabilir).".into())
    }

    fn bt_battery(&self) -> Option<u8> {
        self.bt_drain();
        self.bt_write(&[BT_OP_BATTERY]).ok()?;
        let deadline = std::time::Instant::now() + BT_REPLY_WAIT;
        let mut buf = [0u8; 80];
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            let n = self.dev.read_timeout(&mut buf, left.as_millis().max(1) as i32).ok()?;
            if n >= 3 && buf[0] == BT_REPORT_ID && buf[1] == BT_OP_BATTERY {
                return Some(buf[2].min(100));
            }
        }
        None
    }

    fn wait_dongle(&self, ready: impl Fn(&DongleStatus) -> bool) -> Result<(), String> {
        for _ in 0..DONGLE_POLL_TRIES {
            match self.dongle_status()? {
                Some(s) if !s.online => return Err("Klavye 2.4G alıcıya bağlı değil (uykuda olabilir).".into()),
                Some(s) if ready(&s) => return Ok(()),
                _ => std::thread::sleep(DONGLE_POLL_DELAY),
            }
        }
        Err("2.4G alıcı zaman aşımı: klavye cevap vermedi.".into())
    }

    fn raw_send(&self, packet: &Packet) -> Result<(), String> {
        if self.is_bluetooth {
            let mut framed = [0u8; 65];
            framed[0] = BT_PREFIX;
            framed[1..].copy_from_slice(&packet[1..PACKET_LEN]);
            return self.bt_write(&framed);
        }
        self.dev.send_feature_report(packet)
            .map_err(|e| format!("send_feature_report failed: {e}"))
    }

    fn raw_get(&self) -> Result<[u8; PACKET_LEN], String> {
        let mut reply = [0u8; PACKET_LEN];
        self.dev.get_feature_report(&mut reply)
            .map_err(|e| format!("get_feature_report failed: {e}"))?;
        Ok(reply)
    }
}

/// Open the device at `path`, send `packet`, then close.
pub fn send_feature_report(api: &HidApi, path: &str, packet: &Packet) -> Result<(), String> {
    RgbLink::open(api, path)?.send(packet)
}

/// Open the device, send GET_LEDPARAM query, read the reply, close.
pub fn read_hardware_rgb_state(api: &HidApi, path: &str) -> Result<Option<HardwareRgbState>, String> {
    let reply = RgbLink::open(api, path)?.query(&build_get_ledparam_packet())?;
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
