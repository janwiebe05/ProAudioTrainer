use crate::state::{render_random_exercise, AppState};
use paw_core::store::Store;
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
    db: &Store,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, EqExercise>>,
) -> Result<EqRandomResponse, String> {
    let (exercise_id, dry_path, processed_path, exercise) = render_random_exercise(
        library_dir, db, cache_dir, exercises,
        |dry, rng| {
            let exercise = eq::generate(level, freq_min, freq_max, dry, rng);
            let wet = eq::render(dry, &exercise);
            Ok((exercise, wet))
        },
    )?;

    Ok(EqRandomResponse {
        exercise_id,
        dry_path,
        processed_path,
        level: exercise.level,
        gain_db: exercise.gain_db,
        freq_min: exercise.freq_min,
        freq_max: exercise.freq_max,
    })
}

pub fn eq_evaluate_impl(
    exercise_id: &str,
    guess_freq: f32,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, EqExercise>>,
) -> Result<eq::EqResult, String> {
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;
    Ok(eq::evaluate(&exercise, guess_freq, seconds_taken))
}

#[tauri::command]
pub fn eq_random(
    level: u8,
    freq_min: Option<f32>,
    freq_max: Option<f32>,
    state: tauri::State<AppState>,
) -> Result<EqRandomResponse, String> {
    eq_random_impl(level, freq_min, freq_max, &state.library_dir, &state.db, &state.cache_dir, &state.eq_exercises)
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
