//! Transient Trainer — port of backend/src/routes/transient.js.

use crate::buffer::AudioBuffer;
use crate::dsp::dynamics::{apply_compressor, DynamicsParams};
use crate::exercise::common::time_factor_45;
use crate::exercise::dynamics::{adapt_params_to_signal, EffectType};
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
    /// The actual compressor params the clip was (or will be) rendered
    /// against — starts as the static preset from `preset()`, then gets
    /// overwritten by `calibrate()` once a dry clip is available. Callers
    /// must read *this* for the answer-reveal display, not call `preset()`
    /// again — otherwise the reveal shows the static, pre-calibration
    /// numbers while the audio the student actually heard was rendered
    /// against the calibrated ones (this is exactly the mismatch that
    /// motivated storing it on the exercise instead of recomputing it).
    pub params: DynamicsParams,
}

fn base_params(answer: &str) -> DynamicsParams {
    if answer == "klar" {
        // Intentionally a near-no-op compressor (ratio≈1), matching the
        // legacy `{ threshold: -60, ratio: 1.0001, attack: 50, release: 250 }`.
        DynamicsParams { threshold_db: -60.0, ratio: 1.0001, attack_s: 0.05, release_s: 0.25, makeup_db: 0.0 }
    } else {
        let p = preset(answer);
        DynamicsParams { threshold_db: p.threshold_db, ratio: p.ratio, attack_s: p.attack_ms / 1000.0, release_s: 0.25, makeup_db: 0.0 }
    }
}

pub fn generate(level: u8, rng: &mut impl Rng) -> TransientExercise {
    let opts = level_options(level);
    let correct_answer = opts[rng.gen_range(0..opts.len())];
    TransientExercise { correct_answer, level: level.clamp(1, 3), params: base_params(correct_answer) }
}

/// Calibrate `exercise.params` to the clip's actual level (same
/// `adapt_params_to_signal` helper the Dynamics Trainer uses) — without it,
/// a static -20..-32dB threshold can sit entirely above a quiet library
/// track's peak, so the compressor never engages and all four "difficulty"
/// answers sound identical, making the exercise unwinnable depending on
/// which track gets picked. "klar" is left untouched — its near-no-op
/// ratio makes calibration a no-op anyway, and it's meant to stay a fixed
/// reference point.
pub fn calibrate(dry: &AudioBuffer, exercise: &mut TransientExercise) {
    if exercise.correct_answer != "klar" {
        exercise.params = adapt_params_to_signal(dry, &exercise.params, EffectType::Compressor);
    }
}

pub fn render(dry: &AudioBuffer, exercise: &TransientExercise) -> AudioBuffer {
    let mut wet = dry.clone();
    apply_compressor(&mut wet, &exercise.params);
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

#[cfg(test)]
mod tests {
    use super::*;

    pub fn tone_buffer(sample_rate: u32, seconds: f32, amp: f32) -> AudioBuffer {
        let n = (sample_rate as f32 * seconds) as usize;
        let mut b = AudioBuffer::new(sample_rate, 2, n);
        for ch in b.channels.iter_mut() {
            for (i, s) in ch.iter_mut().enumerate() {
                *s = amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sample_rate as f32).sin();
            }
        }
        b
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn render_actually_engages_the_compressor_on_a_very_quiet_clip() {
        // Regression: a static -20..-32dB threshold sits entirely above a
        // very quiet clip's level, so the compressor never engages and
        // "mittel gedämpft" would render (near-)identical to "klar" — the
        // exercise becomes unwinnable for quiet library tracks. With
        // signal-adaptive calibration the clip's energy must be measurably
        // reduced. (RMS, not instantaneous peak: a fast 3ms attack on a
        // continuous tone can't fully track every individual sample peak of
        // a high-frequency test signal — that's an artifact of this test's
        // tone, not of real program material — so RMS is the metric that
        // actually reflects whether the compressor engaged.)
        let quiet = tone_buffer(48000, 1.0, 0.01); // ~ -43 dBFS RMS
        let mut ex = TransientExercise { correct_answer: "mittel gedämpft", level: 3, params: base_params("mittel gedämpft") };
        calibrate(&quiet, &mut ex);
        let wet = render(&quiet, &ex);
        let dry_rms = rms(&quiet.channels[0]);
        let wet_rms = rms(&wet.channels[0]);
        assert!(wet_rms < dry_rms * 0.8, "compressor should audibly reduce a quiet clip's energy, dry_rms={dry_rms} wet_rms={wet_rms}");
    }

    #[test]
    fn klar_stays_a_near_no_op_regardless_of_signal_level() {
        let quiet = tone_buffer(48000, 1.0, 0.01);
        let mut ex = TransientExercise { correct_answer: "klar", level: 1, params: base_params("klar") };
        calibrate(&quiet, &mut ex);
        let wet = render(&quiet, &ex);
        let dry_rms = rms(&quiet.channels[0]);
        let wet_rms = rms(&wet.channels[0]);
        assert!((wet_rms - dry_rms).abs() < dry_rms * 0.05, "klar should stay essentially unprocessed, dry_rms={dry_rms} wet_rms={wet_rms}");
    }
}
