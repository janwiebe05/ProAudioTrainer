//! Score history & progress — scoped to the active local profile (no
//! multi-user leaderboard; the legacy web app's global highscores concept
//! doesn't apply to a local install with one or more private profiles).
//! See paw_core::store.

use crate::state::{current_profile_id, now_iso, AppState};
use paw_core::store::{ModuleProgress, ProgressSummary, ScoreEntry};

#[tauri::command]
pub fn scores_submit(
    module: String,
    score: i64,
    rounds: i64,
    level: i64,
    streak: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let profile_id = current_profile_id(&state.db)?;
    let entry = ScoreEntry {
        id: uuid::Uuid::new_v4().to_string(),
        module, score, rounds, level, streak,
        created_at: now_iso(),
    };
    state.db.add_score(&profile_id, &entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scores_top(module: String, limit: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<ScoreEntry>, String> {
    let profile_id = current_profile_id(&state.db)?;
    state.db.top_scores(&profile_id, &module, limit.unwrap_or(10)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_overview(state: tauri::State<AppState>) -> Result<Vec<ModuleProgress>, String> {
    let profile_id = current_profile_id(&state.db)?;
    state.db.progress_overview(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_summary(state: tauri::State<AppState>) -> Result<ProgressSummary, String> {
    let profile_id = current_profile_id(&state.db)?;
    state.db.summary(&profile_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scores_recent(limit: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<ScoreEntry>, String> {
    let profile_id = current_profile_id(&state.db)?;
    state.db.recent_scores(&profile_id, limit.unwrap_or(20)).map_err(|e| e.to_string())
}
