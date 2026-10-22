/// Tauri commands that remap a key to another key or a key combination.
///
/// Uses the same key-matrix rewrite as macros (see `commands::macros`): the
/// matrix is read back twice per page, a backup of the original is kept, and
/// every write is read back to confirm it.

use std::time::Duration;
use hidapi::HidApi;
use tauri::State;

use crate::commands::macros::{
    ensure_backup, load_backup, open_link, read_matrix, read_profile, slot_of, write_matrix,
    SUPPRESS_POLLER,
};
use crate::commands::rgb::IpcResult;
use crate::hid::keymap::*;
use crate::hid::poller::PollGuard;

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssignKeyPayload {
    /// `KeyboardEvent.code` of the key being remapped (e.g. "CapsLock").
    pub key_code: String,
    /// What the key should press instead: 1 to 3 USB HID usage codes.
    pub keys: Vec<u8>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemapInfo {
    pub key_code: String,
    pub keys: Vec<u8>,
}

#[tauri::command(async)]
pub fn assign_key(payload: AssignKeyPayload, guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(SUPPRESS_POLLER);
    match assign_key_inner(&payload) {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => {
            tracing::warn!(error = %e, key = %payload.key_code, "assign_key failed");
            IpcResult::err(e)
        }
    }
}

fn assign_key_inner(p: &AssignKeyPayload) -> Result<String, String> {
    let entry = key_entry(&p.keys)?;
    let key_slot = slot_of(&p.key_code)?;

    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let mut matrix = read_matrix(&mut link, profile)?;

    // Stock keys, earlier remaps and macros may be replaced; Fn/media keys may not.
    let current = slot_entry(&matrix, key_slot);
    if !is_key_entry(&current) && parse_macro_entry(&current).is_none() {
        return Err(format!("'{}' tuşu özel bir işlev tuşu (Fn/medya); yeniden atanamaz.", p.key_code));
    }
    if current == entry {
        return Ok("Tuş zaten bu işlevde.".into());
    }
    ensure_backup(profile, &matrix)?;

    set_slot_entry(&mut matrix, key_slot, entry);
    write_matrix(&mut link, profile, &matrix)?;

    let check = read_matrix(&mut link, profile)?;
    if slot_entry(&check, key_slot) != entry {
        return Err("Yazıldı ama atama doğrulanamadı. Klavyeyi uyandırıp tekrar deneyin.".into());
    }
    tracing::info!(key = %p.key_code, keys = ?p.keys, "Key remap written and verified");
    Ok("Tuş ataması klavyeye yazıldı ve doğrulandı.".into())
}

/// Put one key back to what it did before the first assignment (from the backup).
#[tauri::command(async)]
pub fn clear_key_remap(key_code: String, guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(SUPPRESS_POLLER);
    match clear_key_remap_inner(&key_code) {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => {
            tracing::warn!(error = %e, key = %key_code, "clear_key_remap failed");
            IpcResult::err(e)
        }
    }
}

fn clear_key_remap_inner(key_code: &str) -> Result<String, String> {
    let key_slot = slot_of(key_code)?;
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let mut matrix = read_matrix(&mut link, profile)?;

    let original = slot_entry(&load_backup(profile)?, key_slot);
    if parse_macro_entry(&original).is_some() {
        return Err("Yedekte bu tuş makro görünüyor; elle sıfırlayın.".into());
    }
    if slot_entry(&matrix, key_slot) == original {
        return Ok("Bu tuş zaten ilk işlevinde.".into());
    }
    set_slot_entry(&mut matrix, key_slot, original);
    write_matrix(&mut link, profile, &matrix)?;

    let check = read_matrix(&mut link, profile)?;
    if slot_entry(&check, key_slot) != original {
        return Err("Tuş eski haline döndürüldü ama doğrulanamadı.".into());
    }
    Ok("Tuş ilk işlevine döndü.".into())
}

/// Which of `key_codes` currently press something other than their original keys.
#[tauri::command(async)]
pub fn read_remapped_keys(key_codes: Vec<String>, guard: State<'_, PollGuard>) -> Result<Vec<RemapInfo>, String> {
    guard.suppress(Duration::from_secs(15));
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let matrix = read_matrix(&mut link, profile)?;
    // Without a backup nothing was ever assigned by this app.
    let Ok(backup) = load_backup(profile) else { return Ok(Vec::new()) };

    let mut found = Vec::new();
    for code in key_codes {
        let Ok(slot) = slot_of(&code) else { continue };
        let (now, before) = (slot_entry(&matrix, slot), slot_entry(&backup, slot));
        if now != before {
            if let Some(keys) = parse_key_entry(&now) {
                found.push(RemapInfo { key_code: code, keys });
            }
        }
    }
    Ok(found)
}
