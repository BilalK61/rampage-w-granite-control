// Prevents additional console window on Windows in release builds — Tauri convention.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod commands;
mod store;

use hid::poller::{spawn_poller, PollGuard};
use commands::rgb::{send_native_hid_rgb, send_native_side_rgb, send_native_perkey_rgb};
use commands::device::{list_hid_devices, get_hardware_rgb_state};

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
        ])
        .setup(move |app| {
            // Start the hardware polling task once the app window is ready.
            spawn_poller(app.handle().clone(), poll_guard);
            tracing::info!("AetherRGB started — hardware poller running");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
