//! Dynamics Trainer — port of backend/src/routes/dynamics.js (all preset
//! tables carried over verbatim from the legacy JS source).

use crate::buffer::AudioBuffer;
use crate::dsp::dynamics::{apply_compressor, apply_expander, apply_gate, apply_limiter, DynamicsParams};
use crate::exercise::common::time_factor_45;
use rand::Rng;
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub enum EffectType {
    Compressor,
    Limiter,
    Gate,
    Expander,
}

impl EffectType {
    fn all() -> [EffectType; 4] {
        [EffectType::Compressor, EffectType::Limiter, EffectType::Gate, EffectType::Expander]
    }
}

struct Range {
    threshold: (f32, f32),
    ratio: (f32, f32),
    attack: (f32, f32),
    release: (f32, f32),
    makeup: (f32, f32),
}

fn presets_l1(effect: EffectType) -> Range {
    match effect {
        EffectType::Compressor => Range { threshold: (-45.0, -28.0), ratio: (5.0, 8.0), attack: (5.0, 20.0), release: (80.0, 200.0), makeup: (6.0, 14.0) },
        EffectType::Limiter => Range { threshold: (-6.0, -1.0), ratio: (18.0, 20.0), attack: (0.1, 1.0), release: (50.0, 150.0), makeup: (0.0, 4.0) },
        EffectType::Gate => Range { threshold: (-45.0, -25.0), ratio: (16.0, 20.0), attack: (1.0, 5.0), release: (150.0, 350.0), makeup: (0.0, 4.0) },
        EffectType::Expander => Range { threshold: (-38.0, -20.0), ratio: (3.0, 6.0), attack: (10.0, 40.0), release: (100.0, 280.0), makeup: (2.0, 8.0) },
    }
}

fn presets_l3(effect: EffectType) -> Range {
    match effect {
        EffectType::Compressor => Range { threshold: (-30.0, -10.0), ratio: (2.0, 5.0), attack: (3.0, 80.0), release: (50.0, 400.0), makeup: (1.0, 8.0) },
        EffectType::Limiter => Range { threshold: (-14.0, -1.0), ratio: (12.0, 20.0), attack: (0.1, 3.0), release: (30.0, 250.0), makeup: (0.0, 8.0) },
        EffectType::Gate => Range { threshold: (-60.0, -15.0), ratio: (10.0, 20.0), attack: (1.0, 15.0), release: (80.0, 500.0), makeup: (0.0, 8.0) },
        EffectType::Expander => Range { threshold: (-50.0, -10.0), ratio: (2.0, 5.0), attack: (5.0, 90.0), release: (60.0, 500.0), makeup: (0.0, 10.0) },
    }
}

pub const AMOUNT_LABELS: [&str; 4] = ["leicht", "mittel", "stark", "sehr stark"];

fn amount_presets(effect: EffectType, idx: usize) -> DynamicsParams {
    let table: [(f32, f32, f32, f32, f32); 4] = match effect {
        EffectType::Compressor => [
            (-15.0, 2.0, 30.0, 250.0, 1.0),
            (-24.0, 4.0, 15.0, 150.0, 4.0),
            (-32.0, 6.0, 8.0, 100.0, 8.0),
            (-42.0, 8.0, 4.0, 80.0, 12.0),
        ],
        EffectType::Limiter => [
            (-3.0, 20.0, 1.0, 100.0, 1.0),
            (-6.0, 20.0, 0.5, 80.0, 2.0),
            (-9.0, 20.0, 0.2, 60.0, 4.0),
            (-12.0, 20.0, 0.1, 50.0, 6.0),
        ],
        EffectType::Gate => [
            (-50.0, 10.0, 5.0, 300.0, 0.0),
            (-38.0, 15.0, 3.0, 200.0, 0.0),
            (-28.0, 18.0, 2.0, 120.0, 0.0),
            (-18.0, 20.0, 1.0, 80.0, 0.0),
        ],
        EffectType::Expander => [
            (-18.0, 1.5, 50.0, 350.0, 1.0),
            (-28.0, 2.0, 30.0, 220.0, 3.0),
            (-38.0, 2.5, 15.0, 150.0, 5.0),
            (-46.0, 3.0, 8.0, 100.0, 8.0),
        ],
    };
    let (threshold_db, ratio, attack_ms, release_ms, makeup_db) = table[idx];
    DynamicsParams { threshold_db, ratio, attack_s: attack_ms / 1000.0, release_s: release_ms / 1000.0, makeup_db }
}

fn rand_range(r: (f32, f32), rng: &mut impl Rng) -> f32 {
    rng.gen_range(r.0..=r.1)
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuessMode {
    TypeOnly,
    TypeAmount,
    TypeParams,
}

#[derive(Clone)]
pub struct DynamicsExercise {
    pub effect: EffectType,
    pub params: DynamicsParams,
    pub amount_index: Option<usize>,
    pub guess_mode: GuessMode,
    pub level: u8,
}

pub fn generate(level: u8, rng: &mut impl Rng) -> DynamicsExercise {
    let level = level.clamp(1, 3);
    let effects = EffectType::all();
    let effect = effects[rng.gen_range(0..effects.len())];

    let (params, guess_mode, amount_index) = match level {
        1 => {
            let r = presets_l1(effect);
            (
                DynamicsParams {
                    threshold_db: rand_range(r.threshold, rng),
                    ratio: rand_range(r.ratio, rng),
                    attack_s: rand_range(r.attack, rng) / 1000.0,
                    release_s: rand_range(r.release, rng) / 1000.0,
                    makeup_db: rand_range(r.makeup, rng),
                },
                GuessMode::TypeOnly,
                None,
            )
        }
        2 => {
            let idx = rng.gen_range(0..4);
            (amount_presets(effect, idx), GuessMode::TypeAmount, Some(idx))
        }
        _ => {
            let r = presets_l3(effect);
            (
                DynamicsParams {
                    threshold_db: rand_range(r.threshold, rng),
                    ratio: rand_range(r.ratio, rng),
                    attack_s: rand_range(r.attack, rng) / 1000.0,
                    release_s: rand_range(r.release, rng) / 1000.0,
                    makeup_db: rand_range(r.makeup, rng),
                },
                GuessMode::TypeParams,
                None,
            )
        }
    };

    DynamicsExercise { effect, params, amount_index, guess_mode, level }
}

pub fn render(dry: &AudioBuffer, exercise: &DynamicsExercise) -> AudioBuffer {
    let mut wet = dry.clone();
    match exercise.effect {
        EffectType::Compressor => apply_compressor(&mut wet, &exercise.params),
        EffectType::Limiter => apply_limiter(&mut wet, &exercise.params),
        EffectType::Gate => apply_gate(&mut wet, &exercise.params),
        EffectType::Expander => apply_expander(&mut wet, &exercise.params),
    }
    wet
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsResult {
    pub score: u32,
    pub type_correct: bool,
}

pub struct DynamicsGuess {
    pub effect: Option<EffectType>,
    pub amount: Option<usize>,
    pub threshold: Option<f32>,
    pub ratio: Option<f32>,
    pub attack_ms: Option<f32>,
    pub release_ms: Option<f32>,
    pub makeup_db: Option<f32>,
}

pub fn evaluate(exercise: &DynamicsExercise, guess: &DynamicsGuess, seconds_taken: f32) -> DynamicsResult {
    let type_correct = guess.effect == Some(exercise.effect);
    let time_factor = time_factor_45(seconds_taken);

    let score = match exercise.guess_mode {
        GuessMode::TypeOnly => ((if type_correct { 1000.0 } else { 0.0 }) * time_factor).round() as u32,
        GuessMode::TypeAmount => {
            // Option, not a usize::MAX sentinel: casting MAX down to i32
            // wraps around to -1, which used to make a missing guess score
            // as a false "neighbor" hit against amount_index 0.
            let amount_idx = exercise.amount_index.unwrap_or(0) as i32;
            let amount_score = match guess.amount {
                Some(guess_amount) => {
                    let diff = (amount_idx - guess_amount as i32).abs();
                    if diff == 0 { 600.0 } else if diff == 1 { 300.0 } else { 0.0 }
                }
                None => 0.0,
            };
            (((if type_correct { 400.0 } else { 0.0 }) + amount_score) * time_factor).round() as u32
        }
        GuessMode::TypeParams => {
            let r = presets_l3(exercise.effect);
            let params = exercise.params;
            let mut total_acc = 0.0f32;
            let mut count = 0;
            let mut acc_of = |guess: Option<f32>, correct: f32, range: (f32, f32)| {
                if let Some(g) = guess {
                    let span = (range.1 - range.0).max(1.0) * 0.5;
                    total_acc += (1.0 - (g - correct).abs() / span).max(0.0);
                    count += 1;
                }
            };
            // gate/expander don't evaluate makeupGain (matches legacy EFFECT_EVAL_PARAMS)
            acc_of(guess.threshold, params.threshold_db, r.threshold);
            match exercise.effect {
                EffectType::Limiter => {} // no ratio evaluated for limiter, matches legacy
                _ => acc_of(guess.ratio, params.ratio, r.ratio),
            }
            acc_of(guess.attack_ms, params.attack_s * 1000.0, r.attack);
            acc_of(guess.release_ms, params.release_s * 1000.0, r.release);
            if matches!(exercise.effect, EffectType::Compressor | EffectType::Limiter) {
                acc_of(guess.makeup_db, params.makeup_db, r.makeup);
            }
            let avg_acc = if count > 0 { total_acc / count as f32 } else { 0.0 };
            (((if type_correct { 400.0 } else { 0.0 }) + (avg_acc * 600.0).round()) * time_factor).round() as u32
        }
    };

    DynamicsResult { score, type_correct }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn missing_amount_guess_at_index_0_scores_zero_not_partial_credit() {
        // Regression: guess.amount defaulted to usize::MAX, which cast to
        // i32 wraps to -1 — a diff of 1 against amount_index=0 looked like
        // a "neighbor" hit (300 pts) instead of "no guess made" (0 pts).
        let ex = DynamicsExercise {
            effect: EffectType::Compressor,
            params: amount_presets(EffectType::Compressor, 0),
            amount_index: Some(0),
            guess_mode: GuessMode::TypeAmount,
            level: 2,
        };
        let g = DynamicsGuess { effect: Some(EffectType::Compressor), amount: None, threshold: None, ratio: None, attack_ms: None, release_ms: None, makeup_db: None };
        let r = evaluate(&ex, &g, 0.0);
        // type_correct contributes 400, but the missing amount guess must add 0, not 300.
        assert_eq!(r.score, 400);
    }

    #[test]
    fn generated_params_stay_within_declared_ranges() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(7);
        for _ in 0..200 {
            let ex = generate(1, &mut rng);
            let r = presets_l1(ex.effect);
            assert!(ex.params.threshold_db >= r.threshold.0 - 0.05 && ex.params.threshold_db <= r.threshold.1 + 0.05);
        }
    }

    #[test]
    fn type_only_correct_guess_scores_1000_at_zero_seconds() {
        let ex = DynamicsExercise {
            effect: EffectType::Gate,
            params: DynamicsParams { threshold_db: -30.0, ratio: 10.0, attack_s: 0.003, release_s: 0.1, makeup_db: 0.0 },
            amount_index: None,
            guess_mode: GuessMode::TypeOnly,
            level: 1,
        };
        let g = DynamicsGuess { effect: Some(EffectType::Gate), amount: None, threshold: None, ratio: None, attack_ms: None, release_ms: None, makeup_db: None };
        let r = evaluate(&ex, &g, 0.0);
        assert_eq!(r.score, 1000);
        assert!(r.type_correct);
    }

    #[test]
    fn type_amount_neighbor_gets_partial_credit() {
        let ex = DynamicsExercise {
            effect: EffectType::Compressor,
            params: amount_presets(EffectType::Compressor, 1),
            amount_index: Some(1),
            guess_mode: GuessMode::TypeAmount,
            level: 2,
        };
        let g = DynamicsGuess { effect: Some(EffectType::Compressor), amount: Some(2), threshold: None, ratio: None, attack_ms: None, release_ms: None, makeup_db: None };
        let r = evaluate(&ex, &g, 0.0);
        assert_eq!(r.score, 700); // 400 (type) + 300 (neighbor)
    }
}
