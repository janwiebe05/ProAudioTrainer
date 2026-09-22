use crate::state::{render_random_exercise, AppState};
use paw_core::store::Store;
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
    db: &Store,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, TransientExercise>>,
) -> Result<TransientRandomResponse, String> {
    let (exercise_id, dry_path, processed_path, exercise) = render_random_exercise(
        library_dir, db, cache_dir, exercises,
        |dry, rng| {
            let mut exercise = transient::generate(level, rng);
            transient::calibrate(dry, &mut exercise);
            let wet = transient::render(dry, &exercise);
            Ok((exercise, wet))
        },
    )?;

    Ok(TransientRandomResponse {
        exercise_id,
        dry_path,
        processed_path,
        level: exercise.level,
        options: transient::level_options(exercise.level).to_vec(),
        attack_ms: exercise.params.attack_s * 1000.0,
        ratio: exercise.params.ratio,
        threshold_db: exercise.params.threshold_db,
    })
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
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;
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
    transient_random_impl(level, &state.library_dir, &state.db, &state.cache_dir, &state.transient_exercises)
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
