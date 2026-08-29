//! Library management — Tauri commands backed by the SQLite Store
//! (paw_core::store). Audio files live under `AppState.library_dir`;
//! metadata (ownership, active flag, duration) lives in the DB.

use crate::state::{current_owner, AppState};
use paw_core::decode;
use paw_core::store::Track;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
pub struct LibraryTrackDto {
    #[serde(flatten)]
    pub track: Track,
    /// Absolute filesystem path, ready for tauriFileUrl() on the frontend —
    /// callers shouldn't need to know library_dir to play a preview.
    pub path: String,
}

fn guess_mime_type(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" | "aac" => "audio/aac",
        _ => return None,
    }.to_string())
}

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Lightweight ISO-ish timestamp — good enough for display/ordering,
    // avoids pulling in a chrono/time dependency just for this.
    format!("{secs}")
}

#[tauri::command]
pub fn library_list(state: tauri::State<AppState>) -> Result<Vec<LibraryTrackDto>, String> {
    let owner = current_owner(&state.db);
    let tracks = state.db.list_accessible(&owner).map_err(|e| e.to_string())?;
    Ok(tracks
        .into_iter()
        .map(|t| {
            let path = state.library_dir.join(&t.filename).to_string_lossy().to_string();
            LibraryTrackDto { track: t, path }
        })
        .collect())
}

/// Copy each source file into the managed library dir and register it.
/// Returns how many were imported (files that fail to copy/probe are
/// skipped, not fatal to the whole batch).
#[tauri::command]
pub fn library_upload(paths: Vec<String>, state: tauri::State<AppState>) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let owner = current_owner(&state.db);
    let mut imported = 0u32;

    for p in paths {
        let src = PathBuf::from(&p);
        let Some(original_name) = src.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else { continue };
        let id = uuid::Uuid::new_v4().to_string();
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let stored_filename = format!("{id}.{ext}");
        let dest = state.library_dir.join(&stored_filename);

        if std::fs::copy(&src, &dest).is_err() {
            continue;
        }
        let size = std::fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
        let duration = decode::probe_duration_secs(&dest).ok();

        let track = Track {
            id,
            filename: stored_filename,
            original_name,
            size,
            duration,
            mime_type: guess_mime_type(&dest),
            active: true,
            owner: Some(owner.clone()),
            added_at: now_iso(),
        };
        if state.db.add_track(&track).is_ok() {
            imported += 1;
        } else {
            let _ = std::fs::remove_file(&dest);
        }
    }
    Ok(imported)
}

#[tauri::command]
pub fn library_toggle_active(id: String, active: bool, state: tauri::State<AppState>) -> Result<(), String> {
    state.db.set_active(&id, active).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_delete(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    if let Some(track) = state.db.get_track(&id).map_err(|e| e.to_string())? {
        let _ = std::fs::remove_file(state.library_dir.join(&track.filename));
    }
    state.db.delete_track(&id).map_err(|e| e.to_string())
}
