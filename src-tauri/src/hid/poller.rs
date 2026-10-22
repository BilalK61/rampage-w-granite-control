/// Hardware state polling task.
///
/// Polls the keyboard every 800ms to detect changes made via physical
/// Fn+shortcut combos (e.g. Fn+\ to cycle modes). When the hardware state
/// changes, emits a `hardware-rgb-sync` event to the renderer.
///
/// Equivalent to the JS `setInterval`, but:
///  - Fully async via Tokio
///  - HID reads happen in `spawn_blocking` (they are synchronous) so they
///    cannot stall the async runtime
///  - Thread-safe `cooldown` flag replaces the JS `isCustomMatrixActive` variable

use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::Duration;
use tokio::time;
use tauri::{AppHandle, Emitter};
use hidapi::HidApi;

use super::device::{find_rgb_device_path, note_hardware_mode, RgbLink};
use super::protocol::{HardwareRgbState, build_get_ledparam_packet, parse_get_ledparam_reply};

/// Shared flag: while true the poller skips reading (user just sent a command;
/// we wait for the firmware to settle before resuming hardware sync).
///
/// `epoch` counts app-sent commands so the poller can tell its own changes
/// apart from ones made on the keyboard (Fn shortcuts).
#[derive(Clone)]
pub struct PollGuard {
    suppressed: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
}

impl PollGuard {
    pub fn new() -> Self {
        Self { suppressed: Arc::new(AtomicBool::new(false)), epoch: Arc::new(AtomicU64::new(0)) }
    }

    /// Suspend polling for `duration` (call after every send command).
    /// A later call extends the window instead of being cut short by an earlier timer.
    pub fn suppress(&self, duration: Duration) {
        let my_epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.suppressed.store(true, Ordering::SeqCst);
        let flag = Arc::clone(&self.suppressed);
        let epoch = Arc::clone(&self.epoch);
        tauri::async_runtime::spawn(async move {
            time::sleep(duration).await;
            if epoch.load(Ordering::SeqCst) == my_epoch {
                flag.store(false, Ordering::SeqCst);
            }
        });
    }

    pub fn is_suppressed(&self) -> bool {
        self.suppressed.load(Ordering::SeqCst)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

/// Signature string used to detect state changes.
fn signature(s: &HardwareRgbState) -> String {
    format!(
        "{}_{}_{}_{}_{}_{}", 
        s.mode, s.speed_pct, s.brightness_pct, s.color_type, s.direction, s.primary_color
    )
}

/// Poll period over the cable.
const WIRED_POLL: Duration = Duration::from_millis(400);
/// Poll period through the 2.4G dongle: each query is a multi-step RF
/// handshake, so poll at the vendor driver's 2s cadence.
const DONGLE_POLL: Duration = Duration::from_secs(2);

/// Spawn the hardware polling loop (400ms wired, 2s via dongle).
///
/// Emits `hardware-rgb-sync` to the frontend whenever the keyboard's
/// physical state changes (e.g. via Fn+\ or Fn+arrow shortcuts).
pub fn spawn_poller(app_handle: AppHandle, guard: PollGuard) {
    tauri::async_runtime::spawn(async move {
        let mut period = WIRED_POLL;
        let mut last_sig = String::new();
        let mut initialized = false;
        let mut baseline_epoch = guard.epoch();

        loop {
            time::sleep(period).await;

            if guard.is_suppressed() {
                continue;
            }
            let read_epoch = guard.epoch();

            // HID read is synchronous — run off the async executor
            let result = tokio::task::spawn_blocking(move || {
                let api = HidApi::new().ok()?;
                let path = find_rgb_device_path(&api)?;
                let mut link = RgbLink::open(&api, &path).ok()?;
                let state = link.query(&build_get_ledparam_packet()).ok()
                    .and_then(|reply| parse_get_ledparam_reply(&reply));
                Some((state, link.is_dongle()))
            })
            .await;

            let hw = match result {
                Ok(Some((state, is_dongle))) => {
                    period = if is_dongle { DONGLE_POLL } else { WIRED_POLL };
                    match state {
                        Some(s) => s,
                        None => continue,
                    }
                }
                _ => continue,
            };

            // The app sent a command while we were reading: this state may be stale.
            if guard.epoch() != read_epoch {
                continue;
            }
            note_hardware_mode(hw.mode);

            let sig = signature(&hw);

            // First read, or first read after an app-sent command: re-baseline
            // silently so the app's own change is not echoed back as "physical".
            if !initialized || baseline_epoch != read_epoch {
                last_sig = sig;
                initialized = true;
                baseline_epoch = read_epoch;
                continue;
            }

            if last_sig != sig {
                tracing::info!(
                    mode = hw.mode,
                    color = %hw.primary_color,
                    speed = hw.speed_pct,
                    brightness = hw.brightness_pct,
                    "Hardware RGB state changed via physical keyboard -> emitting sync event"
                );
                last_sig = sig;
                let _ = app_handle.emit("hardware-rgb-sync", &hw);
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hid::protocol::HardwareRgbState;

    fn mock_state(mode: u8, speed: u8, brightness: u8, color: &str) -> HardwareRgbState {
        HardwareRgbState {
            mode,
            speed_pct: speed,
            brightness_pct: brightness,
            color_type: "custom".to_string(),
            direction: 0,
            primary_color: color.to_string(),
        }
    }

    #[test]
    fn signature_changes_on_mode() {
        let s1 = mock_state(1, 75, 100, "#8b5cf6");
        let s2 = mock_state(2, 75, 100, "#8b5cf6");
        assert_ne!(signature(&s1), signature(&s2));
    }

    #[test]
    fn signature_changes_on_color() {
        let s1 = mock_state(1, 75, 100, "#8b5cf6");
        let s2 = mock_state(1, 75, 100, "#06b6d4");
        assert_ne!(signature(&s1), signature(&s2));
    }

    #[test]
    fn signature_stable_same_state() {
        let s1 = mock_state(1, 75, 100, "#8b5cf6");
        let s2 = mock_state(1, 75, 100, "#8b5cf6");
        assert_eq!(signature(&s1), signature(&s2));
    }

    #[test]
    fn poll_guard_starts_unsuppressed() {
        let g = PollGuard::new();
        assert!(!g.is_suppressed());
    }

    #[tokio::test]
    async fn poll_guard_suppresses_then_clears() {
        let g = PollGuard::new();
        g.suppress(Duration::from_millis(100));
        assert!(g.is_suppressed(), "should be suppressed immediately after call");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!g.is_suppressed(), "should clear after duration");
    }
}
