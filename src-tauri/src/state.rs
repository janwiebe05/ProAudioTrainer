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

/// Lightweight seconds-since-epoch timestamp — good enough for display/
/// ordering, avoids pulling in a chrono/time dependency. Shared by
/// library.rs, profile.rs and scores.rs (was duplicated in each before).
pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
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

/// Pick a random active, accessible track from the DB-backed library and
/// decode one CLIP_DURATION_SECS window from a random position in it — a
/// single open+probe pass (decode::decode_random_window), not the old
/// separate probe_duration_secs()+decode_clip() two-call, two-open dance.
pub fn load_random_clip(library_dir: &Path, db: &Store, rng: &mut impl Rng) -> Result<AudioBuffer, String> {
    let owner = current_profile_id(db)?;
    let track = db
        .pick_random_active_track(&owner, rng)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Keine Audiodateien in der Bibliothek gefunden.".to_string())?;
    let track_path = library_dir.join(&track.filename);
    decode::decode_random_window(&track_path, CLIP_DURATION_SECS, rng).map_err(|e| e.to_string())
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
