//! Library management — Tauri commands backed by the SQLite Store
//! (paw_core::store). Audio files live under `AppState.library_dir`;
//! metadata (ownership, active flag, duration) lives in the DB.
//!
//! `owner: None` on a track means shared content (e.g. a pack a teacher
//! prepared and everyone imports locally, see `library_import_shared_folder`);
//! `owner: Some(profile_id)` is private to that local profile.

use crate::state::{current_profile_id, now_iso, AppState};
use paw_core::decode;
use paw_core::store::Track;
use serde::Serialize;
use std::path::{Path, PathBuf};

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

fn guess_mime_type(path: &Path) -> Option<String> {
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

/// Copy one source file into `library_dir` and register it with the given
/// `owner` (None = shared). Returns `true` if it was imported, `false` if
/// it was skipped (wrong extension, too large, or doesn't actually decode
/// as audio) — never fatal to a batch import.
fn import_one_file(library_dir: &Path, db: &paw_core::store::Store, src: &Path, owner: Option<&str>) -> bool {
    let Some(original_name) = src.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else { return false };

    let ext = src.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
    let Some(ext) = ext else { return false }; // no extension at all — reject
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return false;
    }
    let Ok(src_size) = std::fs::metadata(src).map(|m| m.len()) else { return false };
    if src_size == 0 || src_size > MAX_UPLOAD_BYTES {
        return false;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let stored_filename = format!("{id}.{ext}");
    let dest = library_dir.join(&stored_filename);

    if std::fs::copy(src, &dest).is_err() {
        return false;
    }

    // Reject anything that doesn't actually decode as audio — an
    // undecodable file entering the active pool would otherwise only
    // surface as an opaque failure the next time it's randomly picked
    // for an exercise, with no indication of which file is broken.
    let Ok(duration) = decode::probe_duration_secs(&dest) else {
        let _ = std::fs::remove_file(&dest);
        return false;
    };

    let track = Track {
        id,
        filename: stored_filename,
        original_name,
        size: src_size as i64,
        duration: Some(duration),
        mime_type: guess_mime_type(&dest),
        active: true,
        owner: owner.map(|s| s.to_string()),
        added_at: now_iso(),
    };
    if db.add_track(&track).is_ok() {
        true
    } else {
        let _ = std::fs::remove_file(&dest);
        false
    }
}

/// Recursively collect files under `dir` whose extension is in
/// ALLOWED_EXTENSIONS (case-insensitive) — used for shared-folder import,
/// where a teacher's prepared pack may have subfolders per category (the
/// bundled EchoThief content is organized the same way).
///
/// `path.is_dir()` follows symlinks, so a folder containing a symlink back
/// at an ancestor directory (or at `/`) would otherwise recurse forever and
/// stack-overflow the whole backend process. Guard against that with a
/// canonicalized visited-set (dedups symlink cycles) and a hard depth cap
/// (handles any cycle canonicalize can't see, e.g. a race, and just bounds
/// worst-case work on a legitimately huge tree).
fn scan_audio_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut visited = std::collections::HashSet::new();
    scan_audio_files_inner(dir, out, &mut visited, 0);
}

const MAX_SCAN_DEPTH: u32 = 64;

fn scan_audio_files_inner(dir: &Path, out: &mut Vec<PathBuf>, visited: &mut std::collections::HashSet<PathBuf>, depth: u32) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    if let Ok(canonical) = dir.canonicalize() {
        if !visited.insert(canonical) {
            return; // already scanned this real directory — symlink cycle
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_audio_files_inner(&path, out, visited, depth + 1);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| ALLOWED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

#[tauri::command]
pub fn library_list(state: tauri::State<AppState>) -> Result<Vec<LibraryTrackDto>, String> {
    let owner = current_profile_id(&state.db)?;
    let tracks = state.db.list_accessible(&owner).map_err(|e| e.to_string())?;
    Ok(tracks
        .into_iter()
        .map(|t| {
            let path = state.library_dir.join(&t.filename).to_string_lossy().to_string();
            LibraryTrackDto { track: t, path }
        })
        .collect())
}

/// Copy each source file into the managed library dir as a *private* track
/// owned by the active profile. Returns how many were imported (files that
/// fail validation, copying, or decoding are skipped, not fatal to the
/// whole batch — the frontend shows the returned count so a partial import
/// is visible to the user).
#[tauri::command]
pub fn library_upload(paths: Vec<String>, state: tauri::State<AppState>) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let owner = current_profile_id(&state.db)?;
    let imported = paths
        .iter()
        .filter(|p| import_one_file(&state.library_dir, &state.db, Path::new(p), Some(&owner)))
        .count();
    Ok(imported as u32)
}

/// Import every audio file under `folder_path` (recursively) as *shared*
/// content — the local counterpart to a central content pack: a teacher
/// prepares a folder (e.g. on a USB stick or network share) and each
/// install imports it once. No server/network distribution involved.
#[tauri::command]
pub fn library_import_shared_folder(folder_path: String, state: tauri::State<AppState>) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    scan_audio_files(Path::new(&folder_path), &mut files);
    let imported = files
        .iter()
        .filter(|p| import_one_file(&state.library_dir, &state.db, p, None))
        .count();
    Ok(imported as u32)
}

/// Same ownership rule as `library_delete`: a private track can only be
/// toggled by its own profile, otherwise any profile could silently
/// activate/deactivate another profile's private track by id even though
/// it never shows up in that profile's `library_list`.
#[tauri::command]
pub fn library_toggle_active(id: String, active: bool, state: tauri::State<AppState>) -> Result<(), String> {
    let owner = current_profile_id(&state.db)?;
    let Some(track) = state.db.get_track(&id).map_err(|e| e.to_string())? else {
        return Ok(()); // already gone — no-op, not an error
    };
    if let Some(track_owner) = &track.owner {
        if track_owner != &owner {
            return Err("Diese Datei gehört einem anderen Profil.".to_string());
        }
    }
    state.db.set_active(&id, active).map_err(|e| e.to_string())
}

/// Deletes a track's DB row and underlying file. A private track can only
/// be deleted by its own profile — without this check, any profile could
/// delete any other profile's private track by id. Shared tracks (owner
/// IS NULL) can be deleted by any profile: they're this install's own
/// local copy of a shared pack, not a live central resource other people
/// depend on, so this is ordinary local housekeeping, not something that
/// needs protecting the way cross-profile private files do.
#[tauri::command]
pub fn library_delete(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let owner = current_profile_id(&state.db)?;
    let Some(track) = state.db.get_track(&id).map_err(|e| e.to_string())? else {
        return Ok(()); // already gone — deleting a nonexistent id is a no-op, not an error
    };
    if let Some(track_owner) = &track.owner {
        if track_owner != &owner {
            return Err("Diese Datei gehört einem anderen Profil.".to_string());
        }
    }
    let _ = std::fs::remove_file(state.library_dir.join(&track.filename));
    state.db.delete_track(&id).map_err(|e| e.to_string())
}
