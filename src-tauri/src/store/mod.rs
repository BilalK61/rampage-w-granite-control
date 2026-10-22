/// Persistent state store — replaces `localStorage` from the Electron renderer.
///
/// Stores per-key color assignments and favorite colors in a JSON file at:
///   Windows: %APPDATA%\aether-rgb\state.json
///   Linux:   ~/.config/aether-rgb/state.json
///   macOS:   ~/Library/Application Support/aether-rgb/state.json

use std::{collections::HashMap, path::PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// key code → hex color string, e.g. `{"KeyW": "#06b6d4"}`
    #[serde(default)]
    pub per_key_colors: HashMap<String, String>,
    /// Ordered list of favorite hex color strings (max 12).
    #[serde(default)]
    pub favorite_colors: Vec<String>,
}

fn state_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("aether-rgb").join("state.json"))
}

/// Load state from disk. Returns `Default::default()` if the file doesn't exist
/// or can't be parsed (never panics — treats missing/corrupt file as empty state).
pub fn load_state() -> AppState {
    let path = match state_path() {
        Some(p) => p,
        None    => return AppState::default(),
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(s)  => s,
        Err(_) => return AppState::default(),
    };

    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persist state to disk. Creates parent directories if needed.
pub fn save_state(state: &AppState) -> Result<(), String> {
    let path = state_path().ok_or_else(|| "Cannot resolve config directory".to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// One temp file per test: tests run in parallel and must not share a path.
    fn temp_path(test: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aether-rgb-test-{}-{test}.json", std::process::id()))
    }

    fn save_to(path: &PathBuf, state: &AppState) -> Result<(), String> {
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    fn load_from(path: &PathBuf) -> AppState {
        let raw = fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    }

    #[test]
    fn roundtrip_per_key_colors() {
        let path = temp_path("per_key");
        let mut state = AppState::default();
        state.per_key_colors.insert("KeyW".to_string(), "#06b6d4".to_string());
        state.per_key_colors.insert("Space".to_string(), "#10b981".to_string());

        save_to(&path, &state).unwrap();
        let loaded = load_from(&path);

        assert_eq!(loaded.per_key_colors.get("KeyW"), Some(&"#06b6d4".to_string()));
        assert_eq!(loaded.per_key_colors.get("Space"), Some(&"#10b981".to_string()));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn roundtrip_favorite_colors() {
        let path = temp_path("favorites");
        let mut state = AppState::default();
        state.favorite_colors = vec!["#8b5cf6".to_string(), "#ec4899".to_string()];

        save_to(&path, &state).unwrap();
        let loaded = load_from(&path);

        assert_eq!(loaded.favorite_colors, vec!["#8b5cf6", "#ec4899"]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_file_returns_default() {
        let loaded = load_from(&PathBuf::from("/nonexistent/path/state.json"));
        assert!(loaded.per_key_colors.is_empty());
        assert!(loaded.favorite_colors.is_empty());
    }

    #[test]
    fn corrupt_json_returns_default() {
        let path = temp_path("corrupt");
        fs::write(&path, b"not valid json!!!").unwrap();
        let loaded = load_from(&path);
        assert!(loaded.per_key_colors.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn max_favorites_enforced_by_caller() {
        // The store itself doesn't cap at 12 — the renderer enforces this.
        // But we verify serialization handles large lists gracefully.
        let mut state = AppState::default();
        for i in 0..20 {
            state.favorite_colors.push(format!("#{:06x}", i * 0x111111));
        }
        let json = serde_json::to_string(&state).unwrap();
        let loaded: AppState = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.favorite_colors.len(), 20);
    }
}
