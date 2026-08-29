//! Shared app state and the one bit of decode/pick logic every exercise
//! command needs: grab a random library track and decode a clip from it.

use paw_core::exercise::common::CLIP_DURATION_SECS;
use paw_core::exercise::{dynamics, eq, panning, reverb, stereo, transient};
use paw_core::{decode, AudioBuffer};
use rand::Rng;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg_attr(test, allow(dead_code))]
pub struct AppState {
    pub library_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Bundled read-only content (currently: EchoThief impulse responses).
    /// Resolved relative to the frontend dist dir in dev, and to the Tauri
    /// resource dir once packaged (see lib.rs setup()).
    pub content_dir: PathBuf,
    pub eq_exercises: Mutex<HashMap<String, eq::EqExercise>>,
    pub dynamics_exercises: Mutex<HashMap<String, dynamics::DynamicsExercise>>,
    pub panning_exercises: Mutex<HashMap<String, panning::PanningExercise>>,
    pub stereo_exercises: Mutex<HashMap<String, stereo::StereoExercise>>,
    pub transient_exercises: Mutex<HashMap<String, transient::TransientExercise>>,
    pub reverb_exercises: Mutex<HashMap<String, reverb::ReverbExercise>>,
}

pub fn pick_start_time(duration_secs: f64, rng: &mut impl Rng) -> f64 {
    let range = (duration_secs - CLIP_DURATION_SECS).max(0.0);
    rng.gen::<f64>() * range
}

/// Pick a random track from `library_dir` and decode one CLIP_DURATION_SECS
/// window from a random position in it.
pub fn load_random_clip(library_dir: &Path, rng: &mut impl Rng) -> Result<AudioBuffer, String> {
    let track_path = crate::library::pick_random_track(library_dir, rng)
        .ok_or_else(|| "Keine Audiodateien in der Bibliothek gefunden.".to_string())?;
    let duration = decode::probe_duration_secs(&track_path).map_err(|e| e.to_string())?;
    let start = pick_start_time(duration, rng);
    decode::decode_clip(&track_path, start, CLIP_DURATION_SECS).map_err(|e| e.to_string())
}

/// Write dry+wet buffers to the cache dir as WAV, return their paths.
pub fn write_dry_wet(
    cache_dir: &Path,
    dry: &AudioBuffer,
    wet: &AudioBuffer,
) -> Result<(String, String), String> {
    use paw_core::encode::encode_wav_i16;
    let dry_bytes = encode_wav_i16(dry).map_err(|e| e.to_string())?;
    let wet_bytes = encode_wav_i16(wet).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let dry_path = cache_dir.join(format!("{}-dry.wav", uuid::Uuid::new_v4()));
    let wet_path = cache_dir.join(format!("{}-wet.wav", uuid::Uuid::new_v4()));
    std::fs::write(&dry_path, dry_bytes).map_err(|e| e.to_string())?;
    std::fs::write(&wet_path, wet_bytes).map_err(|e| e.to_string())?;
    Ok((dry_path.to_string_lossy().to_string(), wet_path.to_string_lossy().to_string()))
}
