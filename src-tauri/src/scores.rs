//! Score history & progress — local-only (no multi-user leaderboard; the
//! legacy web app's global highscores concept doesn't apply to a
//! single-profile desktop install). See paw_core::store.

use crate::state::AppState;
use paw_core::store::{ModuleProgress, ProgressSummary, ScoreEntry};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

#[tauri::command]
pub fn scores_submit(
    module: String,
    score: i64,
    rounds: i64,
    level: i64,
    streak: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let entry = ScoreEntry {
        id: uuid::Uuid::new_v4().to_string(),
        module, score, rounds, level, streak,
        created_at: now_iso(),
    };
    state.db.add_score(&entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scores_top(module: String, limit: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<ScoreEntry>, String> {
    state.db.top_scores(&module, limit.unwrap_or(10)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_overview(state: tauri::State<AppState>) -> Result<Vec<ModuleProgress>, String> {
    state.db.progress_overview().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_summary(state: tauri::State<AppState>) -> Result<ProgressSummary, String> {
    state.db.summary().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scores_recent(limit: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<ScoreEntry>, String> {
    state.db.recent_scores(limit.unwrap_or(20)).map_err(|e| e.to_string())
}
