use crate::state::{render_random_exercise, AppState};
use paw_core::store::Store;
use paw_core::exercise::panning::{self, PanZone, PanningExercise, WidthStep, PAN_ZONES, WIDTH_STEPS};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Serialize)]
pub struct PanningRandomResponse {
    #[serde(rename = "exerciseId")]
    exercise_id: String,
    #[serde(rename = "dryPath")]
    pub dry_path: String,
    #[serde(rename = "processedPath")]
    pub processed_path: String,
    #[serde(rename = "guessMode")]
    guess_mode: &'static str, // "zone" | "value" | "width"
    #[serde(rename = "zoneId")]
    zone_id: Option<&'static str>,
    #[serde(rename = "panValue")]
    pan_value: Option<f32>,
    #[serde(rename = "widthId")]
    width_id: Option<&'static str>,
    width: Option<f32>,
    #[serde(rename = "panZones")]
    pan_zones: &'static [PanZone],
    #[serde(rename = "widthSteps")]
    width_steps: &'static [WidthStep],
}

pub fn panning_random_impl(
    level: u8,
    library_dir: &std::path::Path,
    db: &Store,
    cache_dir: &std::path::Path,
    exercises: &Mutex<HashMap<String, PanningExercise>>,
) -> Result<PanningRandomResponse, String> {
    let (exercise_id, dry_path, processed_path, exercise) = render_random_exercise(
        library_dir, db, cache_dir, exercises,
        |dry, rng| {
            let exercise = panning::generate(level, rng);
            let wet = panning::render(dry, &exercise);
            Ok((exercise, wet))
        },
    )?;

    let (guess_mode, zone_id, pan_value, width_id, width) = match &exercise {
        PanningExercise::Zone { zone_idx } => ("zone", Some(PAN_ZONES[*zone_idx].id), Some(PAN_ZONES[*zone_idx].value), None, None),
        PanningExercise::Value { pan_value } => ("value", None, Some(*pan_value), None, None),
        PanningExercise::Width { step_idx } => ("width", None, None, Some(WIDTH_STEPS[*step_idx].id), Some(WIDTH_STEPS[*step_idx].value)),
    };

    Ok(PanningRandomResponse {
        exercise_id,
        dry_path,
        processed_path,
        guess_mode,
        zone_id,
        pan_value,
        width_id,
        width,
        pan_zones: &PAN_ZONES,
        width_steps: &WIDTH_STEPS,
    })
}

pub fn panning_evaluate_impl(
    exercise_id: &str,
    guess_zone: Option<String>,
    guess_pan: Option<f32>,
    guess_width: Option<String>,
    seconds_taken: f32,
    exercises: &Mutex<HashMap<String, PanningExercise>>,
) -> Result<panning::PanningResult, String> {
    let exercise = crate::state::take_exercise(exercises, exercise_id)?;

    match exercise {
        PanningExercise::Zone { zone_idx } => {
            let guess = guess_zone.ok_or("guessZone fehlt")?;
            Ok(panning::evaluate_zone(zone_idx, &guess, seconds_taken))
        }
        PanningExercise::Value { pan_value } => {
            let guess = guess_pan.ok_or("guessPan fehlt")?;
            Ok(panning::evaluate_value(pan_value, guess, seconds_taken))
        }
        PanningExercise::Width { step_idx } => {
            let guess = guess_width.ok_or("guessWidth fehlt")?;
            Ok(panning::evaluate_width(step_idx, &guess, seconds_taken))
        }
    }
}

#[tauri::command(async)]
pub fn panning_random(level: u8, state: tauri::State<AppState>) -> Result<PanningRandomResponse, String> {
    panning_random_impl(level, &state.library_dir, &state.db, &state.cache_dir, &state.panning_exercises)
}

#[tauri::command]
pub fn panning_evaluate(
    exercise_id: String,
    guess_zone: Option<String>,
    guess_pan: Option<f32>,
    guess_width: Option<String>,
    seconds_taken: f32,
    state: tauri::State<AppState>,
) -> Result<panning::PanningResult, String> {
    panning_evaluate_impl(&exercise_id, guess_zone, guess_pan, guess_width, seconds_taken, &state.panning_exercises)
}
