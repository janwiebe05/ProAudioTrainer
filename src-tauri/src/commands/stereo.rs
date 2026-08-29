use crate::state::{load_random_clip, write_dry_wet, AppState};
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
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, StereoExercise>>,
) -> Result<StereoRandomResponse, String> {
    let mut rng = rand::thread_rng();
    let dry = load_random_clip(library_dir, &mut rng)?;

    let exercise = stereo::generate(level, &mut rng);
    let wet = stereo::render(&dry, &exercise);
    let (dry_path, processed_path) = write_dry_wet(cache_dir, &dry, &wet)?;

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let response = StereoRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path,
        processed_path,
        level: exercise.level,
        options: stereo::level_options(exercise.level).iter().map(|(name, _)| *name).collect(),
        width: exercise.width_factor,
    };
    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
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
    let exercise = exercises
        .lock()
        .unwrap()
        .remove(exercise_id)
        .ok_or_else(|| "Übung nicht gefunden oder abgelaufen".to_string())?;
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
    stereo_random_impl(level, &state.library_dir, &state.cache_dir, &state.stereo_exercises)
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
