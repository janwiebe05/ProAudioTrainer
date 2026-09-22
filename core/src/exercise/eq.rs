//! EQ Trainer — port of backend/src/routes/eq.js.

use crate::buffer::AudioBuffer;
use crate::dsp::eq::apply_peaking_eq;
use crate::exercise::common::time_factor_10;
use rand::Rng;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy)]
pub struct LevelConfig {
    pub gain_db: f32,
    pub freq_min: f32,
    pub freq_max: f32,
    pub tolerance_octaves: f32,
}

pub fn level_config(level: u8) -> LevelConfig {
    match level.clamp(1, 3) {
        1 => LevelConfig { gain_db: 12.0, freq_min: 200.0, freq_max: 8000.0, tolerance_octaves: 1.0 },
        2 => LevelConfig { gain_db: 9.0, freq_min: 100.0, freq_max: 12000.0, tolerance_octaves: 0.5 },
        _ => LevelConfig { gain_db: 6.0, freq_min: 40.0, freq_max: 18000.0, tolerance_octaves: 0.25 },
    }
}

/// Log-uniform random frequency, quantized to the nearest semitone
/// (matches the old client's `getRandomTargetFreq`).
pub fn random_frequency(freq_min: f32, freq_max: f32, rng: &mut impl Rng) -> f32 {
    let log_min = freq_min.log2();
    let log_max = freq_max.log2();
    let log_freq = log_min + rng.gen::<f32>() * (log_max - log_min);
    (2f32.powf((log_freq * 12.0).round() / 12.0)).round()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EqExercise {
    pub freq: f32,
    pub gain_db: f32,
    pub level: u8,
    pub freq_min: f32,
    pub freq_max: f32,
}

pub fn generate(level: u8, freq_min: Option<f32>, freq_max: Option<f32>, rng: &mut impl Rng) -> EqExercise {
    let cfg = level_config(level);
    // Guard against bad input (e.g. a corrupted localStorage value on the
    // client): freq_min<=0 sends log2() to -inf, and freq_min>=freq_max
    // makes the log-uniform range empty — both used to produce a NaN
    // target frequency that silently corrupted the rendered EQ instead of
    // failing. Fall back to the level's own default range in either case.
    let (freq_min, freq_max) = match (freq_min, freq_max) {
        (Some(lo), Some(hi)) if lo > 0.0 && hi > lo => (lo, hi),
        _ => (cfg.freq_min, cfg.freq_max),
    };
    EqExercise {
        freq: random_frequency(freq_min, freq_max, rng),
        gain_db: cfg.gain_db,
        level: level.clamp(1, 3),
        freq_min,
        freq_max,
    }
}

/// -2.5dB output compensation, matching the legacy client-side AudioEngine's
/// fixed `gainCompensation` gain node — without it, a +6..+12dB peaking
/// boost makes the "EQ on" clip audibly louder than the dry clip, letting a
/// student identify the EQ state by loudness alone instead of by the actual
/// frequency-content change the exercise is meant to test.
const OUTPUT_COMPENSATION_DB: f32 = -2.5;

/// Render dry+processed clip pair. Q=4 matches the prior BiquadFilterNode Q.
pub fn render(dry: &AudioBuffer, exercise: &EqExercise) -> AudioBuffer {
    let mut wet = dry.clone();
    apply_peaking_eq(&mut wet, exercise.freq, exercise.gain_db, 4.0);
    wet.apply_gain(10f32.powf(OUTPUT_COMPENSATION_DB / 20.0));
    wet
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqResult {
    pub hit: bool,
    pub correct_freq: f32,
    pub guess_freq: f32,
    pub octave_dist: f32,
    pub points: u32,
    pub tolerance_octaves: f32,
}

pub fn evaluate(exercise: &EqExercise, guess_freq: f32, seconds_taken: f32) -> EqResult {
    let tolerance = level_config(exercise.level).tolerance_octaves;
    let octave_dist = (guess_freq / exercise.freq).log2().abs();
    let hit = octave_dist <= tolerance;
    let time_factor = time_factor_10(seconds_taken);
    let precision = if hit { 1.0 - octave_dist / tolerance } else { 0.0 };
    let points = if hit { (1000.0 * time_factor * precision).round().max(0.0) as u32 } else { 0 };

    EqResult {
        hit,
        correct_freq: exercise.freq,
        guess_freq,
        octave_dist,
        points,
        tolerance_octaves: tolerance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn invalid_freq_range_falls_back_to_level_default_instead_of_nan() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(1);
        for (bad_min, bad_max) in [(0.0, 8000.0), (-100.0, 8000.0), (5000.0, 100.0), (1000.0, 1000.0)] {
            let ex = generate(2, Some(bad_min), Some(bad_max), &mut rng);
            assert!(ex.freq.is_finite(), "freq should never be NaN/inf for bad input ({bad_min}, {bad_max})");
            assert!(ex.freq > 0.0);
        }
    }

    #[test]
    fn render_applies_the_fixed_output_compensation_to_the_filtered_signal() {
        // Regression: the legacy client's AudioEngine chained a fixed
        // -2.5dB gainCompensation node after the EQ filter specifically so
        // a +6..+12dB peaking boost wouldn't make the "EQ on" clip audibly
        // louder than "bypass" — letting a student spot the EQ state by
        // loudness alone instead of by the actual frequency-content change
        // the exercise is meant to test. The Rust port dropped this
        // silently, so verify render()'s output is exactly the raw
        // apply_peaking_eq() result scaled by 10^(-2.5/20) — not equal to
        // the uncompensated filter output.
        let mut dry = AudioBuffer::new(48000, 1, 4800);
        for (i, s) in dry.channels[0].iter_mut().enumerate() {
            *s = 0.2 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48000.0).sin();
        }
        let ex = EqExercise { freq: 1000.0, gain_db: 12.0, level: 1, freq_min: 200.0, freq_max: 8000.0 };

        let mut uncompensated = dry.clone();
        crate::dsp::eq::apply_peaking_eq(&mut uncompensated, ex.freq, ex.gain_db, 4.0);
        let expected_gain = 10f32.powf(-2.5 / 20.0);

        let wet = render(&dry, &ex);
        for (w, u) in wet.channels[0].iter().zip(uncompensated.channels[0].iter()) {
            assert!((w - u * expected_gain).abs() < 1e-5, "wet sample should equal the uncompensated filter output scaled by -2.5dB: wet={w} expected={}", u * expected_gain);
        }
        // And, redundantly, that render() is NOT just the raw filter output.
        assert!((wet.peak() - uncompensated.peak()).abs() > 1e-4, "render() must apply output compensation, not just the raw peaking filter");
    }

    #[test]
    fn random_frequency_stays_within_bounds_and_on_semitone_grid() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(42);
        for _ in 0..200 {
            let f = random_frequency(100.0, 12000.0, &mut rng);
            assert!(f >= 90.0 && f <= 12500.0, "freq {f} out of expected bounds");
        }
    }

    #[test]
    fn exact_guess_scores_max_points_at_zero_seconds() {
        let ex = EqExercise { freq: 1000.0, gain_db: 9.0, level: 2, freq_min: 100.0, freq_max: 12000.0 };
        let r = evaluate(&ex, 1000.0, 0.0);
        assert!(r.hit);
        assert_eq!(r.points, 1000);
    }

    #[test]
    fn guess_outside_tolerance_misses() {
        let ex = EqExercise { freq: 1000.0, gain_db: 9.0, level: 3, freq_min: 40.0, freq_max: 18000.0 };
        let r = evaluate(&ex, 4000.0, 2.0); // 2 octaves off, level 3 tolerance = 0.25
        assert!(!r.hit);
        assert_eq!(r.points, 0);
    }
}
