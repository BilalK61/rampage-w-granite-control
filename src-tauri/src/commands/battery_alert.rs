/// Low-battery notification.
///
/// The keyboard starts blinking F4 at a firmware-defined level that it never
/// reports, so the alert level is a setting (0 = off). The poller feeds every
/// 2.4G battery reading in here; one notification is shown per drop below the
/// level and the alert re-arms once the battery has recovered a few points.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Percent at or below which the alert fires; 0 disables it.
static THRESHOLD: AtomicU8 = AtomicU8::new(20);
static ALERTED: AtomicBool = AtomicBool::new(false);

/// Extra percent above the threshold needed before the alert can fire again.
const REARM_MARGIN: u8 = 5;

#[tauri::command]
pub fn set_low_battery_alert(percent: u8) {
    THRESHOLD.store(percent.min(50), Ordering::SeqCst);
    ALERTED.store(false, Ordering::SeqCst);
}

/// What a battery reading means for the alert state.
#[derive(Debug, PartialEq)]
enum Decision {
    Notify,
    Rearm,
    Nothing,
}

fn decide(percent: u8, threshold: u8, alerted: bool) -> Decision {
    if threshold == 0 {
        return Decision::Nothing;
    }
    if percent == 0 {
        // 0 means "no reading", not an empty battery.
        return Decision::Nothing;
    }
    if percent <= threshold && !alerted {
        Decision::Notify
    } else if percent >= threshold.saturating_add(REARM_MARGIN) && alerted {
        Decision::Rearm
    } else {
        Decision::Nothing
    }
}

/// Call with each battery level read from the keyboard over 2.4G.
pub fn on_battery_reading(app: &AppHandle, percent: u8) {
    match decide(percent, THRESHOLD.load(Ordering::SeqCst), ALERTED.load(Ordering::SeqCst)) {
        Decision::Notify => {
            ALERTED.store(true, Ordering::SeqCst);
            tracing::info!(percent, "Low battery -> notifying");
            let shown = app
                .notification()
                .builder()
                .title("Klavye pili azaldı")
                .body(format!("Pil %{percent}. Kabloyu takıp şarj edin."))
                .show();
            if let Err(e) = shown {
                tracing::warn!(error = %e, "low battery notification failed");
            }
        }
        Decision::Rearm => ALERTED.store(false, Ordering::SeqCst),
        Decision::Nothing => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifies_once_when_crossing_the_threshold() {
        assert_eq!(decide(20, 20, false), Decision::Notify);
        assert_eq!(decide(15, 20, true), Decision::Nothing);
    }

    #[test]
    fn above_threshold_does_nothing_until_recovered() {
        assert_eq!(decide(21, 20, false), Decision::Nothing);
        assert_eq!(decide(22, 20, true), Decision::Nothing);
        assert_eq!(decide(25, 20, true), Decision::Rearm);
    }

    #[test]
    fn disabled_and_missing_readings_never_notify() {
        assert_eq!(decide(5, 0, false), Decision::Nothing);
        assert_eq!(decide(0, 20, false), Decision::Nothing);
    }
}
