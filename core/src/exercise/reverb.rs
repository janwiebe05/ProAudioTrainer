//! Reverb Trainer — port of backend/src/routes/reverb.js. The IR catalogue
//! paths are relative to the bundled EchoThief content pack
//! (frontend/EchoThief/...), resolved by the caller (Tauri command layer)
//! against wherever that content pack is installed.

use crate::buffer::AudioBuffer;
use crate::dsp::reverb::apply_reverb;
use crate::exercise::common::time_factor_45;
use rand::Rng;
use serde::Serialize;

pub const CATEGORIES: [&str; 5] = ["room", "concert_hall", "cathedral", "tunnel", "outdoor"];

pub fn category_label(category: &str) -> &'static str {
    match category {
        "room" => "Small Room",
        "concert_hall" => "Concert Hall",
        "cathedral" => "Cathedral / Church",
        "tunnel" => "Tunnel / Underpass",
        "outdoor" => "Outdoor / Cave",
        _ => "",
    }
}

pub fn ir_catalogue(category: &str) -> &'static [&'static str] {
    match category {
        "cathedral" => &[
            "/EchoThief/Sanctuaries/St Paul's Cathedral San Diego California.wav",
            "/EchoThief/Sanctuaries/First Church of Christ Scientist Original Edifice Boston Massachusetts.wav",
            "/EchoThief/Sanctuaries/Founders Chapel University of San Diego California.wav",
            "/EchoThief/Sanctuaries/Immaculata Dome University of San Diego California.wav",
            "/EchoThief/Domes/Immaculata Dome University of San Diego California.wav",
            "/EchoThief/Domes/Square Victoria Dome Montreal Quebec.wav",
        ],
        "concert_hall" => &[
            "/EchoThief/Venues/Conrad Prebys Concert Hall Seat F111 UC San Diego California.wav",
            "/EchoThief/Venues/Orpheum Theatre Omaha Grand Tier D8 Nebraska.wav",
            "/EchoThief/Venues/Steinman Hall Millersville University Pennsylvania.wav",
            "/EchoThief/Venues/City Heights Performance Annex San Diego California.wav",
            "/EchoThief/Miscellaneous/Littlefield Concert Hall Lobby Mills College Oakland California.wav",
        ],
        "tunnel" => &[
            "/EchoThief/Underground/Lake Mead Aqueduct Nevada.wav",
            "/EchoThief/Underground/Meadowbrook Tunnel Storm Drain Poway California.wav",
            "/EchoThief/Underpasses/Echo Bridge Newton Upper Falls Massachusetts.wav",
            "/EchoThief/Underpasses/Dipway Arch Central Park New York.wav",
            "/EchoThief/Underground/Subway Cave Lava Tube Sanctum Lassen National Forest California.wav",
            "/EchoThief/Underpasses/Cleft Ridge Span Prospect Park Brooklyn New York.wav",
        ],
        "outdoor" => &[
            "/EchoThief/Nature/Byron Glacier Alaska.wav",
            "/EchoThief/Nature/Isla Mujeres Cave Quintana Roo.wav",
            "/EchoThief/Nature/Subway Cave Lava Tube Sanctum Lassen National Forest California.wav",
            "/EchoThief/Venues/Mills Greek Theater Oakland California.wav",
            "/EchoThief/Nature/Purgatory Chasm Rhode Island.wav",
        ],
        _ => &[ // "room"
            "/EchoThief/Recreation/Racquetball Court UC San Diego California.wav",
            "/EchoThief/Recreation/Hale Holistic Yoga Studio San Diego California.wav",
            "/EchoThief/Miscellaneous/Warren Lecture Hall 2005 UC San Diego California.wav",
            "/EchoThief/Miscellaneous/Hawxhurst Mansion Ballroom Newport Rhode Island.wav",
            "/EchoThief/Miscellaneous/Bar Monsieur Ricard Montreal Quebec.wav",
            "/EchoThief/Stairwells/CCRMA Stairwell Stanford University California.wav",
        ],
    }
}

pub fn level_categories(level: u8) -> &'static [&'static str] {
    match level.clamp(1, 3) {
        1 => &["room", "concert_hall", "cathedral"],
        2 => &["room", "concert_hall", "cathedral", "tunnel"],
        _ => &["room", "concert_hall", "cathedral", "tunnel", "outdoor"],
    }
}

fn wet_range(level: u8) -> (f32, f32) {
    match level.clamp(1, 3) {
        1 => (0.6, 0.8),
        2 => (0.4, 0.7),
        _ => (0.2, 0.5),
    }
}

#[derive(Clone)]
pub struct ReverbExercise {
    pub category: &'static str,
    pub ir_rel_path: &'static str,
    pub wet_mix: f32,
    pub level: u8,
}

pub fn generate(level: u8, rng: &mut impl Rng) -> ReverbExercise {
    let level = level.clamp(1, 3);
    let categories = level_categories(level);
    let category = categories[rng.gen_range(0..categories.len())];
    let ir_options = ir_catalogue(category);
    let ir_rel_path = ir_options[rng.gen_range(0..ir_options.len())];
    let (w_min, w_max) = wet_range(level);
    let wet_mix = rng.gen_range(w_min..=w_max);

    ReverbExercise { category, ir_rel_path, wet_mix, level }
}

pub fn render(dry: &AudioBuffer, ir: &AudioBuffer, wet_mix: f32) -> AudioBuffer {
    apply_reverb(dry, ir, wet_mix)
}

#[derive(Serialize)]
pub struct ReverbResult {
    pub correct: bool,
    pub score: u32,
}

pub fn evaluate(exercise: &ReverbExercise, guess_category: &str, seconds_taken: f32) -> ReverbResult {
    let correct = guess_category == exercise.category;
    let score = ((if correct { 1000.0 } else { 0.0 }) * time_factor_45(seconds_taken)).round() as u32;
    ReverbResult { correct, score }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn generated_category_is_always_within_level_set() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(9);
        for level in 1..=3u8 {
            for _ in 0..100 {
                let ex = generate(level, &mut rng);
                assert!(level_categories(level).contains(&ex.category));
                assert!(ir_catalogue(ex.category).contains(&ex.ir_rel_path));
            }
        }
    }

    #[test]
    fn level1_never_includes_outdoor() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(11);
        for _ in 0..100 {
            let ex = generate(1, &mut rng);
            assert_ne!(ex.category, "outdoor");
        }
    }
}
