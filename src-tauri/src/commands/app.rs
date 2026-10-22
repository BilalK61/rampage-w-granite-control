/// App-level commands: tray behavior and starting with Windows.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::commands::rgb::IpcResult;

/// When true, closing the window hides it to the tray instead of quitting.
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "RampageWGranite";

/// Whether the app is registered to start with Windows.
#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        return RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|key| key.get_value::<String, _>(RUN_VALUE))
            .is_ok();
    }
    #[cfg(not(windows))]
    false
}

/// Register or remove the Windows start-up entry (current user only).
#[tauri::command]
pub fn set_autostart(enabled: bool) -> IpcResult {
    #[cfg(windows)]
    {
        use winreg::{enums::{HKEY_CURRENT_USER, KEY_SET_VALUE}, RegKey};
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
            Ok(k) => k,
            Err(e) => return IpcResult::err(format!("Kayıt defteri açılamadı: {e}")),
        };
        if enabled {
            let exe = match std::env::current_exe() {
                Ok(p) => p,
                Err(e) => return IpcResult::err(format!("Uygulama yolu bulunamadı: {e}")),
            };
            // `--minimized` starts in the tray instead of opening the window.
            let command = format!("\"{}\" --minimized", exe.display());
            return match key.set_value(RUN_VALUE, &command) {
                Ok(()) => IpcResult::ok("Windows ile başlatma açıldı."),
                Err(e) => IpcResult::err(format!("Yazılamadı: {e}")),
            };
        }
        return match key.delete_value(RUN_VALUE) {
            Ok(()) => IpcResult::ok("Windows ile başlatma kapatıldı."),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => IpcResult::ok("Windows ile başlatma kapalı."),
            Err(e) => IpcResult::err(format!("Silinemedi: {e}")),
        };
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        IpcResult::err("Windows ile başlatma yalnızca Windows'ta desteklenir.")
    }
}

/// Write a backup file into the user's Downloads folder and return its path.
#[tauri::command]
pub fn save_backup(file_name: String, contents: String) -> Result<String, String> {
    let valid_name = !file_name.is_empty()
        && file_name.ends_with(".json")
        && file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !valid_name {
        return Err("Geçersiz dosya adı.".into());
    }
    let dir = dirs::download_dir()
        .or_else(dirs::document_dir)
        .ok_or("Yedek klasörü bulunamadı.")?;
    let path = dir.join(file_name);
    std::fs::write(&path, contents).map_err(|e| format!("Yedek yazılamadı: {e}"))?;
    Ok(path.display().to_string())
}
