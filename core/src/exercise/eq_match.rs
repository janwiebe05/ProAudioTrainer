//! EQ Match Trainer — port of backend/src/services/eqMatchService.js.
//!
//! Unlike every other trainer, this one does NOT pre-render audio
//! server-side: the student continuously adjusts EQ bands and needs
//! instant feedback, so the actual filtering (a hidden target curve plus
//! the student's own adjustable bands) stays live client-side Web Audio
//! (BiquadFilterNode chains) — see frontend/modules/eq-match-trainer.js,
//! which is otherwise untouched. This module only decides the hidden
//! target curve and scores a submitted guess against it; the caller hands
//! back the *unprocessed* library track's own path for the client to play
//! and filter itself.
//!
//! JSON field names intentionally match the legacy JS response shape
//! (including its one inconsistency — capital `Q` as a whole word, but
//! `hiddenQ`/`userQ`/`qScore` in camelCase — since the existing frontend
//! reads them literally and there's no reason to touch working UI code
//! just to make the wire format more consistent).

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BandType {
    Lowshelf,
    Peaking,
    Highshelf,
}

struct BandDef {
    band_type: BandType,
    label: &'static str,
    freq_range: (f32, f32),
    has_q: bool,
}

fn band_def(band_id: u8) -> BandDef {
    match band_id {
        1 => BandDef { band_type: BandType::Lowshelf, label: "LOW SHELF", freq_range: (40.0, 300.0), has_q: false },
        2 => BandDef { band_type: BandType::Peaking, label: "LOW MID", freq_range: (200.0, 1200.0), has_q: true },
        3 => BandDef { band_type: BandType::Peaking, label: "HIGH MID", freq_range: (1000.0, 8000.0), has_q: true },
        _ => BandDef { band_type: BandType::Highshelf, label: "HIGH SHELF", freq_range: (4000.0, 16000.0), has_q: false },
    }
}

fn fixed_freq(band_id: u8) -> f32 {
    match band_id {
        1 => 100.0,
        2 => 500.0,
        3 => 3000.0,
        _ => 8000.0,
    }
}

pub struct LevelConfig {
    pub min_bands: u8,
    pub max_bands: u8,
    pub gain_range: (f32, f32),
    pub fixed_q: Option<f32>,
    pub fixed_freq: bool,
    pub user_controls_freq: bool,
    pub user_controls_q: bool,
    pub time_limit: Option<u32>,
}

pub fn level_config(level: u8) -> LevelConfig {
    match level.clamp(1, 3) {
        1 => LevelConfig { min_bands: 1, max_bands: 2, gain_range: (6.0, 12.0), fixed_q: Some(1.0), fixed_freq: true, user_controls_freq: false, user_controls_q: false, time_limit: None },
        2 => LevelConfig { min_bands: 2, max_bands: 3, gain_range: (3.0, 8.0), fixed_q: None, fixed_freq: false, user_controls_freq: true, user_controls_q: true, time_limit: None },
        _ => LevelConfig { min_bands: 4, max_bands: 4, gain_range: (2.0, 5.0), fixed_q: None, fixed_freq: false, user_controls_freq: true, user_controls_q: true, time_limit: Some(90) },
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenBand {
    #[serde(rename = "type")]
    pub band_type: BandType,
    pub label: String,
    pub frequency: f32,
    pub gain: f32,
    #[serde(rename = "Q")]
    pub q: Option<f32>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EqMatchExercise {
    pub level: u8,
    /// Keyed 1..=4 (not 0-indexed) to match the legacy JS object shape the
    /// existing frontend already reads (`data.hiddenBands[id]`).
    pub hidden_bands: BTreeMap<u8, HiddenBand>,
}

pub fn generate(level: u8, rng: &mut impl Rng) -> EqMatchExercise {
    let level = level.clamp(1, 3);
    let config = level_config(level);

    let mut all_ids = [1u8, 2, 3, 4];
    let count = rng.gen_range(config.min_bands..=config.max_bands) as usize;
    all_ids.shuffle(rng);
    let active_ids: Vec<u8> = if level == 3 { vec![1, 2, 3, 4] } else { all_ids[..count].to_vec() };

    let mut hidden_bands = BTreeMap::new();
    for band_id in 1u8..=4 {
        let def = band_def(band_id);
        let is_active = active_ids.contains(&band_id);

        if !is_active {
            let center_freq = if config.fixed_freq { fixed_freq(band_id) } else { ((def.freq_range.0 + def.freq_range.1) / 2.0).round() };
            hidden_bands.insert(band_id, HiddenBand {
                band_type: def.band_type,
                label: def.label.to_string(),
                frequency: center_freq,
                gain: 0.0,
                q: if def.has_q { Some(1.0) } else { None },
                active: false,
            });
            continue;
        }

        let freq = if config.fixed_freq { fixed_freq(band_id) } else { rng.gen_range(def.freq_range.0..=def.freq_range.1).round() };
        let abs_gain = (rng.gen_range(config.gain_range.0..=config.gain_range.1) * 10.0).round() / 10.0;
        let gain = if rng.gen_bool(0.5) { abs_gain } else { -abs_gain };
        let q = if def.has_q {
            Some(config.fixed_q.unwrap_or_else(|| (rng.gen_range(0.5f32..=4.0) * 10.0).round() / 10.0))
        } else {
            None
        };

        hidden_bands.insert(band_id, HiddenBand {
            band_type: def.band_type,
            label: def.label.to_string(),
            frequency: freq,
            gain,
            q,
            active: true,
        });
    }

    EqMatchExercise { level, hidden_bands }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserBand {
    pub gain: Option<f32>,
    pub frequency: Option<f32>,
    #[serde(rename = "Q")]
    pub q: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandResult {
    pub active: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub band_type: Option<BandType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_freq: Option<f32>,
    pub hidden_gain: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_q: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_freq: Option<f32>,
    pub user_gain: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_q: Option<f32>,
    pub ideal_gain: f32,
    pub gain_score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freq_score: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q_score: Option<f32>,
    pub band_score: f32,
    pub score: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqMatchResult {
    pub score: u32,
    pub time_factor: f32,
    pub seconds_taken: f32,
    pub band_results: BTreeMap<u8, BandResult>,
    /// The exercise's hidden target curve, echoed back so the frontend's
    /// reveal screen (eq-match-trainer.js `_showResults()`) can show what
    /// the student was actually matching against — it reads this straight
    /// off the evaluate response rather than keeping its own copy from the
    /// `*_random` call.
    pub hidden_bands: BTreeMap<u8, HiddenBand>,
}

pub fn evaluate(exercise: &EqMatchExercise, user_bands: &BTreeMap<u8, UserBand>, seconds_taken: f32) -> EqMatchResult {
    let config = level_config(exercise.level);
    let mut total_score = 0.0f32;
    let mut band_count = 0u32;
    let mut band_results = BTreeMap::new();

    for band_id in 1u8..=4 {
        let Some(hidden) = exercise.hidden_bands.get(&band_id) else { continue };
        let default_user = UserBand { gain: Some(0.0), frequency: Some(hidden.frequency), q: hidden.q };
        let user = user_bands.get(&band_id).cloned().unwrap_or(default_user);
        let user_gain = user.gain.unwrap_or(0.0);

        if !hidden.active {
            let gain_diff = user_gain.abs();
            let gain_score = (1.0 - gain_diff / 3.0).max(0.0);
            band_results.insert(band_id, BandResult {
                active: false, band_type: None, hidden_freq: None, hidden_gain: 0.0, hidden_q: None,
                user_freq: None, user_gain, user_q: None, ideal_gain: 0.0,
                gain_score, freq_score: None, q_score: None,
                band_score: gain_score, score: (gain_score * 1000.0).round() as u32,
            });
            total_score += gain_score;
            band_count += 1;
            continue;
        }

        let ideal_gain = -hidden.gain;
        let gain_diff = (user_gain - ideal_gain).abs();
        let gain_score = if gain_diff <= 1.5 {
            1.0
        } else if gain_diff <= 3.0 {
            1.0 - (gain_diff - 1.5) / 3.0
        } else {
            (0.5 - (gain_diff - 3.0) / 12.0).max(0.0)
        };

        let mut freq_score = 1.0f32;
        let mut q_score = 1.0f32;

        if config.user_controls_freq && hidden.frequency > 0.0 {
            let user_freq = user.frequency.unwrap_or(hidden.frequency);
            let freq_diff_oct = (user_freq / hidden.frequency).log2().abs();
            freq_score = if freq_diff_oct <= 0.25 { 1.0 } else { (1.0 - (freq_diff_oct - 0.25) / 1.5).max(0.0) };
        }
        if config.user_controls_q {
            if let Some(hq) = hidden.q {
                let uq = user.q.unwrap_or(1.0);
                let q_diff = (uq - hq).abs();
                q_score = if q_diff <= 0.5 { 1.0 } else { (1.0 - (q_diff - 0.5) / 3.0).max(0.0) };
            }
        }

        let has_q = hidden.q.is_some() && config.user_controls_q;
        let has_freq = config.user_controls_freq;
        let band_score = if has_freq && has_q {
            gain_score * 0.55 + freq_score * 0.30 + q_score * 0.15
        } else if has_freq {
            gain_score * 0.65 + freq_score * 0.35
        } else {
            gain_score
        };

        band_results.insert(band_id, BandResult {
            active: true,
            band_type: Some(hidden.band_type),
            hidden_freq: Some(hidden.frequency),
            hidden_gain: hidden.gain,
            hidden_q: hidden.q,
            user_freq: user.frequency,
            user_gain,
            user_q: user.q,
            ideal_gain,
            gain_score,
            freq_score: if has_freq { Some(freq_score) } else { None },
            q_score: if has_q { Some(q_score) } else { None },
            band_score,
            score: (band_score * 1000.0).round() as u32,
        });
        total_score += band_score;
        band_count += 1;
    }

    let max_time = config.time_limit.unwrap_or(120) as f32;
    let time_factor = if config.time_limit.is_some() { (1.0 - seconds_taken / max_time).max(0.3) } else { 1.0 };
    let avg_score = if band_count > 0 { total_score / band_count as f32 } else { 0.0 };
    let final_score = (avg_score * 1000.0 * time_factor).round() as u32;

    EqMatchResult { score: final_score, time_factor, seconds_taken, band_results, hidden_bands: exercise.hidden_bands.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn level1_generates_one_or_two_active_bands_with_fixed_frequencies() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(1);
        for _ in 0..50 {
            let ex = generate(1, &mut rng);
            let active_count = ex.hidden_bands.values().filter(|b| b.active).count();
            assert!((1..=2).contains(&active_count), "expected 1-2 active bands, got {active_count}");
            for (id, band) in &ex.hidden_bands {
                assert_eq!(band.frequency, fixed_freq(*id), "level 1 frequencies must be fixed");
                if band.active {
                    assert!(band.gain.abs() >= 6.0 && band.gain.abs() <= 12.0);
                }
            }
        }
    }

    #[test]
    fn level3_activates_all_four_bands() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(2);
        let ex = generate(3, &mut rng);
        assert!(ex.hidden_bands.values().all(|b| b.active));
        assert_eq!(ex.hidden_bands.len(), 4);
    }

    #[test]
    fn perfect_counter_eq_scores_near_max() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(3);
        let ex = generate(1, &mut rng);

        // Guess the exact inverse of every active band, matching frequency/Q too.
        let mut guesses = BTreeMap::new();
        for (id, band) in &ex.hidden_bands {
            guesses.insert(*id, UserBand { gain: Some(-band.gain), frequency: Some(band.frequency), q: band.q });
        }
        let result = evaluate(&ex, &guesses, 0.0);
        assert!(result.score >= 950, "near-perfect counter-EQ should score close to 1000, got {}", result.score);
    }

    #[test]
    fn doing_nothing_scores_zero_when_bands_are_active() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(4);
        let ex = generate(3, &mut rng); // all 4 active
        let empty = BTreeMap::new(); // no guesses at all -> defaults to gain 0
        let result = evaluate(&ex, &empty, 0.0);
        // With every band definitely active and gains randomly 2-5dB, a
        // flat response should score noticeably below a perfect guess.
        assert!(result.score < 700, "leaving every band flat should score low, got {}", result.score);
    }

    #[test]
    fn evaluate_result_echoes_back_the_hidden_bands() {
        // Regression: EqMatchResult used to omit hidden_bands entirely, so
        // the frontend's `_showResults()` (which destructures it from the
        // evaluate response, not the earlier random response) crashed with
        // a TypeError on every single round submission.
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(6);
        let ex = generate(2, &mut rng);
        let result = evaluate(&ex, &BTreeMap::new(), 0.0);
        assert_eq!(result.hidden_bands.len(), ex.hidden_bands.len());
        for (id, band) in &ex.hidden_bands {
            let echoed = &result.hidden_bands[id];
            assert_eq!(echoed.frequency, band.frequency);
            assert_eq!(echoed.gain, band.gain);
            assert_eq!(echoed.active, band.active);
        }
    }

    #[test]
    fn inactive_band_rewards_leaving_gain_at_zero() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(5);
        let ex = generate(1, &mut rng); // 1-2 active, rest inactive
        let inactive_id = ex.hidden_bands.iter().find(|(_, b)| !b.active).map(|(id, _)| *id);
        let Some(inactive_id) = inactive_id else { return }; // (rare) all-active draw, skip
        let mut guesses = BTreeMap::new();
        guesses.insert(inactive_id, UserBand { gain: Some(0.0), frequency: None, q: None });
        let result = evaluate(&ex, &guesses, 0.0);
        let br = &result.band_results[&inactive_id];
        assert_eq!(br.gain_score, 1.0);
        assert_eq!(br.score, 1000);
    }
}
