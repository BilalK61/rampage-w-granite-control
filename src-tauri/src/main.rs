// Prevents additional console window on Windows in release builds — Tauri convention.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod commands;
mod store;

use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use hid::poller::{spawn_poller, PollGuard};
use commands::rgb::{send_native_hid_rgb, send_native_side_rgb, send_native_perkey_rgb};
use commands::macros::{assign_macro, clear_macro_key, restore_key_defaults, read_macro_keys};
use commands::remap::{assign_key, clear_key_remap, read_remapped_keys};
use commands::settings::{read_device_settings, set_debounce};
use commands::battery_alert::{close_toast, set_low_battery_alert};
use commands::app::{CLOSE_TO_TRAY, get_autostart, save_backup, set_autostart, set_close_to_tray};
use commands::device::{list_hid_devices, get_hardware_rgb_state, get_system_idle_ms, get_connection_status, get_battery_status};

/// Bring the main window back (from the tray, or when a second copy is started).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let poll_guard = PollGuard::new();

    tauri::Builder::default()
        // Must be the first plugin: a second launch just raises the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
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
            assign_macro,
            clear_macro_key,
            restore_key_defaults,
            read_macro_keys,
            assign_key,
            clear_key_remap,
            read_remapped_keys,
            read_device_settings,
            set_debounce,
            get_autostart,
            set_autostart,
            set_close_to_tray,
            save_backup,
            set_low_battery_alert,
            close_toast,
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                // Closing hides to the tray (unless turned off) so lighting rules keep running.
                let hidden_window = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        if CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                            api.prevent_close();
                            let _ = hidden_window.hide();
                        }
                    }
                });
                // Started by Windows at login: stay in the tray.
                if std::env::args().any(|arg| arg == "--minimized") {
                    let _ = window.hide();
                }
            }

            let open_item = MenuItem::with_id(app, "open", "Aç", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Çık", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Rampage W-Granite")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            // Start the hardware polling task once the app window is ready.
            spawn_poller(app.handle().clone(), poll_guard);
            tracing::info!("Rampage W-Granite started — hardware poller running");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
