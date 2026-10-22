// Prevents additional console window on Windows in release builds — Tauri convention.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod commands;
mod store;

use tauri::Manager;
use hid::poller::{spawn_poller, PollGuard};
use commands::rgb::{send_native_hid_rgb, send_native_side_rgb, send_native_perkey_rgb};
use commands::device::{list_hid_devices, get_hardware_rgb_state, get_system_idle_ms, get_connection_status, get_battery_status};

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let poll_guard = PollGuard::new();

    tauri::Builder::default()
        .manage(poll_guard.clone())
        .invoke_handler(tauri::generate_handler![
            list_hid_devices,
            send_native_hid_rgb,
            send_native_side_rgb,
            send_native_perkey_rgb,
            get_hardware_rgb_state,
            get_system_idle_ms,
            get_connection_status,
            get_battery_status,
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            // Start the hardware polling task once the app window is ready.
            spawn_poller(app.handle().clone(), poll_guard);
            tracing::info!("Rampage W-Granite started — hardware poller running");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
