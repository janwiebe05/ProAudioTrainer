//! Library management — Tauri commands backed by the SQLite Store
//! (paw_core::store). Audio files live under `AppState.library_dir`;
//! metadata (ownership, active flag, duration) lives in the DB.

use crate::state::{current_owner, now_iso, AppState};
use paw_core::decode;
use paw_core::store::Track;
use serde::Serialize;
use std::path::PathBuf;

const ALLOWED_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "ogg", "aiff", "aif", "m4a", "aac"];
/// Generous but bounded — a single lossless track rarely exceeds a few
/// hundred MB; this mainly exists to stop someone accidentally importing
/// something that isn't a short audio file at all.
const MAX_UPLOAD_BYTES: u64 = 500 * 1024 * 1024;

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
        "aiff" | "aif" => "audio/aiff",
        "m4a" | "aac" => "audio/aac",
        _ => return None,
    }.to_string())
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
/// Returns how many were imported (files that fail validation, copying, or
/// decoding are skipped, not fatal to the whole batch — the frontend shows
/// the returned count so a partial import is visible to the user).
#[tauri::command]
pub fn library_upload(paths: Vec<String>, state: tauri::State<AppState>) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let owner = current_owner(&state.db);
    let mut imported = 0u32;

    for p in paths {
        let src = PathBuf::from(&p);
        let Some(original_name) = src.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else { continue };

        let ext = src.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
        let Some(ext) = ext else { continue }; // no extension at all — reject
        if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(src_size) = std::fs::metadata(&src).map(|m| m.len()) else { continue };
        if src_size == 0 || src_size > MAX_UPLOAD_BYTES {
            continue;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let stored_filename = format!("{id}.{ext}");
        let dest = state.library_dir.join(&stored_filename);

        if std::fs::copy(&src, &dest).is_err() {
            continue;
        }

        // Reject anything that doesn't actually decode as audio — an
        // undecodable file entering the active pool would otherwise only
        // surface as an opaque failure the next time it's randomly picked
        // for an exercise, with no indication of which file is broken.
        let Ok(duration) = decode::probe_duration_secs(&dest) else {
            let _ = std::fs::remove_file(&dest);
            continue;
        };

        let track = Track {
            id,
            filename: stored_filename,
            original_name,
            size: src_size as i64,
            duration: Some(duration),
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
