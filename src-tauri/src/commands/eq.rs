use crate::state::{load_random_clip, write_dry_wet, AppState};
use paw_core::exercise::eq::{self, EqExercise};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Serialize, Debug, PartialEq)]
pub struct EqRandomResponse {
    #[serde(rename = "exerciseId")]
    pub exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    pub level: u8,
    #[serde(rename = "gainDb")]
    pub gain_db: f32,
    #[serde(rename = "freqMin")]
    pub freq_min: f32,
    #[serde(rename = "freqMax")]
    pub freq_max: f32,
}

pub fn eq_random_impl(
    level: u8,
    freq_min: Option<f32>,
    freq_max: Option<f32>,
    library_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, EqExercise>>,
) -> Result<EqRandomResponse, String> {
    let mut rng = rand::thread_rng();
    let dry = load_random_clip(library_dir, &mut rng)?;

    let exercise = eq::generate(level, freq_min, freq_max, &mut rng);
    let wet = eq::render(&dry, &exercise);
    let (dry_path, processed_path) = write_dry_wet(cache_dir, &dry, &wet)?;

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let response = EqRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path,
        processed_path,
        level: exercise.level,
        gain_db: exercise.gain_db,
        freq_min: exercise.freq_min,
        freq_max: exercise.freq_max,
    };
    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
}

pub fn eq_evaluate_impl(
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

#[tauri::command]
pub fn eq_random(
    level: u8,
    freq_min: Option<f32>,
    freq_max: Option<f32>,
    state: tauri::State<AppState>,
) -> Result<EqRandomResponse, String> {
    eq_random_impl(level, freq_min, freq_max, &state.library_dir, &state.cache_dir, &state.eq_exercises)
}

#[tauri::command]
pub fn eq_evaluate(
    exercise_id: String,
    guess_freq: f32,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<eq::EqResult, String> {
    eq_evaluate_impl(&exercise_id, guess_freq, seconds_taken, &state.eq_exercises)
}
