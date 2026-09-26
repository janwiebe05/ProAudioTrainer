//! Library management — Tauri commands backed by the SQLite Store
//! (paw_core::store). Metadata (ownership, active flag, duration) lives in
//! the DB; the audio itself is one of two kinds:
//!
//! * **copied** into `AppState.library_dir` (`library_upload` for a
//!   profile's private files, `library_import_shared_folder` for a shared
//!   pack) — independent of the original afterwards;
//! * **linked** (`library_link_folder`): a folder, typically a school NAS,
//!   registered *in place*. Nothing is copied, files are read from their
//!   source when used, and a refresh picks up additions and removals.
//!
//! `owner: None` on a track means shared content (visible to every profile
//! on this machine — imported packs and linked folders); `owner:
//! Some(profile_id)` is private to that local profile.
//!
//! Commands that can run long (imports, folder scans, anything touching a
//! network share) are `#[tauri::command(async)]`: plain commands run on the
//! main thread, which would freeze the window and hold back the progress
//! events they emit.

use crate::state::{current_profile_id, is_reachable, now_iso, unreachable_folder_ids, AppState};
use paw_core::decode;
use paw_core::store::{LibraryFolder, Track};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri::Emitter;

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
    /// False when the track's linked folder is offline (e.g. the NAS is off)
    /// — it stays listed but can't be played or used for exercises.
    pub available: bool,
}

/// Emitted as the `library-import-progress` event while a batch import runs,
/// so the Sound Library can show "12 / 48" instead of a silent wait.
#[derive(Clone, Serialize)]
struct ImportProgress {
    done: usize,
    total: usize,
}

/// Imports each file in turn and reports progress after every one (also
/// once up front, so a bar appears immediately for a big folder). A failed
/// emit only means the UI misses an update — never worth aborting an import.
fn import_all(
    app: &tauri::AppHandle,
    state: &AppState,
    files: &[PathBuf],
    owner: Option<&str>,
) -> u32 {
    let total = files.len();
    let _ = app.emit("library-import-progress", ImportProgress { done: 0, total });
    let mut imported = 0u32;
    for (i, file) in files.iter().enumerate() {
        if import_one_file(&state.library_dir, &state.db, file, owner) {
            imported += 1;
        }
        let _ = app.emit("library-import-progress", ImportProgress { done: i + 1, total });
    }
    imported
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
        source_path: None,
        folder_id: None,
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
///
/// Returns `false` if any directory couldn't be read: a folder sync must not
/// treat files it merely failed to see (a share hiccup, a permission
/// problem) as deleted.
fn scan_audio_files(dir: &Path, out: &mut Vec<PathBuf>) -> bool {
    let mut visited = HashSet::new();
    let mut complete = true;
    scan_audio_files_inner(dir, out, &mut visited, &mut complete, 0);
    complete
}

const MAX_SCAN_DEPTH: u32 = 64;

fn scan_audio_files_inner(
    dir: &Path,
    out: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
    complete: &mut bool,
    depth: u32,
) {
    if depth > MAX_SCAN_DEPTH {
        *complete = false;
        return;
    }
    if let Ok(canonical) = dir.canonicalize() {
        if !visited.insert(canonical) {
            return; // already scanned this real directory — symlink cycle
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        *complete = false;
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // The directory listing already says what each entry is; asking the
        // path again would cost one extra round trip per file on a network
        // share. Symlinks (whose target type isn't in the listing) are the
        // only case that still needs the follow-up check.
        let is_dir = match entry.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => path.is_dir(),
            Ok(_) => false,
            Err(_) => path.is_dir(),
        };
        if is_dir {
            scan_audio_files_inner(&path, out, visited, complete, depth + 1);
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

#[tauri::command(async)]
pub fn library_list(state: tauri::State<AppState>) -> Result<Vec<LibraryTrackDto>, String> {
    let owner = current_profile_id(&state.db)?;
    let tracks = state.db.list_accessible(&owner).map_err(|e| e.to_string())?;
    let offline: HashSet<String> = unreachable_folder_ids(&state.db).into_iter().collect();
    Ok(tracks
        .into_iter()
        .map(|t| {
            let path = t.resolve_path(&state.library_dir).to_string_lossy().to_string();
            let available = t.folder_id.as_ref().map_or(true, |f| !offline.contains(f));
            LibraryTrackDto { track: t, path, available }
        })
        .collect())
}

/// Copy each source file into the managed library dir as a *private* track
/// owned by the active profile. Returns how many were imported (files that
/// fail validation, copying, or decoding are skipped, not fatal to the
/// whole batch — the frontend shows the returned count so a partial import
/// is visible to the user).
#[tauri::command(async)]
pub fn library_upload(
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let owner = current_profile_id(&state.db)?;
    let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    Ok(import_all(&app, &state, &files, Some(&owner)))
}

/// Import every audio file under `folder_path` (recursively) as *shared*
/// content — the local counterpart to a central content pack: a teacher
/// prepares a folder (e.g. on a USB stick or network share) and each
/// install imports it once. No server/network distribution involved.
#[tauri::command(async)]
pub fn library_import_shared_folder(
    folder_path: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<u32, String> {
    std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    scan_audio_files(Path::new(&folder_path), &mut files);
    Ok(import_all(&app, &state, &files, None))
}

/// Fetches `id`, checked against the active profile: a private track
/// (owner IS a profile id) may only be touched by that same profile —
/// without this, any profile could mutate any other profile's private
/// track by id even though it never shows up in that profile's
/// `library_list`. Shared tracks (owner IS NULL) pass for everyone: this
/// install's own local copy of a shared pack isn't a live central resource
/// other people depend on, so mutating it is ordinary local housekeeping.
/// Returns `Ok(None)` for an already-gone id — callers treat that as a
/// no-op, not an error.
fn require_owned_track(db: &paw_core::store::Store, id: &str, owner: &str) -> Result<Option<Track>, String> {
    let Some(track) = db.get_track(id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if let Some(track_owner) = &track.owner {
        if track_owner != owner {
            return Err("Diese Datei gehört einem anderen Profil.".to_string());
        }
    }
    Ok(Some(track))
}

#[tauri::command]
pub fn library_toggle_active(id: String, active: bool, state: tauri::State<AppState>) -> Result<(), String> {
    let owner = current_profile_id(&state.db)?;
    if require_owned_track(&state.db, &id, &owner)?.is_none() {
        return Ok(());
    }
    state.db.set_active(&id, active).map_err(|e| e.to_string())
}

/// Deletes a track's DB row and underlying file.
#[tauri::command]
pub fn library_delete(id: String, state: tauri::State<AppState>) -> Result<(), String> {
    let owner = current_profile_id(&state.db)?;
    let Some(track) = require_owned_track(&state.db, &id, &owner)? else {
        return Ok(());
    };
    // A linked file belongs to the share, not to this app: deleting it from
    // a school NAS by accident would be far worse than any convenience.
    if track.source_path.is_some() {
        return Err(
            "Verknüpfte Dateien werden nie gelöscht. Deaktiviere die Datei oder entferne den verknüpften Ordner."
                .to_string(),
        );
    }
    let _ = std::fs::remove_file(state.library_dir.join(&track.filename));
    state.db.delete_track(&id).map_err(|e| e.to_string())
}

// ─── Linked folders ───────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncDto {
    pub folder: LibraryFolderDto,
    pub added: u32,
    pub removed: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderDto {
    pub id: String,
    pub path: String,
    pub track_count: i64,
    pub reachable: bool,
}

fn normalize_folder_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed.trim_end_matches(|c| c == '/' || c == '\\');
    // keep a bare root ("/" or "C:\") intact
    if stripped.is_empty() || stripped.ends_with(':') { trimmed.to_string() } else { stripped.to_string() }
}

/// Registers one file of a linked folder (no copy). Files that don't decode
/// as audio are skipped, same as for imports.
fn link_one_file(db: &paw_core::store::Store, folder_id: &str, file: &Path) -> bool {
    let Some(name) = file.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) else { return false };
    let Ok(size) = std::fs::metadata(file).map(|m| m.len()) else { return false };
    if size == 0 {
        return false;
    }
    let Ok(duration) = decode::probe_duration_secs(file) else { return false };
    let track = Track {
        id: uuid::Uuid::new_v4().to_string(),
        filename: name.clone(),
        original_name: name,
        size: size as i64,
        duration: Some(duration),
        mime_type: guess_mime_type(file),
        active: true,
        owner: None, // linked folders are shared with every profile on this machine
        added_at: now_iso(),
        source_path: Some(file.to_string_lossy().to_string()),
        folder_id: Some(folder_id.to_string()),
    };
    db.add_linked_track(&track).unwrap_or(false)
}

/// Brings the DB in line with what is currently in the folder: registers
/// files it doesn't know yet and drops tracks whose file is gone. Removal
/// only happens after a scan that read every directory — a share that
/// merely failed to answer must not wipe the library.
fn sync_folder(
    db: &paw_core::store::Store,
    folder: &LibraryFolder,
    progress: &dyn Fn(usize, usize),
) -> Result<(u32, u32), String> {
    let mut files = Vec::new();
    let complete = scan_audio_files(Path::new(&folder.path), &mut files);

    let known: HashMap<String, String> = db
        .folder_tracks(&folder.id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, path)| (path, id))
        .collect();
    let found: HashSet<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();

    let new_files: Vec<&PathBuf> = files.iter().filter(|p| !known.contains_key(&*p.to_string_lossy())).collect();
    let total = new_files.len();
    progress(0, total);
    let mut added = 0u32;
    for (i, file) in new_files.iter().enumerate() {
        if link_one_file(db, &folder.id, file) {
            added += 1;
        }
        progress(i + 1, total);
    }

    let mut removed = 0u32;
    if complete {
        let gone: Vec<String> = known.iter().filter(|(path, _)| !found.contains(*path)).map(|(_, id)| id.clone()).collect();
        removed = gone.len() as u32;
        db.delete_tracks(&gone).map_err(|e| e.to_string())?;
    }
    Ok((added, removed))
}

/// How often linked folders are re-read while the app is running. Network
/// shares don't reliably deliver file-change notifications (SMB drops
/// them), so polling is the dependable way to notice new files; a pass over
/// an unchanged folder is one directory walk plus in-memory comparison.
pub const LINKED_FOLDER_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// One background pass over every linked folder that is currently
/// reachable: registers new files, drops vanished ones. Offline folders are
/// skipped (their entries are kept until the share is back). Returns
/// (added, removed) across all folders. If a manual sync is running the
/// pass is skipped — it does the same work.
pub fn sync_all_linked_folders(db: &paw_core::store::Store, sync_lock: &Mutex<()>) -> (u32, u32) {
    let Ok(_guard) = sync_lock.try_lock() else { return (0, 0) };
    let offline: HashSet<String> = unreachable_folder_ids(db).into_iter().collect();
    let (mut added, mut removed) = (0, 0);
    for folder in db.list_library_folders().unwrap_or_default() {
        if offline.contains(&folder.id) {
            continue;
        }
        match sync_folder(db, &folder, &|_, _| {}) {
            Ok((a, r)) => {
                added += a;
                removed += r;
            }
            Err(e) => eprintln!("background sync of {} failed: {e}", folder.path),
        }
    }
    (added, removed)
}

#[derive(Clone, Serialize)]
struct LibraryChanged {
    added: u32,
    removed: u32,
}

/// Starts the thread that keeps linked folders current, so nobody has to
/// press "refresh": one pass shortly after startup, then every
/// `LINKED_FOLDER_POLL_INTERVAL`. When something changed it emits
/// `library-changed` so an open Sound Library can update itself.
pub fn start_linked_folder_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3)); // let the window come up first
        loop {
            let state = app.state::<AppState>();
            let (added, removed) = sync_all_linked_folders(&state.db, &state.folder_sync);
            if added > 0 || removed > 0 {
                let _ = app.emit("library-changed", LibraryChanged { added, removed });
            }
            std::thread::sleep(LINKED_FOLDER_POLL_INTERVAL);
        }
    });
}

fn emit_progress(app: &tauri::AppHandle, done: usize, total: usize) {
    let _ = app.emit("library-import-progress", ImportProgress { done, total });
}

fn folder_dto(state: &AppState, folder: &LibraryFolder, reachable: bool) -> LibraryFolderDto {
    let track_count = state
        .db
        .folder_track_counts()
        .unwrap_or_default()
        .into_iter()
        .find(|(id, _)| *id == folder.id)
        .map_or(0, |(_, n)| n);
    LibraryFolderDto { id: folder.id.clone(), path: folder.path.clone(), track_count, reachable }
}

/// Link a folder (e.g. a school NAS share) into the library *without
/// copying it*: its audio is registered as shared tracks and read from
/// there. Later additions/removals on the share are picked up by
/// `library_rescan_folder`.
#[tauri::command(async)]
pub fn library_link_folder(
    folder_path: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<FolderSyncDto, String> {
    let path = normalize_folder_path(&folder_path);
    if path.is_empty() {
        return Err("Kein Ordner angegeben.".to_string());
    }
    if !is_reachable(Path::new(&path)) {
        return Err(format!("Der Ordner ist nicht erreichbar: {path}"));
    }
    let existing = state.db.list_library_folders().map_err(|e| e.to_string())?;
    if existing.iter().any(|f| f.path == path) {
        return Err("Dieser Ordner ist bereits verknüpft.".to_string());
    }

    let _sync = state.folder_sync.lock().unwrap_or_else(|e| e.into_inner());
    let folder = LibraryFolder { id: uuid::Uuid::new_v4().to_string(), path, added_at: now_iso() };
    state.db.add_library_folder(&folder).map_err(|e| e.to_string())?;
    // The webview may only load audio from allowed locations; extend that
    // to the linked folder so previews and EQ Match can play from it.
    let _ = app.asset_protocol_scope().allow_directory(&folder.path, true);

    let (added, removed) = sync_folder(&state.db, &folder, &|done, total| emit_progress(&app, done, total))?;
    Ok(FolderSyncDto { folder: folder_dto(&state, &folder, true), added, removed })
}

/// Re-reads a linked folder: adds new files, drops ones that disappeared.
#[tauri::command(async)]
pub fn library_rescan_folder(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<FolderSyncDto, String> {
    let folder = state
        .db
        .get_library_folder(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Dieser Ordner ist nicht (mehr) verknüpft.".to_string())?;
    if !is_reachable(Path::new(&folder.path)) {
        return Err(format!("Der Ordner ist nicht erreichbar: {}", folder.path));
    }
    let _sync = state.folder_sync.lock().unwrap_or_else(|e| e.into_inner());
    let (added, removed) = sync_folder(&state.db, &folder, &|done, total| emit_progress(&app, done, total))?;
    Ok(FolderSyncDto { folder: folder_dto(&state, &folder, true), added, removed })
}

/// Removes the link and its tracks from the library. The audio files
/// themselves are never touched.
///
/// The webview's read access to the folder (granted when it was linked) is
/// deliberately left in place until the next start rather than revoked:
/// Tauri's `forbid_directory` overrides every allow rule for the rest of the
/// session, which would make re-linking the same folder impossible until a
/// restart. Leaving it costs nothing — the frontend only ever receives paths
/// of tracks that are still registered.
#[tauri::command(async)]
pub fn library_unlink_folder(id: String, state: tauri::State<AppState>) -> Result<u32, String> {
    let removed = state.db.remove_library_folder(&id).map_err(|e| e.to_string())?;
    Ok(removed as u32)
}

#[tauri::command(async)]
pub fn library_list_folders(state: tauri::State<AppState>) -> Result<Vec<LibraryFolderDto>, String> {
    let folders = state.db.list_library_folders().map_err(|e| e.to_string())?;
    let offline: HashSet<String> = unreachable_folder_ids(&state.db).into_iter().collect();
    Ok(folders.iter().map(|f| folder_dto(&state, f, !offline.contains(&f.id))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use paw_core::store::Store;

    fn write_wav(path: &Path) {
        let sr = 22_050u32;
        let mut buf = paw_core::AudioBuffer::new(sr, 1, sr as usize); // 1 s
        for (i, s) in buf.channels[0].iter_mut().enumerate() {
            *s = 0.3 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin();
        }
        std::fs::write(path, paw_core::encode::encode_wav_i16(&buf).unwrap()).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("paw-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn new_folder(db: &Store, dir: &Path) -> LibraryFolder {
        let f = LibraryFolder { id: uuid::Uuid::new_v4().to_string(), path: dir.to_string_lossy().to_string(), added_at: now_iso() };
        db.add_library_folder(&f).unwrap();
        f
    }

    #[test]
    fn linking_registers_files_in_place_including_subfolders_and_skips_non_audio() {
        let db = Store::open_in_memory().unwrap();
        let dir = temp_dir("link");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        write_wav(&dir.join("a.wav"));
        write_wav(&dir.join("sub").join("b.wav"));
        std::fs::write(dir.join("notes.txt"), "not audio").unwrap();
        std::fs::write(dir.join("broken.wav"), "not really a wav").unwrap();

        let folder = new_folder(&db, &dir);
        let progress = std::cell::RefCell::new(Vec::new());
        let (added, removed) = sync_folder(&db, &folder, &|d, t| progress.borrow_mut().push((d, t))).unwrap();

        assert_eq!((added, removed), (2, 0), "two real wavs; the text file and the undecodable wav are skipped");
        assert_eq!(progress.borrow().first(), Some(&(0, 3)), "progress starts at 0 of the 3 candidate audio files");
        assert_eq!(progress.borrow().last(), Some(&(3, 3)));
        let tracks = db.list_accessible("anyone").unwrap();
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|t| t.owner.is_none() && t.source_path.is_some() && t.folder_id.as_deref() == Some(folder.id.as_str())));
        // nothing was copied anywhere: the source files are still the only copies
        assert!(dir.join("a.wav").is_file());
    }

    #[test]
    fn rescan_is_idempotent_adds_new_files_and_drops_deleted_ones() {
        let db = Store::open_in_memory().unwrap();
        let dir = temp_dir("rescan");
        write_wav(&dir.join("a.wav"));
        write_wav(&dir.join("b.wav"));
        let folder = new_folder(&db, &dir);
        sync_folder(&db, &folder, &|_, _| {}).unwrap();

        assert_eq!(sync_folder(&db, &folder, &|_, _| {}).unwrap(), (0, 0), "second scan changes nothing");

        write_wav(&dir.join("c.wav"));
        std::fs::remove_file(dir.join("a.wav")).unwrap();
        assert_eq!(sync_folder(&db, &folder, &|_, _| {}).unwrap(), (1, 1));
        let mut names: Vec<String> = db.list_accessible("anyone").unwrap().into_iter().map(|t| t.original_name).collect();
        names.sort();
        assert_eq!(names, vec!["b.wav", "c.wav"]);
    }

    #[test]
    fn an_unreadable_folder_never_wipes_the_library() {
        // The share answers nothing (root can't be listed): the scan is
        // incomplete, so previously registered files must stay.
        let db = Store::open_in_memory().unwrap();
        let dir = temp_dir("offline");
        write_wav(&dir.join("a.wav"));
        let folder = new_folder(&db, &dir);
        sync_folder(&db, &folder, &|_, _| {}).unwrap();

        std::fs::remove_dir_all(&dir).unwrap(); // simulates the mount vanishing
        assert_eq!(sync_folder(&db, &folder, &|_, _| {}).unwrap(), (0, 0));
        assert_eq!(db.list_accessible("anyone").unwrap().len(), 1, "track must survive an unreachable scan");
    }

    #[test]
    fn offline_folders_are_detected_and_reachable_ones_are_not() {
        let db = Store::open_in_memory().unwrap();
        let online = temp_dir("on");
        let gone = temp_dir("off");
        let f_on = new_folder(&db, &online);
        let f_off = new_folder(&db, &gone);
        std::fs::remove_dir_all(&gone).unwrap();

        let offline = unreachable_folder_ids(&db);
        assert_eq!(offline, vec![f_off.id.clone()]);
        assert!(is_reachable(&online) && !is_reachable(&gone));
        let _ = f_on;
    }

    #[test]
    fn clip_loading_reads_linked_files_in_place_and_skips_a_vanished_one() {
        use crate::state::load_random_clip;
        let db = Store::open_in_memory().unwrap();
        db.create_profile("P", "2026-01-01T00:00:00Z").unwrap();
        let dir = temp_dir("clips");
        write_wav(&dir.join("keep.wav"));
        write_wav(&dir.join("vanish.wav"));
        let folder = new_folder(&db, &dir);
        sync_folder(&db, &folder, &|_, _| {}).unwrap();
        std::fs::remove_file(dir.join("vanish.wav")).unwrap(); // deleted on the share since the last refresh

        let lib = temp_dir("libdir"); // empty: proves the audio comes from the linked path
        let mut rng = rand::thread_rng();
        for _ in 0..20 {
            let clip = load_random_clip(&lib, &db, &mut rng).expect("a round must survive one stale linked entry");
            assert!(clip.num_frames() > 0);
        }
    }

    #[test]
    fn linked_tracks_are_recognisable_and_folder_paths_normalize() {
        // library_delete refuses tracks that carry a source_path (linked
        // ones); this checks they are recognisable by exactly that.
        let db = Store::open_in_memory().unwrap();
        let dir = temp_dir("guard");
        write_wav(&dir.join("a.wav"));
        let folder = new_folder(&db, &dir);
        sync_folder(&db, &folder, &|_, _| {}).unwrap();
        let track = db.list_accessible("anyone").unwrap().remove(0);
        assert!(track.source_path.is_some(), "linked tracks are recognisable, which is what library_delete checks");
        assert_eq!(normalize_folder_path("//nas/share/music/"), "//nas/share/music");
        assert_eq!(normalize_folder_path("  D:\\Musik\\ "), "D:\\Musik");
        assert_eq!(normalize_folder_path("C:\\"), "C:\\");
    }

    #[test]
    fn background_pass_picks_up_new_files_by_itself_and_skips_offline_shares() {
        let db = Store::open_in_memory().unwrap();
        let lock = Mutex::new(());
        let dir = temp_dir("auto");
        write_wav(&dir.join("a.wav"));
        let folder = new_folder(&db, &dir);
        sync_folder(&db, &folder, &|_, _| {}).unwrap();
        // a second share that is offline (never existed)
        let gone = temp_dir("auto-off");
        let off = new_folder(&db, &gone);
        std::fs::remove_dir_all(&gone).unwrap();
        db.add_linked_track(&paw_core::store::Track {
            id: "stale".into(), filename: "x.wav".into(), original_name: "x.wav".into(), size: 1, duration: Some(1.0),
            mime_type: None, active: true, owner: None, added_at: now_iso(),
            source_path: Some(format!("{}/x.wav", off.path)), folder_id: Some(off.id.clone()),
        }).unwrap();

        // nobody presses anything: a teacher just drops a file on the share
        write_wav(&dir.join("new-from-teacher.wav"));
        assert_eq!(sync_all_linked_folders(&db, &lock), (1, 0));
        assert_eq!(sync_all_linked_folders(&db, &lock), (0, 0), "an unchanged share is a no-op");

        let names: Vec<String> = db.list_accessible("anyone").unwrap().into_iter().map(|t| t.original_name).collect();
        assert!(names.contains(&"new-from-teacher.wav".to_string()));
        assert!(names.contains(&"x.wav".to_string()), "entries of an offline share are kept until it is back");
    }

    #[test]
    fn background_pass_yields_to_a_running_manual_sync() {
        let db = Store::open_in_memory().unwrap();
        let dir = temp_dir("busy");
        write_wav(&dir.join("a.wav"));
        new_folder(&db, &dir);
        let lock = Mutex::new(());
        let _manual = lock.lock().unwrap(); // a link/refresh is in progress
        assert_eq!(sync_all_linked_folders(&db, &lock), (0, 0));
        assert!(db.list_accessible("anyone").unwrap().is_empty(), "the pass must not run concurrently");
    }
}
