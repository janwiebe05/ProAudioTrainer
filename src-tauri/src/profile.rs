//! Local user profiles — no accounts, no passwords, no network auth. One or
//! more named profiles per install (e.g. a family/classroom computer shared
//! by several people), each with its own private library and score
//! history; exactly one is active at a time. See paw_core::store.

use crate::state::{now_iso, AppState};
use paw_core::store::Profile;

#[tauri::command]
pub fn profile_list(state: tauri::State<AppState>) -> Result<Vec<Profile>, String> {
    state.db.list_profiles().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_get_active(state: tauri::State<AppState>) -> Result<Option<Profile>, String> {
    state.db.get_active_profile().map_err(|e| e.to_string())
}

/// Creates a new profile and switches to it — used both for first-launch
/// onboarding and for "add another profile" later.
#[tauri::command]
pub fn profile_create(username: String, state: tauri::State<AppState>) -> Result<Profile, String> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Name darf nicht leer sein.".to_string());
    }
    state.db.create_profile(trimmed, &now_iso()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_switch(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    state.db.set_active_profile(&id).map_err(|e| e.to_string())
}

/// Deletes a profile, its private tracks (DB rows + the underlying audio
/// files), and its score history. Shared tracks are untouched.
#[tauri::command]
pub fn profile_delete(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let filenames = state.db.delete_profile(&id).map_err(|e| e.to_string())?;
    for filename in filenames {
        let _ = std::fs::remove_file(state.library_dir.join(filename));
    }
    Ok(())
}
