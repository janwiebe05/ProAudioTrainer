//! Local user profile — no accounts, no passwords, no network auth. A
//! single name per install, used only to tag which library tracks are
//! "yours" vs. shared/school content (see paw_core::store).

use crate::state::AppState;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

#[tauri::command]
pub fn profile_get(state: tauri::State<AppState>) -> Result<Option<String>, String> {
    state.db.get_profile_username().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_set(username: String, state: tauri::State<AppState>) -> Result<(), String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Name darf nicht leer sein.".to_string());
    }
    state.db.set_profile_username(trimmed, &now_iso()).map_err(|e| e.to_string())
}
