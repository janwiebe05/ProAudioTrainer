//! Stereo Width Trainer — port of backend/src/routes/stereo.js.

use crate::buffer::AudioBuffer;
use crate::dsp::stereo_width::apply_stereo_width;
use crate::exercise::common::time_factor_45;
use rand::Rng;
use serde::Serialize;

pub fn level_options(level: u8) -> &'static [(&'static str, f32)] {
    match level.clamp(1, 3) {
        1 => &[("mono", 0.0), ("stereo", 1.0)],
        2 => &[("schmal", 0.2), ("mittel", 0.5), ("breit", 1.0)],
        _ => &[
            ("mono", 0.0),
            ("sehr schmal", 0.15),
            ("schmal", 0.35),
            ("breit", 0.7),
            ("sehr breit", 1.0),
        ],
    }
}

pub fn explanation(answer: &str) -> &'static str {
    match answer {
        "mono" => "Mono: Kein Stereoanteil — beide Kanäle identisch.",
        "stereo" => "Stereo: Volle Stereobreite — L und R unterschiedlich.",
        "schmal" => "Schmal: Wenig Stereoanteil, klingt fast mono.",
        "mittel" => "Mittel: Ausgewogene Stereobreite.",
        "breit" => "Breit: Deutliche Stereobreite, füllt den Raum.",
        "sehr schmal" => "Sehr schmal: Kaum Stereoanteil, fast mono.",
        "sehr breit" => "Sehr breit: Maximale Stereobreite, fast übertrieben.",
        _ => "",
    }
}

#[derive(Clone)]
pub struct StereoExercise {
    pub correct_answer: &'static str,
    pub width_factor: f32,
    pub level: u8,
}

pub fn generate(level: u8, rng: &mut impl Rng) -> StereoExercise {
    let opts = level_options(level);
    let (answer, width) = opts[rng.gen_range(0..opts.len())];
    StereoExercise { correct_answer: answer, width_factor: width, level: level.clamp(1, 3) }
}

pub fn render(dry: &AudioBuffer, exercise: &StereoExercise) -> AudioBuffer {
    apply_stereo_width(dry, exercise.width_factor)
}

#[derive(Serialize)]
pub struct StereoResult {
    pub correct: bool,
    pub points: u32,
}

pub fn evaluate(exercise: &StereoExercise, answer: &str, seconds_taken: f32) -> StereoResult {
    let correct = answer == exercise.correct_answer;
    let points = ((if correct { 1000.0 } else { 0.0 }) * time_factor_45(seconds_taken)).round() as u32;
    StereoResult { correct, points }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn level1_only_yields_mono_or_stereo() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(1);
        for _ in 0..50 {
            let ex = generate(1, &mut rng);
            assert!(ex.correct_answer == "mono" || ex.correct_answer == "stereo");
        }
    }
}
