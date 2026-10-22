/// Tauri commands that store macros on the keyboard and bind them to keys.
///
/// Assigning rewrites the keyboard's whole key matrix (the firmware has no
/// single-key write), so every command first reads the matrix back twice per
/// page, refuses to continue on a stale/incomplete read, and keeps a backup of
/// the original matrix that `restore_key_defaults` can write back.

use std::{path::PathBuf, time::Duration};
use hidapi::HidApi;
use tauri::State;

use crate::commands::rgb::IpcResult;
use crate::hid::device::{find_rgb_device_path, RgbLink};
use crate::hid::keymap::*;
use crate::hid::poller::PollGuard;
use crate::hid::protocol::keycode_to_matrix_index;

/// The poller is paused for the whole operation (reads + writes take ~10 s).
pub(crate) const SUPPRESS_POLLER: Duration = Duration::from_secs(30);
const PAGE_GAP: Duration = Duration::from_millis(20);
/// The keyboard needs about a second to commit a config write.
const COMMIT_DELAY: Duration = Duration::from_millis(1100);

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MacroEventPayload {
    /// USB HID usage code (4..=231).
    pub hid: u8,
    pub down: bool,
    pub delay_ms: u32,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssignMacroPayload {
    /// `KeyboardEvent.code` of the key that triggers the macro (e.g. "KeyG").
    pub key_code: String,
    /// On-board macro slot, 0..50.
    pub slot: u8,
    /// "repeat" | "toggle" | "hold".
    pub mode: String,
    pub repeat_count: u16,
    pub events: Vec<MacroEventPayload>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MacroKeyInfo {
    pub key_code: String,
    pub slot: u8,
    pub mode: String,
}

pub(crate) fn backup_path(profile: u8) -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("aether-rgb").join(format!("keymap-backup-p{profile}.bin")))
}

pub(crate) fn open_link(api: &HidApi) -> Result<RgbLink, String> {
    let path = find_rgb_device_path(api).ok_or("Klavye RGB arayüzü bulunamadı.")?;
    RgbLink::open(api, &path)
}

pub(crate) fn read_profile(link: &mut RgbLink) -> Result<u8, String> {
    let reply = link.query_stable(&build_get_profile_packet())?;
    if reply[1] != OP_GET_PROFILE {
        return Err("Profil cevabı beklenen biçimde değil.".into());
    }
    Ok(if reply[2] < 4 { reply[2] } else { 0 })
}

/// Read the whole matrix. Each page must be read identically twice.
pub(crate) fn read_matrix(link: &mut RgbLink, profile: u8) -> Result<[u8; KEYMAP_BYTES], String> {
    let mut matrix = [0u8; KEYMAP_BYTES];
    for page in 0..KEYMAP_READ_PAGES {
        let reply = link.query_stable(&build_get_keymap_page(profile, page))?;
        matrix[page * 64..page * 64 + 64].copy_from_slice(&reply[1..65]);
    }
    if !matrix_looks_complete(&matrix) {
        return Err("Tuş matrisi eksik okundu; hiçbir şey yazılmadı. Klavyeyi uyandırıp tekrar deneyin.".into());
    }
    Ok(matrix)
}

pub(crate) fn write_matrix(link: &mut RgbLink, profile: u8, matrix: &[u8; KEYMAP_BYTES]) -> Result<(), String> {
    for page in 0..KEYMAP_WRITE_PAGES {
        link.send(&build_keymap_page(profile, page, matrix))
            .map_err(|e| format!("Tuş matrisi sayfa {page} yazılamadı: {e}"))?;
        std::thread::sleep(PAGE_GAP);
    }
    std::thread::sleep(COMMIT_DELAY);
    Ok(())
}

/// Save the matrix the first time we are about to change it.
pub(crate) fn ensure_backup(profile: u8, matrix: &[u8; KEYMAP_BYTES]) -> Result<(), String> {
    let path = backup_path(profile).ok_or("Ayar klasörü bulunamadı.")?;
    if path.exists() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Yedek klasörü oluşturulamadı: {e}"))?;
    }
    std::fs::write(&path, matrix).map_err(|e| format!("Yedek yazılamadı: {e}"))
}

pub(crate) fn load_backup(profile: u8) -> Result<[u8; KEYMAP_BYTES], String> {
    let path = backup_path(profile).ok_or("Ayar klasörü bulunamadı.")?;
    let bytes = std::fs::read(&path).map_err(|_| "Yedek bulunamadı; bu klavyede henüz atama yapılmamış.".to_string())?;
    let matrix: [u8; KEYMAP_BYTES] = bytes.try_into().map_err(|_| "Yedek dosyası bozuk.".to_string())?;
    if !matrix_looks_complete(&matrix) {
        return Err("Yedek dosyası eksik görünüyor, kullanılmadı.".into());
    }
    Ok(matrix)
}

pub(crate) fn slot_of(key_code: &str) -> Result<usize, String> {
    keycode_to_matrix_index(key_code)
        .filter(|&s| s < KEYMAP_FILLED_SLOTS)
        .ok_or_else(|| format!("'{key_code}' tuşu klavye matrisinde bulunamadı."))
}

fn read_macro(link: &mut RgbLink, slot: u8) -> Result<(u16, Vec<MacroEvent>), String> {
    let mut data = Vec::with_capacity(MACRO_READ_PAGES * 64);
    for page in 0..MACRO_READ_PAGES {
        let reply = link.query_stable(&build_get_macro_page(slot, page))?;
        data.extend_from_slice(&reply[1..65]);
    }
    decode_macro(&data).ok_or_else(|| "Makro geri okunamadı.".to_string())
}

#[tauri::command(async)]
pub fn assign_macro(payload: AssignMacroPayload, guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(SUPPRESS_POLLER);
    match assign_macro_inner(&payload) {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => {
            tracing::warn!(error = %e, key = %payload.key_code, "assign_macro failed");
            IpcResult::err(e)
        }
    }
}

fn assign_macro_inner(p: &AssignMacroPayload) -> Result<String, String> {
    let mode = MacroMode::from_name(&p.mode).ok_or("Bilinmeyen makro türü.")?;
    if p.slot >= MACRO_SLOTS {
        return Err(format!("Makro yuvası 0..{} arasında olmalı.", MACRO_SLOTS - 1));
    }
    if p.events.iter().any(|e| !(4..=231).contains(&e.hid)) {
        return Err("Makroda geçersiz tuş kodu var.".into());
    }
    let events: Vec<MacroEvent> = p.events.iter()
        .map(|e| MacroEvent { hid: e.hid, down: e.down, delay_ms: e.delay_ms.min(u16::MAX as u32) as u16 })
        .collect();
    let repeat = if mode == MacroMode::Repeat { p.repeat_count.max(1) } else { 1 };
    let data = encode_macro(&events, repeat)?;
    let key_slot = slot_of(&p.key_code)?;

    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let mut matrix = read_matrix(&mut link, profile)?;

    // Only plain keys (or a key that already runs a macro) may be replaced.
    let current = slot_entry(&matrix, key_slot);
    if !is_key_entry(&current) && parse_macro_entry(&current).is_none() {
        return Err(format!("'{}' tuşu özel bir işlev tuşu (Fn/medya); makro atanamaz.", p.key_code));
    }
    ensure_backup(profile, &matrix)?;

    for page in 0..MACRO_WRITE_PAGES {
        link.send(&build_macro_page(p.slot, page, &data))
            .map_err(|e| format!("Makro sayfa {page} yazılamadı: {e}"))?;
        std::thread::sleep(PAGE_GAP);
    }
    std::thread::sleep(COMMIT_DELAY);

    let entry = macro_entry(mode, p.slot);
    set_slot_entry(&mut matrix, key_slot, entry);
    write_matrix(&mut link, profile, &matrix)?;

    // Read both back so a silently dropped write is reported, not assumed.
    let check = read_matrix(&mut link, profile)?;
    if slot_entry(&check, key_slot) != entry {
        return Err("Yazıldı ama tuş ataması doğrulanamadı. Klavyeyi uyandırıp tekrar deneyin.".into());
    }
    let (read_repeat, read_events) = read_macro(&mut link, p.slot)?;
    if read_repeat != repeat || read_events != events {
        return Err("Tuş atandı ama makro içeriği doğrulanamadı.".into());
    }

    tracing::info!(key = %p.key_code, slot = p.slot, mode = mode.name(), events = events.len(), "Macro written and verified");
    Ok(format!("Makro klavyeye yazıldı ve doğrulandı ({} olay).", events.len()))
}

#[tauri::command(async)]
pub fn clear_macro_key(key_code: String, guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(SUPPRESS_POLLER);
    match clear_macro_key_inner(&key_code) {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => {
            tracing::warn!(error = %e, key = %key_code, "clear_macro_key failed");
            IpcResult::err(e)
        }
    }
}

fn clear_macro_key_inner(key_code: &str) -> Result<String, String> {
    let key_slot = slot_of(key_code)?;
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let mut matrix = read_matrix(&mut link, profile)?;

    if parse_macro_entry(&slot_entry(&matrix, key_slot)).is_none() {
        return Ok("Bu tuşta makro yok.".into());
    }
    let original = slot_entry(&load_backup(profile)?, key_slot);
    if parse_macro_entry(&original).is_some() {
        return Err("Yedekte bu tuş zaten makro görünüyor; elle sıfırlayın.".into());
    }
    set_slot_entry(&mut matrix, key_slot, original);
    write_matrix(&mut link, profile, &matrix)?;

    let check = read_matrix(&mut link, profile)?;
    if slot_entry(&check, key_slot) != original {
        return Err("Tuş eski haline döndürüldü ama doğrulanamadı.".into());
    }
    Ok("Tuş eski işlevine döndü.".into())
}

/// Write the saved original matrix back (undoes every key assignment).
#[tauri::command(async)]
pub fn restore_key_defaults(guard: State<'_, PollGuard>) -> IpcResult {
    guard.suppress(SUPPRESS_POLLER);
    let run = || -> Result<String, String> {
        let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
        let mut link = open_link(&api)?;
        let profile = read_profile(&mut link)?;
        let backup = load_backup(profile)?;
        write_matrix(&mut link, profile, &backup)?;
        let check = read_matrix(&mut link, profile)?;
        if check[..KEYMAP_WRITE_BYTES] != backup[..KEYMAP_WRITE_BYTES] {
            return Err("Yedek yazıldı ama doğrulanamadı.".into());
        }
        Ok("Tüm tuş atamaları ilk haline döndürüldü.".into())
    };
    match run() {
        Ok(msg) => IpcResult::ok(msg),
        Err(e) => IpcResult::err(e),
    }
}

/// Which of `key_codes` currently run an on-board macro.
#[tauri::command(async)]
pub fn read_macro_keys(key_codes: Vec<String>, guard: State<'_, PollGuard>) -> Result<Vec<MacroKeyInfo>, String> {
    guard.suppress(Duration::from_secs(15));
    let api = HidApi::new().map_err(|e| format!("HidApi init failed: {e}"))?;
    let mut link = open_link(&api)?;
    let profile = read_profile(&mut link)?;
    let matrix = read_matrix(&mut link, profile)?;

    let mut found = Vec::new();
    for code in key_codes {
        let Ok(slot) = slot_of(&code) else { continue };
        if let Some((mode, index)) = parse_macro_entry(&slot_entry(&matrix, slot)) {
            found.push(MacroKeyInfo { key_code: code, slot: index, mode: mode.name().to_string() });
        }
    }
    Ok(found)
}
