//! Transient Trainer — port of backend/src/routes/transient.js.

use crate::buffer::AudioBuffer;
use crate::dsp::dynamics::{apply_compressor, DynamicsParams};
use crate::exercise::common::time_factor_45;
use rand::Rng;
use serde::Serialize;

pub struct TransientPreset {
    pub attack_ms: f32,
    pub ratio: f32,
    pub threshold_db: f32,
}

pub fn preset(answer: &str) -> TransientPreset {
    match answer {
        "klar" => TransientPreset { attack_ms: 50.0, ratio: 2.0, threshold_db: -20.0 },
        "leicht gedämpft" => TransientPreset { attack_ms: 10.0, ratio: 4.0, threshold_db: -24.0 },
        "mittel gedämpft" => TransientPreset { attack_ms: 3.0, ratio: 6.0, threshold_db: -28.0 },
        _ => TransientPreset { attack_ms: 0.5, ratio: 8.0, threshold_db: -32.0 }, // "stark gedämpft"
    }
}

pub fn level_options(level: u8) -> &'static [&'static str] {
    match level.clamp(1, 3) {
        1 => &["klar", "stark gedämpft"],
        2 => &["klar", "leicht gedämpft", "stark gedämpft"],
        _ => &["klar", "leicht gedämpft", "mittel gedämpft", "stark gedämpft"],
    }
}

pub fn explanation(answer: &str) -> &'static str {
    match answer {
        "klar" => "Attack 50ms — langsamer Attack lässt Transienten (Konsonanten) durch.",
        "leicht gedämpft" => "Attack 10ms — mittlerer Attack dämpft Transienten leicht.",
        "mittel gedämpft" => "Attack 3ms — schneller Attack schneidet Konsonanten merklich ab.",
        _ => "Attack 0.5ms — sehr schneller Attack, Transienten fast vollständig weg.",
    }
}

#[derive(Clone)]
pub struct TransientExercise {
    pub correct_answer: &'static str,
    pub level: u8,
}

pub fn generate(level: u8, rng: &mut impl Rng) -> TransientExercise {
    let opts = level_options(level);
    TransientExercise { correct_answer: opts[rng.gen_range(0..opts.len())], level: level.clamp(1, 3) }
}

/// "klar" is intentionally a near-no-op compressor (ratio≈1), matching the
/// legacy `{ threshold: -60, ratio: 1.0001, attack: 50, release: 250 }`.
pub fn render(dry: &AudioBuffer, exercise: &TransientExercise) -> AudioBuffer {
    let p = preset(exercise.correct_answer);
    let params = if exercise.correct_answer == "klar" {
        DynamicsParams { threshold_db: -60.0, ratio: 1.0001, attack_s: 0.05, release_s: 0.25, makeup_db: 0.0 }
    } else {
        DynamicsParams { threshold_db: p.threshold_db, ratio: p.ratio, attack_s: p.attack_ms / 1000.0, release_s: 0.25, makeup_db: 0.0 }
    };
    let mut wet = dry.clone();
    apply_compressor(&mut wet, &params);
    wet
}

#[derive(Serialize)]
pub struct TransientResult {
    pub correct: bool,
    pub points: u32,
}

pub fn evaluate(exercise: &TransientExercise, answer: &str, seconds_taken: f32) -> TransientResult {
    let correct = answer == exercise.correct_answer;
    let points = ((if correct { 1000.0 } else { 0.0 }) * time_factor_45(seconds_taken)).round() as u32;
    TransientResult { correct, points }
}
