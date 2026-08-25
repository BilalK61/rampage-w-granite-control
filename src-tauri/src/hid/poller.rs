/// Hardware state polling task.
///
/// Polls the keyboard every 800ms to detect changes made via physical
/// Fn+shortcut combos (e.g. Fn+\ to cycle modes). When the hardware state
/// changes, emits a `hardware-rgb-sync` event to the renderer.
///
/// Equivalent to the JS `setInterval` in `electron-main.cjs`, but:
///  - Fully async via Tokio
///  - HID reads happen in `spawn_blocking` (they are synchronous) so they
///    cannot stall the async runtime
///  - Thread-safe `cooldown` flag replaces the JS `isCustomMatrixActive` variable

use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use tokio::time;
use tauri::{AppHandle, Emitter};
use hidapi::HidApi;

use super::device::{find_rgb_device_path, read_hardware_rgb_state};
use super::protocol::HardwareRgbState;

/// Shared flag: while true the poller skips reading (user just sent a command;
/// we wait for the firmware to settle before resuming hardware sync).
#[derive(Clone)]
pub struct PollGuard(pub Arc<AtomicBool>);

impl PollGuard {
    pub fn new() -> Self { Self(Arc::new(AtomicBool::new(false))) }

    /// Suspend polling for `duration` (call after every send command).
    pub fn suppress(&self, duration: Duration) {
        let flag = Arc::clone(&self.0);
        flag.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            time::sleep(duration).await;
            flag.store(false, Ordering::SeqCst);
        });
    }

    pub fn is_suppressed(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Signature string used to detect state changes.
fn signature(s: &HardwareRgbState) -> String {
    format!(
        "{}_{}_{}_{}_{}_{}", 
        s.mode, s.speed_pct, s.brightness_pct, s.color_type, s.direction, s.primary_color
    )
}

/// Spawn the 800ms hardware polling loop.
///
/// Emits `hardware-rgb-sync` to the frontend whenever the keyboard's
/// reported state changes between polls.
pub fn spawn_poller(app_handle: AppHandle, guard: PollGuard) {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(800));
        let mut last_sig = String::new();
        let mut initialized = false;

        loop {
            interval.tick().await;

            if guard.is_suppressed() {
                continue;
            }

            // HID read is synchronous — move it off the async executor
            let app = app_handle.clone();
            let result = tokio::task::spawn_blocking(move || {
                let api = HidApi::new().ok()?;
                let path = find_rgb_device_path(&api)?;
                read_hardware_rgb_state(&api, &path).ok().flatten()
            })
            .await;

            let hw = match result {
                Ok(Some(state)) => state,
                _ => continue,
            };

            let sig = signature(&hw);

            // On first successful read: establish baseline without firing event
            if !initialized {
                last_sig = sig;
                initialized = true;
                continue;
            }

            if last_sig != sig {
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
