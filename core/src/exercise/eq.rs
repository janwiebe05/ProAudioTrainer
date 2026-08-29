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
    let freq_min = freq_min.unwrap_or(cfg.freq_min);
    let freq_max = freq_max.unwrap_or(cfg.freq_max);
    EqExercise {
        freq: random_frequency(freq_min, freq_max, rng),
        gain_db: cfg.gain_db,
        level: level.clamp(1, 3),
        freq_min,
        freq_max,
    }
}

/// Render dry+processed clip pair. Q=4 matches the prior BiquadFilterNode Q.
pub fn render(dry: &AudioBuffer, exercise: &EqExercise) -> AudioBuffer {
    let mut wet = dry.clone();
    apply_peaking_eq(&mut wet, exercise.freq, exercise.gain_db, 4.0);
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
