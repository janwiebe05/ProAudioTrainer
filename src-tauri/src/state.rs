//! Shared app state and the one bit of decode/pick logic every exercise
//! command needs: grab a random accessible+active library track (via the
//! SQLite-backed Store) and decode a clip from it.

use paw_core::exercise::common::CLIP_DURATION_SECS;
use paw_core::exercise::{dynamics, eq, eq_match, panning, reverb, stereo, transient};
use paw_core::store::Store;
use paw_core::{decode, AudioBuffer};
use rand::Rng;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg_attr(test, allow(dead_code))]
pub struct AppState {
    pub library_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Bundled read-only content (currently: EchoThief impulse responses).
    /// Resolved relative to the frontend dist dir in dev, and to the Tauri
    /// resource dir once packaged (see lib.rs setup()).
    pub content_dir: PathBuf,
    pub db: Store,
    pub eq_exercises: Mutex<HashMap<String, eq::EqExercise>>,
    pub dynamics_exercises: Mutex<HashMap<String, dynamics::DynamicsExercise>>,
    pub panning_exercises: Mutex<HashMap<String, panning::PanningExercise>>,
    pub stereo_exercises: Mutex<HashMap<String, stereo::StereoExercise>>,
    pub transient_exercises: Mutex<HashMap<String, transient::TransientExercise>>,
    pub reverb_exercises: Mutex<HashMap<String, reverb::ReverbExercise>>,
    pub eq_match_exercises: Mutex<HashMap<String, eq_match::EqMatchExercise>>,
}

/// UTC timestamp in actual ISO-8601 ("2026-09-14T16:39:00Z"), computed by
/// hand from `SystemTime` to avoid pulling in a chrono/time dependency for
/// something this small. Shared by library.rs, profile.rs and scores.rs
/// (was duplicated in each before).
///
/// This used to just be `format!("{secs}")` (bare Unix seconds) despite the
/// name — harmless for ordering (still monotonic, `ORDER BY created_at`
/// works either way) but `new Date(createdAt)` on a plain digit string
/// isn't a format JS recognizes, so every date in the frontend (e.g. the
/// Progress Dashboard's session history) rendered as "Invalid Date"/"—".
pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format_unix_secs_iso(secs)
}

/// Civil calendar conversion via Howard Hinnant's `civil_from_days`
/// algorithm (public domain, http://howardhinnant.github.io/date_algorithms.html)
/// — proleptic Gregorian, correct for any date this app will ever produce.
fn format_unix_secs_iso(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let (hour, minute, second) = (time_of_day / 3600, (time_of_day / 60) % 60, time_of_day % 60);

    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod now_iso_tests {
    use super::format_unix_secs_iso;

    #[test]
    fn epoch_zero_is_1970_01_01() {
        assert_eq!(format_unix_secs_iso(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn a_known_timestamp_round_trips_to_the_right_date() {
        // 2024-01-01T00:00:00Z
        assert_eq!(format_unix_secs_iso(1_704_067_200), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn output_is_parseable_by_a_standard_iso8601_reader() {
        // The whole point of the fix: this must be a format `new Date(...)`
        // (or any standard ISO-8601 parser) actually recognizes — a bare
        // digit string like "1704067200" is not.
        let s = format_unix_secs_iso(1_704_067_200);
        assert!(s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-') && s.contains('T') && s.ends_with('Z'));
    }
}

/// Remove and return the exercise for `id`, or the standard not-found
/// error — the lock/remove/error-map sequence every *_evaluate_impl repeats.
pub fn take_exercise<T>(
    exercises: &Mutex<HashMap<String, T>>,
    id: &str,
) -> Result<T, String> {
    exercises
        .lock()
        .unwrap()
        .remove(id)
        .ok_or_else(|| "Übung nicht gefunden oder abgelaufen".to_string())
}

/// The active local profile's id, used to decide which private tracks/
/// scores are visible. Multiple profiles can exist per install (see
/// paw_core::store); this is a real error, not a silent fallback, if
/// onboarding hasn't run yet or the active profile was deleted — every
/// caller needs a real profile id, and guessing one would misattribute
/// data to the wrong person.
pub fn current_profile_id(db: &Store) -> Result<String, String> {
    db.get_active_profile()
        .map_err(|e| e.to_string())?
        .map(|p| p.id)
        .ok_or_else(|| "Kein aktives Profil. Bitte zuerst ein Profil anlegen oder auswählen.".to_string())
}

/// A linked folder counts as reachable if its root can be listed within a
/// few seconds. The check runs on helper threads with a shared deadline:
/// a NAS that is switched off or unmounted can make a plain filesystem call
/// hang for a long time on Windows, and this runs before every exercise.
const FOLDER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether `path` is a readable directory, answered within
/// `FOLDER_PROBE_TIMEOUT` (see above for why the timeout matters).
pub fn is_reachable(path: &Path) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = tx.send(std::fs::read_dir(&path).is_ok());
    });
    rx.recv_timeout(FOLDER_PROBE_TIMEOUT).unwrap_or(false)
}

/// Ids of linked folders that can't be reached right now.
pub fn unreachable_folder_ids(db: &Store) -> Vec<String> {
    let folders = db.list_library_folders().unwrap_or_default();
    let probes: Vec<_> = folders
        .into_iter()
        .map(|f| {
            let (tx, rx) = std::sync::mpsc::channel();
            let path = PathBuf::from(&f.path);
            std::thread::spawn(move || {
                let _ = tx.send(std::fs::read_dir(&path).is_ok());
            });
            (f.id, rx)
        })
        .collect();
    let deadline = std::time::Instant::now() + FOLDER_PROBE_TIMEOUT;
    probes
        .into_iter()
        .filter_map(|(id, rx)| {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if rx.recv_timeout(left).unwrap_or(false) { None } else { Some(id) }
        })
        .collect()
}

/// Random active track the current profile may use, skipping linked
/// folders that are offline and any track ids in `exclude_tracks`.
pub fn pick_track(
    db: &Store,
    exclude_tracks: &[String],
    rng: &mut impl Rng,
) -> Result<paw_core::store::Track, String> {
    let owner = current_profile_id(db)?;
    let offline = unreachable_folder_ids(db);
    db.pick_random_active_track(&owner, &offline, exclude_tracks, rng)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            if offline.is_empty() {
                "Keine Audiodateien in der Bibliothek gefunden.".to_string()
            } else {
                "Keine Audiodateien erreichbar — ein verknüpfter Ordner (z. B. das Netzlaufwerk) ist offline.".to_string()
            }
        })
}

/// How many unreadable linked files to skip over before giving up on a
/// round (a file deleted from the NAS since the last refresh is only found
/// out when it is picked).
const MAX_PICK_ATTEMPTS: usize = 5;

/// Pick a random active, accessible track from the DB-backed library and
/// decode one CLIP_DURATION_SECS window from a random position in it — a
/// single open+probe pass (decode::decode_random_window), not the old
/// separate probe_duration_secs()+decode_clip() two-call, two-open dance.
///
/// A copied track that fails to decode is a real error. A *linked* track
/// that fails (moved/deleted on the share, permission change) is skipped
/// and another one is tried, so one stale entry doesn't break the round.
pub fn load_random_clip(library_dir: &Path, db: &Store, rng: &mut impl Rng) -> Result<AudioBuffer, String> {
    let mut skipped: Vec<String> = Vec::new();
    loop {
        let track = pick_track(db, &skipped, rng)?;
        let path = track.resolve_path(library_dir);
        match decode::decode_random_window(&path, CLIP_DURATION_SECS, rng) {
            Ok(clip) => return Ok(clip),
            Err(e) if track.source_path.is_some() && skipped.len() + 1 < MAX_PICK_ATTEMPTS => {
                eprintln!("linked file unreadable, skipping {}: {e}", path.display());
                skipped.push(track.id);
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
}

/// The shape every `*_random_impl` (except eq_match, which doesn't render
/// anything) follows: pick a random clip, generate+render an exercise from
/// it, write dry/wet WAV files, store the exercise keyed by a fresh id.
/// `generate_and_render` gets the decoded dry clip and an rng and returns
/// the exercise plus its rendered wet buffer — everything module-specific
/// (level configs, extra params, loading a reverb IR, adapting dynamics
/// thresholds to the signal, ...) lives entirely in that closure, so this
/// only factors out the parts that were previously copy-pasted identically
/// into every commands/*.rs file.
pub fn render_random_exercise<T: Clone>(
    library_dir: &Path,
    db: &Store,
    cache_dir: &Path,
    exercises: &Mutex<HashMap<String, T>>,
    generate_and_render: impl FnOnce(&AudioBuffer, &mut rand::rngs::ThreadRng) -> Result<(T, AudioBuffer), String>,
) -> Result<(String, String, String, T), String> {
    let mut rng = rand::thread_rng();
    let dry = load_random_clip(library_dir, db, &mut rng)?;
    let (exercise, wet) = generate_and_render(&dry, &mut rng)?;
    let (dry_path, processed_path) = write_dry_wet(cache_dir, &dry, &wet)?;

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let exercise_for_response = exercise.clone();
    exercises.lock().unwrap().insert(exercise_id.clone(), exercise);
    Ok((exercise_id, dry_path, processed_path, exercise_for_response))
}

/// Write dry+wet buffers to the cache dir as WAV, return their paths.
/// Encodes+writes both concurrently — they're fully independent, and this
/// runs on every single exercise round.
pub fn write_dry_wet(
    cache_dir: &Path,
    dry: &AudioBuffer,
    wet: &AudioBuffer,
) -> Result<(String, String), String> {
    use paw_core::encode::encode_wav_i16;

    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let dry_path = cache_dir.join(format!("{}-dry.wav", uuid::Uuid::new_v4()));
    let wet_path = cache_dir.join(format!("{}-wet.wav", uuid::Uuid::new_v4()));

    let write_one = |buf: &AudioBuffer, path: &Path| -> Result<(), String> {
        let bytes = encode_wav_i16(buf).map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())
    };

    std::thread::scope(|s| {
        let dry_handle = s.spawn(|| write_one(dry, &dry_path));
        let wet_result = write_one(wet, &wet_path);
        let dry_result = dry_handle.join().unwrap_or_else(|_| Err("dry-encode thread panicked".to_string()));
        dry_result?;
        wet_result?;
        Ok((dry_path.to_string_lossy().to_string(), wet_path.to_string_lossy().to_string()))
    })
}
