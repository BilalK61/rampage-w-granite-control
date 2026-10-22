/// Tauri commands for keyboard options: debounce level and firmware version.

use std::time::Duration;
use hidapi::HidApi;
use tauri::State;

use crate::commands::macros::open_link;
use crate::commands::rgb::IpcResult;
use crate::hid::options::*;
use crate::hid::poller::PollGuard;

/// The keyboard needs about a second to commit a config write.
const COMMIT_DELAY: Duration = Duration::from_millis(1100);

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub debounce: Option<u8>,
    pub firmware: Option<String>,
}

#[tauri::command(async)]
pub fn read_device_settings(guard: State<'_, PollGuard>) -> Result<DeviceSettings, String> {
    guard.suppress(Duration::from_secs(10));
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let debounce = link.query_stable(&build_get_debounce_packet()).ok().and_then(|r| parse_debounce_reply(&r));
    let firmware = link.query_stable(&build_get_rev_packet()).ok().and_then(|r| parse_firmware_reply(&r));
    if debounce.is_none() && firmware.is_none() {
        return Err("Klavye ayarları okunamadı. Klavyeyi uyandırıp tekrar deneyin.".into());
    }
    Ok(DeviceSettings { debounce, firmware })
}

#[tauri::command(async)]
pub fn set_debounce(level: u8, guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(Duration::from_secs(10));
    match set_debounce_inner(level) {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => {
            tracing::warn!(error = %e, level, "set_debounce failed");
            IpcResult::err(e)
        }
    }
}

fn set_debounce_inner(level: u8) -> Result<String, String> {
    if !(DEBOUNCE_MIN..=DEBOUNCE_MAX).contains(&level) {
        return Err(format!("Debounce {DEBOUNCE_MIN} ile {DEBOUNCE_MAX} arasında olmalı."));
    }
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    link.send(&build_set_debounce_packet(level))?;
    std::thread::sleep(COMMIT_DELAY);
    let read_back = link.query_stable(&build_get_debounce_packet()).ok().and_then(|r| parse_debounce_reply(&r));
    if read_back != Some(level) {
        return Err("Debounce yazıldı ama doğrulanamadı.".into());
    }
    tracing::info!(level, "Debounce written and verified");
    Ok(format!("Debounce {level} olarak ayarlandı."))
}
