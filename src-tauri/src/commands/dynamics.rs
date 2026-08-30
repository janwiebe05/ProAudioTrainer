use crate::state::{load_random_clip, write_dry_wet, AppState};
use paw_core::store::Store;
use paw_core::exercise::dynamics::{self, DynamicsExercise, DynamicsGuess, EffectType, GuessMode};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

fn effect_to_str(e: EffectType) -> &'static str {
    match e {
        EffectType::Compressor => "compressor",
        EffectType::Limiter => "limiter",
        EffectType::Gate => "gate",
        EffectType::Expander => "expander",
    }
}

fn parse_effect(s: &str) -> Option<EffectType> {
    match s {
        "compressor" => Some(EffectType::Compressor),
        "limiter" => Some(EffectType::Limiter),
        "gate" => Some(EffectType::Gate),
        "expander" => Some(EffectType::Expander),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct DynamicsRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    effect: &'static str,
    #[serde(rename = "thresholdDb")]
    threshold_db: f32,
    ratio: f32,
    #[serde(rename = "attackMs")]
    attack_ms: f32,
    #[serde(rename = "releaseMs")]
    release_ms: f32,
    #[serde(rename = "makeupDb")]
    makeup_db: f32,
    #[serde(rename = "guessMode")]
    guess_mode: GuessMode,
    #[serde(rename = "amountIndex")]
    amount_index: Option<usize>,
    #[serde(rename = "amountLabels")]
    amount_labels: Vec<&'static str>,
    level: u8,
}

pub fn dynamics_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    db: &Store,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, DynamicsExercise>>,
) -> Result<DynamicsRandomResponse, String> {
    let mut rng = rand::thread_rng();
    let dry = load_random_clip(library_dir, db, &mut rng)?;

    let mut exercise = dynamics::generate(level, &mut rng);
    exercise.params = dynamics::adapt_params_to_signal(&dry, &exercise.params, exercise.effect);
    let wet = dynamics::render(&dry, &exercise);
    let (dry_path, processed_path) = write_dry_wet(cache_dir, &dry, &wet)?;

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let response = DynamicsRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path,
        processed_path,
        effect: effect_to_str(exercise.effect),
        threshold_db: exercise.params.threshold_db,
        ratio: exercise.params.ratio,
        attack_ms: exercise.params.attack_s * 1000.0,
        release_ms: exercise.params.release_s * 1000.0,
        makeup_db: exercise.params.makeup_db,
        guess_mode: exercise.guess_mode,
        amount_index: exercise.amount_index,
        amount_labels: dynamics::AMOUNT_LABELS.to_vec(),
        level: exercise.level,
    };
    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
pub fn dynamics_evaluate_impl(
    exercise_id: &str,
    guess_effect: Option<String>,
    guess_amount: Option<usize>,
    guess_threshold: Option<f32>,
    guess_ratio: Option<f32>,
    guess_attack_ms: Option<f32>,
    guess_release_ms: Option<f32>,
    guess_makeup_db: Option<f32>,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, DynamicsExercise>>,
) -> Result<dynamics::DynamicsResult, String> {
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;

    let guess = DynamicsGuess {
        effect: guess_effect.as_deref().and_then(parse_effect),
        amount: guess_amount,
        threshold: guess_threshold,
        ratio: guess_ratio,
        attack_ms: guess_attack_ms,
        release_ms: guess_release_ms,
        makeup_db: guess_makeup_db,
    };
    Ok(dynamics::evaluate(&exercise, &guess, seconds_taken))
}

#[tauri::command]
pub fn dynamics_random(level: u8, state: tauri::State<AppState>) -> Result<DynamicsRandomResponse, String> {
    dynamics_random_impl(level, &state.library_dir, &state.db, &state.cache_dir, &state.dynamics_exercises)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn dynamics_evaluate(
    exercise_id: String,
    guess_effect: Option<String>,
    guess_amount: Option<usize>,
    guess_threshold: Option<f32>,
    guess_ratio: Option<f32>,
    guess_attack_ms: Option<f32>,
    guess_release_ms: Option<f32>,
    guess_makeup_db: Option<f32>,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<dynamics::DynamicsResult, String> {
    dynamics_evaluate_impl(
        &exercise_id, guess_effect, guess_amount, guess_threshold, guess_ratio,
        guess_attack_ms, guess_release_ms, guess_makeup_db, seconds_taken,
        &state.dynamics_exercises,
    )
}
