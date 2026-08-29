mod library;

use paw_core::exercise::common::CLIP_DURATION_SECS;
use paw_core::exercise::eq::{self, EqExercise};
use paw_core::{decode, encode};
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

#[cfg_attr(test, allow(dead_code))]
struct AppState {
    library_dir: PathBuf,
    cache_dir: PathBuf,
    eq_exercises: Mutex<HashMap<String, EqExercise>>,
}

fn pick_start_time(duration_secs: f64, rng: &mut impl Rng) -> f64 {
    let range = (duration_secs - CLIP_DURATION_SECS).max(0.0);
    rng.gen::<f64>() * range
}

#[derive(Serialize, Debug, PartialEq)]
struct EqRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    dry_path: String,
    #[serde(rename = "processedPath")]
    processed_path: String,
    level: u8,
    #[serde(rename = "gainDb")]
    gain_db: f32,
    #[serde(rename = "freqMin")]
    freq_min: f32,
    #[serde(rename = "freqMax")]
    freq_max: f32,
}

/// The actual EQ-exercise pipeline: pick a track, decode a clip, generate
/// the exercise, render dry+wet, write both to disk as WAV. Free of any
/// Tauri types so it's directly testable (see tests below) and so the
/// #[tauri::command] wrapper stays a thin adapter over `tauri::State`.
fn eq_random_impl(
    level: u8,
    freq_min: Option<f32>,
    freq_max: Option<f32>,
    library_dir: &Path,
    cache_dir: &Path,
    exercises: &Mutex<HashMap<String, EqExercise>>,
) -> Result<EqRandomResponse, String> {
    let mut rng = rand::thread_rng();

    let track_path = library::pick_random_track(library_dir, &mut rng)
        .ok_or_else(|| "Keine Audiodateien in der Bibliothek gefunden.".to_string())?;

    let duration = decode::probe_duration_secs(&track_path).map_err(|e| e.to_string())?;
    let start = pick_start_time(duration, &mut rng);
    let dry = decode::decode_clip(&track_path, start, CLIP_DURATION_SECS).map_err(|e| e.to_string())?;

    let exercise = eq::generate(level, freq_min, freq_max, &mut rng);
    let wet = eq::render(&dry, &exercise);

    let dry_bytes = encode::encode_wav_i16(&dry).map_err(|e| e.to_string())?;
    let wet_bytes = encode::encode_wav_i16(&wet).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let dry_path = cache_dir.join(format!("{}-dry.wav", Uuid::new_v4()));
    let processed_path = cache_dir.join(format!("{}-wet.wav", Uuid::new_v4()));
    std::fs::write(&dry_path, dry_bytes).map_err(|e| e.to_string())?;
    std::fs::write(&processed_path, wet_bytes).map_err(|e| e.to_string())?;

    let exercise_id = Uuid::new_v4().to_string();
    let response = EqRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path: dry_path.to_string_lossy().to_string(),
        processed_path: processed_path.to_string_lossy().to_string(),
        level: exercise.level,
        gain_db: exercise.gain_db,
        freq_min: exercise.freq_min,
        freq_max: exercise.freq_max,
    };

    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
}

fn eq_evaluate_impl(
    exercise_id: &str,
    guess_freq: f32,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, EqExercise>>,
) -> Result<eq::EqResult, String> {
    let exercise = exercises
        .lock()
        .unwrap()
        .remove(exercise_id)
        .ok_or_else(|| "Übung nicht gefunden oder abgelaufen".to_string())?;
    Ok(eq::evaluate(&exercise, guess_freq, seconds_taken))
}

#[cfg(not(test))]
mod commands {
    use super::*;
    use tauri::{Manager, State};

    #[tauri::command]
    pub fn eq_random(
        level: u8,
        freq_min: Option<f32>,
        freq_max: Option<f32>,
        state: State<AppState>,
    ) -> Result<EqRandomResponse, String> {
        eq_random_impl(level, freq_min, freq_max, &state.library_dir, &state.cache_dir, &state.eq_exercises)
    }

    #[tauri::command]
    pub fn eq_evaluate(
        exercise_id: String,
        guess_freq: f32,
        seconds_taken: f32,
        state: State<AppState>,
    ) -> Result<eq::EqResult, String> {
        eq_evaluate_impl(&exercise_id, guess_freq, seconds_taken, &state.eq_exercises)
    }

    #[tauri::command]
    pub fn library_count(state: State<AppState>) -> u32 {
        library::scan_tracks(&state.library_dir).len() as u32
    }

    #[tauri::command]
    pub fn library_import(paths: Vec<String>, state: State<AppState>) -> Result<u32, String> {
        std::fs::create_dir_all(&state.library_dir).map_err(|e| e.to_string())?;
        let mut imported = 0u32;
        for p in paths {
            let src = PathBuf::from(&p);
            let Some(name) = src.file_name() else { continue };
            let dest = state.library_dir.join(name);
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
            imported += 1;
        }
        Ok(imported)
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        tauri::Builder::default()
            .setup(|app| {
                let library_dir = app.path().app_local_data_dir()?.join("library");
                let cache_dir = app.path().app_cache_dir()?.join("exercises");
                std::fs::create_dir_all(&library_dir)?;
                std::fs::create_dir_all(&cache_dir)?;

                app.manage(AppState {
                    library_dir,
                    cache_dir,
                    eq_exercises: Mutex::new(HashMap::new()),
                });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                eq_random,
                eq_evaluate,
                library_count,
                library_import,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg(not(test))]
pub use commands::run;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_library_dir() -> PathBuf {
        PathBuf::from("/tmp/paw-test-library")
    }

    /// Full vertical-slice pipeline test against a real audio file: scan
    /// library -> probe duration -> decode a clip -> generate an EQ exercise
    /// -> render dry+wet -> write WAV files -> evaluate a guess. Proves the
    /// command wiring end-to-end without needing a running webview (which
    /// this headless container can't reliably render anyway — see plan).
    #[test]
    fn eq_random_then_evaluate_round_trip_against_real_audio() {
        let lib_dir = test_library_dir();
        assert!(lib_dir.join("track.mp3").exists(), "test fixture missing at {lib_dir:?} — see setup instructions");

        let cache_dir = PathBuf::from("/tmp/paw-test-cache");
        let _ = std::fs::remove_dir_all(&cache_dir);
        let exercises: Mutex<HashMap<String, EqExercise>> = Mutex::new(HashMap::new());

        let response = eq_random_impl(2, None, None, &lib_dir, &cache_dir, &exercises)
            .expect("eq_random_impl should succeed against the real test fixture");

        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());
        assert_eq!(response.level, 2);
        assert!(response.freq_min > 0.0 && response.freq_max > response.freq_min);

        let dry_size = std::fs::metadata(&response.dry_path).unwrap().len();
        let wet_size = std::fs::metadata(&response.processed_path).unwrap().len();
        // ~20s stereo 16-bit PCM at a typical sample rate should be a few MB, not near-empty.
        assert!(dry_size > 500_000, "dry clip suspiciously small: {dry_size} bytes");
        assert!(wet_size > 500_000, "wet clip suspiciously small: {wet_size} bytes");

        assert_eq!(exercises.lock().unwrap().len(), 1);

        // Correct-ish guess should score points; the exercise is consumed (one-shot).
        let target_freq = {
            let map = exercises.lock().unwrap();
            map.values().next().unwrap().freq
        };
        let result = eq_evaluate_impl(&response.exercise_id, target_freq, 1.0, &exercises)
            .expect("evaluate should succeed for a just-created exercise");
        assert!(result.hit);
        assert!(result.points > 0);
        assert_eq!(exercises.lock().unwrap().len(), 0, "exercise should be one-shot (removed after evaluate)");

        // Second evaluate on the same id must fail — it was already consumed.
        let second = eq_evaluate_impl(&response.exercise_id, target_freq, 1.0, &exercises);
        assert!(second.is_err());
    }

    #[test]
    fn eq_random_fails_gracefully_on_empty_library() {
        let empty_dir = PathBuf::from("/tmp/paw-test-empty-library");
        std::fs::create_dir_all(&empty_dir).unwrap();
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-2");
        let exercises: Mutex<HashMap<String, EqExercise>> = Mutex::new(HashMap::new());

        let result = eq_random_impl(1, None, None, &empty_dir, &cache_dir, &exercises);
        assert!(result.is_err());
    }
}
