use crate::state::{load_random_clip, write_dry_wet, AppState};
use paw_core::exercise::transient::{self, TransientExercise};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Serialize)]
pub struct TransientRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    level: u8,
    pub options: Vec<&'static str>,
    #[serde(rename = "attackMs")]
    attack_ms: f32,
    ratio: f32,
    #[serde(rename = "thresholdDb")]
    threshold_db: f32,
}

pub fn transient_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, TransientExercise>>,
) -> Result<TransientRandomResponse, String> {
    let mut rng = rand::thread_rng();
    let dry = load_random_clip(library_dir, &mut rng)?;

    let exercise = transient::generate(level, &mut rng);
    let wet = transient::render(&dry, &exercise);
    let (dry_path, processed_path) = write_dry_wet(cache_dir, &dry, &wet)?;
    let preset = transient::preset(exercise.correct_answer);

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let response = TransientRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path,
        processed_path,
        level: exercise.level,
        options: transient::level_options(exercise.level).to_vec(),
        attack_ms: preset.attack_ms,
        ratio: preset.ratio,
        threshold_db: preset.threshold_db,
    };
    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
}

#[derive(Serialize)]
pub struct TransientEvalResponse {
    correct: bool,
    points: u32,
    #[serde(rename = "correctAnswer")]
    correct_answer: &'static str,
    explanation: &'static str,
}

pub fn transient_evaluate_impl(
    exercise_id: &str,
    answer: &str,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, TransientExercise>>,
) -> Result<TransientEvalResponse, String> {
    let exercise = exercises
        .lock()
        .unwrap()
        .remove(exercise_id)
        .ok_or_else(|| "Übung nicht gefunden oder abgelaufen".to_string())?;
    let result = transient::evaluate(&exercise, answer, seconds_taken);
    Ok(TransientEvalResponse {
        correct: result.correct,
        points: result.points,
        correct_answer: exercise.correct_answer,
        explanation: transient::explanation(exercise.correct_answer),
    })
}

#[tauri::command]
pub fn transient_random(level: u8, state: tauri::State<AppState>) -> Result<TransientRandomResponse, String> {
    transient_random_impl(level, &state.library_dir, &state.cache_dir, &state.transient_exercises)
}

#[tauri::command]
pub fn transient_evaluate(
    exercise_id: String,
    answer: String,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<TransientEvalResponse, String> {
    transient_evaluate_impl(&exercise_id, &answer, seconds_taken, &state.transient_exercises)
}
