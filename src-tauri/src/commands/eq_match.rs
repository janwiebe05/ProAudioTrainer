//! EQ Match — the one trainer that stays live client-side (see
//! paw_core::exercise::eq_match for why). No rendering happens here: we
//! just pick a random accessible+active track and hand back its own file
//! path directly, plus the generated hidden EQ curve.

use crate::state::{pick_track, take_exercise, AppState};
use paw_core::exercise::eq_match::{self, EqMatchExercise, EqMatchResult, UserBand};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

#[derive(Serialize)]
pub struct EqMatchRandomResponse {
    #[serde(rename = "exerciseId")]
    pub exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    pub level: u8,
    #[serde(rename = "hiddenBands")]
    pub hidden_bands: BTreeMap<u8, eq_match::HiddenBand>,
    #[serde(rename = "timeLimit")]
    pub time_limit: Option<u32>,
    #[serde(rename = "userControlsFreq")]
    pub user_controls_freq: bool,
    #[serde(rename = "userControlsQ")]
    pub user_controls_q: bool,
}

pub fn eq_match_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    db: &paw_core::store::Store,
    exercises: &Mutex<HashMap<String, EqMatchExercise>>,
) -> Result<EqMatchRandomResponse, String> {
    let mut rng = rand::thread_rng();
    // EQ Match hands the track's own file to the frontend to play, so make
    // sure the file is actually there (a linked one may have vanished).
    let mut skipped: Vec<String> = Vec::new();
    let dry_path = loop {
        let track = pick_track(db, &skipped, &mut rng)?;
        let path = track.resolve_path(library_dir);
        if path.is_file() || track.source_path.is_none() || skipped.len() >= 4 {
            break path.to_string_lossy().to_string();
        }
        skipped.push(track.id);
    };

    let exercise = eq_match::generate(level, &mut rng);
    let config = eq_match::level_config(exercise.level);

    let exercise_id = uuid::Uuid::new_v4().to_string();
    let response = EqMatchRandomResponse {
        exercise_id: exercise_id.clone(),
        dry_path,
        level: exercise.level,
        hidden_bands: exercise.hidden_bands.clone(),
        time_limit: config.time_limit,
        user_controls_freq: config.user_controls_freq,
        user_controls_q: config.user_controls_q,
    };
    exercises.lock().unwrap().insert(exercise_id, exercise);
    Ok(response)
}

pub fn eq_match_evaluate_impl(
    exercise_id: &str,
    user_bands: &BTreeMap<u8, UserBand>,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, EqMatchExercise>>,
) -> Result<EqMatchResult, String> {
    let exercise = take_exercise(exercises, exercise_id)?;
    Ok(eq_match::evaluate(&exercise, user_bands, seconds_taken))
}

#[tauri::command(async)]
pub fn eq_match_random(level: u8, state: tauri::State<AppState>) -> Result<EqMatchRandomResponse, String> {
    eq_match_random_impl(level, &state.library_dir, &state.db, &state.eq_match_exercises)
}

#[tauri::command]
pub fn eq_match_evaluate(
    exercise_id: String,
    user_bands: BTreeMap<u8, UserBand>,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<EqMatchResult, String> {
    eq_match_evaluate_impl(&exercise_id, &user_bands, seconds_taken, &state.eq_match_exercises)
}
