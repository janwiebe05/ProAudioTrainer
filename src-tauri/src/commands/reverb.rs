use crate::state::{render_random_exercise, AppState};
use paw_core::store::Store;
use paw_core::decode;
use paw_core::exercise::reverb::{self, category_label, ReverbExercise};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

fn resolve_ir_path(content_dir: &std::path::Path, ir_rel_path: &str) -> std::path::PathBuf {
    content_dir.join(ir_rel_path.trim_start_matches('/'))
}

#[derive(Serialize)]
struct CategoryDto {
    id: &'static str,
    label: &'static str,
}

#[derive(Serialize)]
pub struct ReverbRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    #[serde(rename = "wetMix")]
    pub wet_mix: f32,
    #[serde(rename = "availableCategories")]
    available_categories: Vec<CategoryDto>,
}

pub fn reverb_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    db: &Store,
    content_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, ReverbExercise>>,
) -> Result<ReverbRandomResponse, String> {
    let (exercise_id, dry_path, processed_path, exercise) = render_random_exercise(
        library_dir, db, cache_dir, exercises,
        |dry, rng| {
            let exercise = reverb::generate(level, rng);
            let ir_path = resolve_ir_path(content_dir, exercise.ir_rel_path);
            let ir = decode::decode_full(&ir_path)
                .map_err(|e| format!("Impulsantwort konnte nicht geladen werden ({}): {e}", ir_path.display()))?;
            let wet = reverb::render(dry, &ir, exercise.wet_mix);
            Ok((exercise, wet))
        },
    )?;

    let categories = reverb::level_categories(exercise.level);
    Ok(ReverbRandomResponse {
        exercise_id,
        dry_path,
        processed_path,
        wet_mix: exercise.wet_mix,
        available_categories: categories
            .iter()
            .map(|c| CategoryDto { id: c, label: category_label(c) })
            .collect(),
    })
}

#[derive(Serialize)]
pub struct ReverbEvalResponse {
    correct: bool,
    score: u32,
    category: &'static str,
    #[serde(rename = "categoryLabel")]
    category_label: &'static str,
}

pub fn reverb_evaluate_impl(
    exercise_id: &str,
    guess_category: &str,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, ReverbExercise>>,
) -> Result<ReverbEvalResponse, String> {
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;
    let result = reverb::evaluate(&exercise, guess_category, seconds_taken);
    Ok(ReverbEvalResponse {
        correct: result.correct,
        score: result.score,
        category: exercise.category,
        category_label: category_label(exercise.category),
    })
}


#[tauri::command(async)]
pub fn reverb_random(level: u8, state: tauri::State<AppState>) -> Result<ReverbRandomResponse, String> {
    reverb_random_impl(level, &state.library_dir, &state.db, &state.content_dir, &state.cache_dir, &state.reverb_exercises)
}

#[tauri::command]
pub fn reverb_evaluate(
    exercise_id: String,
    guess_category: String,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<ReverbEvalResponse, String> {
    reverb_evaluate_impl(&exercise_id, &guess_category, seconds_taken, &state.reverb_exercises)
}
