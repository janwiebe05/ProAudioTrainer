mod commands;
mod library;
mod profile;
mod scores;
mod state;

#[cfg(test)]
mod tests;

use paw_core::store::Store;
use state::AppState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Where the bundled EchoThief impulse-response library lives.
/// Dev: resolved relative to this crate's own path (compile-time constant,
/// works regardless of cwd). Packaged: prefers the Tauri resource dir once
/// EchoThief is declared as a bundle resource (see tauri.conf.json) — falls
/// back to the dev path if that resource isn't present (e.g. `cargo run`
/// without a full `tauri build`).
fn resolve_content_dir(app: &tauri::AppHandle) -> PathBuf {
    // content_dir is the FRONTEND ROOT (not the EchoThief folder itself) —
    // exercise::reverb's ir_rel_path strings already start with
    // "/EchoThief/...", matching the legacy resolveIrPath() convention.
    if let Ok(resource_dir) = app.path().resource_dir() {
        if resource_dir.join("EchoThief").is_dir() {
            return resource_dir;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("frontend")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let library_dir = data_dir.join("library");
            let cache_dir = app.path().app_cache_dir()?.join("exercises");
            let content_dir = resolve_content_dir(app.handle());
            std::fs::create_dir_all(&library_dir)?;
            std::fs::create_dir_all(&cache_dir)?;
            // Rendered dry/wet exercise WAVs (render_random_exercise) are
            // never cleaned up individually — each round leaves its pair
            // behind once submitted or abandoned. The in-memory exercise
            // stores below always start empty on launch, so nothing in the
            // cache dir can still be referenced by a live round; sweep it
            // clean here rather than letting it grow unbounded across
            // sessions.
            if let Ok(entries) = std::fs::read_dir(&cache_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }

            let db = Store::open(&data_dir.join("data.db"))?;

            app.manage(AppState {
                library_dir,
                cache_dir,
                content_dir,
                db,
                eq_exercises: Mutex::new(HashMap::new()),
                dynamics_exercises: Mutex::new(HashMap::new()),
                panning_exercises: Mutex::new(HashMap::new()),
                stereo_exercises: Mutex::new(HashMap::new()),
                transient_exercises: Mutex::new(HashMap::new()),
                reverb_exercises: Mutex::new(HashMap::new()),
                eq_match_exercises: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::eq::eq_random,
            commands::eq::eq_evaluate,
            commands::dynamics::dynamics_random,
            commands::dynamics::dynamics_evaluate,
            commands::panning::panning_random,
            commands::panning::panning_evaluate,
            commands::stereo::stereo_random,
            commands::stereo::stereo_evaluate,
            commands::transient::transient_random,
            commands::transient::transient_evaluate,
            commands::reverb::reverb_random,
            commands::reverb::reverb_evaluate,
            commands::eq_match::eq_match_random,
            commands::eq_match::eq_match_evaluate,
            library::library_list,
            library::library_upload,
            library::library_import_shared_folder,
            library::library_toggle_active,
            library::library_delete,
            profile::profile_list,
            profile::profile_get_active,
            profile::profile_create,
            profile::profile_switch,
            profile::profile_delete,
            scores::scores_submit,
            scores::scores_top,
            scores::scores_recent,
            scores::progress_overview,
            scores::progress_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
