use crate::state::{render_random_exercise, AppState};
use paw_core::store::Store;
use paw_core::exercise::stereo::{self, StereoExercise};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Serialize)]
pub struct StereoRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    level: u8,
    pub options: Vec<&'static str>,
    width: f32,
}

pub fn stereo_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    db: &Store,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, StereoExercise>>,
) -> Result<StereoRandomResponse, String> {
    let (exercise_id, dry_path, processed_path, exercise) = render_random_exercise(
        library_dir, db, cache_dir, exercises,
        |dry, rng| {
            let exercise = stereo::generate(level, rng);
            let wet = stereo::render(dry, &exercise);
            Ok((exercise, wet))
        },
    )?;

    Ok(StereoRandomResponse {
        exercise_id,
        dry_path,
        processed_path,
        level: exercise.level,
        options: stereo::level_options(exercise.level).iter().map(|(name, _)| *name).collect(),
        width: exercise.width_factor,
    })
}

#[derive(Serialize)]
pub struct StereoEvalResponse {
    correct: bool,
    points: u32,
    #[serde(rename = "correctAnswer")]
    correct_answer: &'static str,
    explanation: &'static str,
}

pub fn stereo_evaluate_impl(
    exercise_id: &str,
    answer: &str,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, StereoExercise>>,
) -> Result<StereoEvalResponse, String> {
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;
    let result = stereo::evaluate(&exercise, answer, seconds_taken);
    Ok(StereoEvalResponse {
        correct: result.correct,
        points: result.points,
        correct_answer: exercise.correct_answer,
        explanation: stereo::explanation(exercise.correct_answer),
    })
}

#[tauri::command]
pub fn stereo_random(level: u8, state: tauri::State<AppState>) -> Result<StereoRandomResponse, String> {
    stereo_random_impl(level, &state.library_dir, &state.db, &state.cache_dir, &state.stereo_exercises)
}

#[tauri::command]
pub fn stereo_evaluate(
    exercise_id: String,
    answer: String,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<StereoEvalResponse, String> {
    stereo_evaluate_impl(&exercise_id, &answer, seconds_taken, &state.stereo_exercises)
}
