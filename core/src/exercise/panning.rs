//! Panning Trainer — port of backend/src/routes/panning.js.

use crate::buffer::AudioBuffer;
use crate::dsp::pan::apply_pan;
use crate::dsp::stereo_width::apply_stereo_width;
use crate::exercise::common::time_factor_45;
use rand::Rng;
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub struct PanZone {
    pub id: &'static str,
    pub label: &'static str,
    pub value: f32,
}

pub const PAN_ZONES: [PanZone; 7] = [
    PanZone { id: "L100", label: "L 100", value: -100.0 },
    PanZone { id: "L66", label: "L 66", value: -66.0 },
    PanZone { id: "L33", label: "L 33", value: -33.0 },
    PanZone { id: "C", label: "CENTER", value: 0.0 },
    PanZone { id: "R33", label: "R 33", value: 33.0 },
    PanZone { id: "R66", label: "R 66", value: 66.0 },
    PanZone { id: "R100", label: "R 100", value: 100.0 },
];
const ZONE_WEIGHTS: [u32; 7] = [2, 2, 2, 1, 2, 2, 2];

#[derive(Clone, Copy, Serialize)]
pub struct WidthStep {
    pub id: &'static str,
    pub label: &'static str,
    pub value: f32,
}

pub const WIDTH_STEPS: [WidthStep; 5] = [
    WidthStep { id: "mono", label: "MONO", value: 0.0 },
    WidthStep { id: "narrow", label: "SCHMAL", value: 50.0 },
    WidthStep { id: "normal", label: "NORMAL", value: 100.0 },
    WidthStep { id: "wide", label: "BREIT", value: 150.0 },
    WidthStep { id: "very_wide", label: "SEHR BREIT", value: 200.0 },
];
const WIDTH_WEIGHTS: [u32; 5] = [2, 2, 1, 2, 2];

fn weighted_pick<const N: usize>(weights: [u32; N], rng: &mut impl Rng) -> usize {
    let total: u32 = weights.iter().sum();
    let mut r = rng.gen_range(0..total) as i64;
    for (i, w) in weights.iter().enumerate() {
        r -= *w as i64;
        if r < 0 {
            return i;
        }
    }
    N - 1
}

#[derive(Clone, PartialEq, Debug)]
pub enum PanningExercise {
    Zone { zone_idx: usize },
    Value { pan_value: f32 },
    Width { step_idx: usize },
}

pub fn generate(level: u8, rng: &mut impl Rng) -> PanningExercise {
    match level.clamp(1, 3) {
        1 => PanningExercise::Zone { zone_idx: weighted_pick(ZONE_WEIGHTS, rng) },
        2 => {
            let mut pan_value;
            loop {
                pan_value = rng.gen_range(-100..=100) as f32;
                if !(pan_value.abs() < 15.0 && rng.gen::<f32>() < 0.7) {
                    break;
                }
            }
            PanningExercise::Value { pan_value }
        }
        _ => PanningExercise::Width { step_idx: weighted_pick(WIDTH_WEIGHTS, rng) },
    }
}

pub fn render(dry: &AudioBuffer, exercise: &PanningExercise) -> AudioBuffer {
    match exercise {
        PanningExercise::Zone { zone_idx } => apply_pan(dry, PAN_ZONES[*zone_idx].value),
        PanningExercise::Value { pan_value } => apply_pan(dry, *pan_value),
        PanningExercise::Width { step_idx } => apply_stereo_width(dry, WIDTH_STEPS[*step_idx].value / 100.0),
    }
}

#[derive(Serialize)]
pub struct PanningResult {
    pub score: u32,
    pub correct: bool,
}

pub fn evaluate_zone(exercise_zone_idx: usize, guess_zone_id: &str, seconds_taken: f32) -> PanningResult {
    // Option, not a usize::MAX sentinel: casting MAX to i64 wraps around to
    // -1, which used to make an unrecognized guess score as a false
    // "neighbor" hit against zone index 0 instead of a real miss.
    let guess_idx = PAN_ZONES.iter().position(|z| z.id == guess_zone_id);
    let (correct, partial) = match guess_idx {
        Some(idx) => {
            let diff = (exercise_zone_idx as i64 - idx as i64).unsigned_abs();
            (diff == 0, diff == 1)
        }
        None => (false, false),
    };
    let time_factor = time_factor_45(seconds_taken);
    let score = ((if correct { 1000.0 } else if partial { 400.0 } else { 0.0 }) * time_factor).round() as u32;
    PanningResult { score, correct }
}

pub fn evaluate_value(pan_value: f32, guess_pan: f32, seconds_taken: f32) -> PanningResult {
    let diff = (guess_pan - pan_value).abs();
    let correct = diff <= 15.0;
    let accuracy = (1.0 - diff / 100.0).max(0.0);
    let time_factor = time_factor_45(seconds_taken);
    let score = (accuracy * 1000.0 * time_factor).round() as u32;
    PanningResult { score, correct }
}

pub fn evaluate_width(step_idx: usize, guess_width_id: &str, seconds_taken: f32) -> PanningResult {
    // Option here too — an unrecognized id must not silently score as
    // though the user had picked 'normal'.
    let guess_idx = WIDTH_STEPS.iter().position(|s| s.id == guess_width_id);
    let (correct, partial) = match guess_idx {
        Some(idx) => {
            let diff = (step_idx as i64 - idx as i64).unsigned_abs();
            (diff == 0, diff == 1)
        }
        None => (false, false),
    };
    let time_factor = time_factor_45(seconds_taken);
    let score = ((if correct { 1000.0 } else if partial { 400.0 } else { 0.0 }) * time_factor).round() as u32;
    PanningResult { score, correct }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn unrecognized_zone_guess_at_index_0_scores_zero_not_partial_credit() {
        // Regression: guess_idx used to fall back to usize::MAX, which cast
        // to i64 wraps to -1 — a diff of 1 against zone_idx=0 looked like a
        // "neighbor" hit (400 pts) instead of a real miss (0 pts).
        let r = evaluate_zone(0, "not-a-real-zone-id", 0.0);
        assert!(!r.correct);
        assert_eq!(r.score, 0);
    }

    #[test]
    fn unrecognized_width_guess_at_index_0_scores_zero_not_partial_credit() {
        let r = evaluate_width(0, "not-a-real-width-id", 0.0);
        assert!(!r.correct);
        assert_eq!(r.score, 0);
    }

    #[test]
    fn level2_pan_value_rarely_lands_near_center() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(3);
        let mut near_center = 0;
        for _ in 0..500 {
            if let PanningExercise::Value { pan_value } = generate(2, &mut rng) {
                if pan_value.abs() < 15.0 {
                    near_center += 1;
                }
            }
        }
        assert!(near_center < 500 / 2, "expected near-center pan values to be de-weighted, got {near_center}/500");
    }

    #[test]
    fn exact_zone_guess_scores_max() {
        let r = evaluate_zone(3, "C", 0.0); // zone_idx 3 == "C"
        assert!(r.correct);
        assert_eq!(r.score, 1000);
    }

    #[test]
    fn neighbor_zone_gets_partial_credit() {
        let r = evaluate_zone(3, "R33", 0.0); // neighbor of "C"
        assert!(!r.correct);
        assert_eq!(r.score, 400);
    }
}
