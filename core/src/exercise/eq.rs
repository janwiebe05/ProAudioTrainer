//! EQ Trainer — port of backend/src/routes/eq.js.
//!
//! `generate()` picks the target frequency via `pick_audible_frequency()`,
//! which runs a quick FFT over the picked library clip so the boost lands
//! somewhere the track actually has energy — a plain log-uniform pick could
//! otherwise target a band the specific clip is nearly silent in (e.g. 6kHz
//! on an upright-bass-and-vocals recording), making the exercise's boost
//! inaudible no matter how carefully the student listens.

use crate::buffer::AudioBuffer;
use crate::dsp::eq::apply_peaking_eq;
use crate::exercise::common::time_factor_10;
use rand::Rng;
use rustfft::{num_complex::Complex32, FftPlanner};
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

fn quantize_to_semitone(freq: f32) -> f32 {
    (2f32.powf((freq.log2() * 12.0).round() / 12.0)).round()
}

/// Magnitude spectrum of `mono` (bins 0..=fft_len/2, DC to Nyquist), plus
/// the FFT length used — needed by callers to convert a bin index back to
/// Hz. Only a rough single-window analysis (no overlap-add): this decides
/// which frequencies are worth targeting, it doesn't measure levels
/// precisely. A Hann window keeps the strongest partials' spectral leakage
/// from making empty bands look occupied.
fn magnitude_spectrum(mono: &[f32], sample_rate: u32) -> (Vec<f32>, usize) {
    // A few seconds is plenty to tell "present" from "absent" in a band,
    // and keeps the FFT cheap even for a full ~20s clip.
    let n = mono.len().min(sample_rate as usize * 4).next_power_of_two().max(1024);
    let used = mono.len().min(n);
    let mut buf: Vec<Complex32> = (0..n)
        .map(|i| {
            if i < used {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / used.max(2) as f32).cos();
                Complex32::new(mono[i] * w, 0.0)
            } else {
                Complex32::new(0.0, 0.0)
            }
        })
        .collect();
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut buf);
    let magnitudes = buf[..=n / 2].iter().map(|c| c.norm()).collect();
    (magnitudes, n)
}

/// Summed squared magnitude in a third-octave-wide band centered on `freq`
/// (about the width of the exercise's Q=4 peaking boost) — a rough but
/// cheap stand-in for "how much energy does the signal actually have
/// where the boost would land".
fn energy_near(spectrum: &[f32], sample_rate: u32, fft_len: usize, freq: f32) -> f32 {
    let bin_hz = sample_rate as f32 / fft_len as f32;
    let lo = ((freq / 2f32.powf(1.0 / 6.0)) / bin_hz).floor().max(0.0) as usize;
    let hi = (((freq * 2f32.powf(1.0 / 6.0)) / bin_hz).ceil() as usize).min(spectrum.len().saturating_sub(1));
    spectrum[lo.min(hi)..=hi].iter().map(|m| m * m).sum()
}

/// A band counts as audible if it is within this many dB (power) of the
/// clip's strongest band in the allowed range. Deliberately lenient: this
/// is a floor that rules out bands with effectively nothing in them (100 Hz
/// on an oboe solo, 10 kHz on a bass line), NOT a preference for loud
/// bands — real music tilts down 10–30 dB from the mids to the extremes,
/// and the exercise exists to train the whole spectrum, so anything clearly
/// present must stay in play.
const AUDIBLE_WITHIN_DB: f32 = 40.0;

/// Picks a target frequency the clip actually has content at, without
/// favouring wherever its energy happens to be concentrated.
///
/// 1. Scan the allowed range on a fine log grid and find the strongest band.
/// 2. Every grid point within `AUDIBLE_WITHIN_DB` of it is "audible".
/// 3. Draw ordinary log-uniform candidates (the original distribution) and
///    accept the first audible one. Because the floor is lenient, this is
///    effectively uniform across everything audible.
/// 4. If every draw lands in an empty band (very narrow spectrum), pick
///    uniformly among the audible grid points instead — not the single
///    loudest one, which would make every round on such a clip identical.
///
/// Pure silence (nothing to analyse) falls back to a plain random pick.
fn pick_audible_frequency(dry: &AudioBuffer, freq_min: f32, freq_max: f32, rng: &mut impl Rng) -> f32 {
    let mono = dry.to_mono();
    if mono.iter().all(|s| *s == 0.0) {
        return random_frequency(freq_min, freq_max, rng);
    }
    let (spectrum, fft_len) = magnitude_spectrum(&mono, dry.sample_rate);
    let energy_at = |f: f32| energy_near(&spectrum, dry.sample_rate, fft_len, f);

    const SCAN_STEPS: u32 = 96;
    let grid: Vec<(f32, f32)> = (0..=SCAN_STEPS)
        .map(|i| {
            let f = freq_min * (freq_max / freq_min).powf(i as f32 / SCAN_STEPS as f32);
            (f, energy_at(f))
        })
        .collect();
    let best_energy = grid.iter().map(|(_, e)| *e).fold(0.0f32, f32::max);
    if best_energy <= 0.0 {
        return random_frequency(freq_min, freq_max, rng);
    }

    let floor = best_energy * 10f32.powf(-AUDIBLE_WITHIN_DB / 10.0);

    const MAX_ATTEMPTS: u32 = 40;
    for _ in 0..MAX_ATTEMPTS {
        let candidate = random_frequency(freq_min, freq_max, rng);
        if energy_at(candidate) >= floor {
            return candidate;
        }
    }

    let audible: Vec<f32> = grid.iter().filter(|(_, e)| *e >= floor).map(|(f, _)| *f).collect();
    // `best_energy > 0` guarantees at least the strongest grid point qualifies.
    quantize_to_semitone(audible[rng.gen_range(0..audible.len())])
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EqExercise {
    pub freq: f32,
    pub gain_db: f32,
    pub level: u8,
    pub freq_min: f32,
    pub freq_max: f32,
}

pub fn generate(level: u8, freq_min: Option<f32>, freq_max: Option<f32>, dry: &AudioBuffer, rng: &mut impl Rng) -> EqExercise {
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
        freq: pick_audible_frequency(dry, freq_min, freq_max, rng),
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

    fn tone_buffer(sample_rate: u32, seconds: f32, freq_hz: f32, amp: f32) -> AudioBuffer {
        let n = (sample_rate as f32 * seconds) as usize;
        let mut b = AudioBuffer::new(sample_rate, 1, n);
        for (i, s) in b.channels[0].iter_mut().enumerate() {
            *s = amp * (2.0 * std::f32::consts::PI * freq_hz * i as f32 / sample_rate as f32).sin();
        }
        b
    }

    #[test]
    fn invalid_freq_range_falls_back_to_level_default_instead_of_nan() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(1);
        let silence = AudioBuffer::new(48000, 1, 48000);
        for (bad_min, bad_max) in [(0.0, 8000.0), (-100.0, 8000.0), (5000.0, 100.0), (1000.0, 1000.0)] {
            let ex = generate(2, Some(bad_min), Some(bad_max), &silence, &mut rng);
            assert!(ex.freq.is_finite(), "freq should never be NaN/inf for bad input ({bad_min}, {bad_max})");
            assert!(ex.freq > 0.0);
        }
    }

    #[test]
    fn generate_prefers_a_frequency_the_clip_actually_has_energy_at() {
        // A near-pure 2kHz tone with almost nothing else in the spectrum —
        // any target far from 2kHz would be effectively inaudible once
        // boosted. Run many rounds and check the overwhelming majority
        // land close to the one place there's real signal.
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(2);
        let dry = tone_buffer(48000, 1.0, 2000.0, 0.5);
        let mut near_tone = 0;
        let total = 30;
        for _ in 0..total {
            let ex = generate(1, Some(100.0), Some(12000.0), &dry, &mut rng);
            // within +/- 1 octave of the tone counts as "found the energy"
            if (ex.freq / 2000.0).log2().abs() <= 1.0 {
                near_tone += 1;
            }
        }
        assert!(near_tone as f32 / total as f32 >= 0.9, "{near_tone}/{total} picks landed near the only audible frequency");
    }

    fn multi_tone_buffer(sample_rate: u32, seconds: f32, partials: &[(f32, f32)]) -> AudioBuffer {
        let n = (sample_rate as f32 * seconds) as usize;
        let mut b = AudioBuffer::new(sample_rate, 1, n);
        for (i, s) in b.channels[0].iter_mut().enumerate() {
            let t = i as f32 / sample_rate as f32;
            *s = partials.iter().map(|(f, a)| a * (2.0 * std::f32::consts::PI * f * t).sin()).sum();
        }
        b
    }

    #[test]
    fn never_targets_a_band_the_clip_has_nothing_in() {
        // Oboe-like: fundamental ~466 Hz plus harmonics, nothing below.
        // A boost at 100 Hz would be inaudible, so it must never be picked.
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(4);
        let partials: Vec<(f32, f32)> = (1..=8).map(|h| (466.0 * h as f32, 0.3 / h as f32)).collect();
        let dry = multi_tone_buffer(48000, 1.0, &partials);
        for _ in 0..60 {
            let ex = generate(2, Some(60.0), Some(12000.0), &dry, &mut rng);
            assert!(ex.freq >= 300.0, "picked {} Hz, which this clip has no content at", ex.freq);
        }
    }

    #[test]
    fn spreads_across_the_whole_audible_spectrum_instead_of_clustering_at_its_peak() {
        // Pink-like: equal energy per third-octave band (amplitude ~ 1/sqrt(f))
        // from 100 Hz to 8 kHz. Every band is audible, so picks must cover the
        // range — in particular the highs, where a peak-relative threshold
        // used to starve them and pile everything into 500 Hz - 2 kHz.
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(5);
        let partials: Vec<(f32, f32)> = (0..=18)
            .map(|i| { let f = 100.0 * 2f32.powf(i as f32 / 3.0); (f, 0.2 / f.sqrt().max(1.0) * 10.0) })
            .collect();
        let dry = multi_tone_buffer(48000, 1.0, &partials);
        let (mut low, mut mid, mut high) = (0, 0, 0);
        for _ in 0..150 {
            let f = generate(2, Some(100.0), Some(8000.0), &dry, &mut rng).freq;
            if f < 400.0 { low += 1 } else if f < 2000.0 { mid += 1 } else { high += 1 }
        }
        // Log-uniform over 100-8000 Hz is ~1/3 each (400 Hz and 2 kHz are 2 octaves apart).
        assert!(low >= 20 && mid >= 20 && high >= 20, "uneven spread: low={low} mid={mid} high={high}");
    }

    #[test]
    fn generate_still_returns_a_finite_frequency_on_pure_silence() {
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(3);
        let silence = AudioBuffer::new(48000, 1, 48000);
        for _ in 0..20 {
            let ex = generate(2, Some(100.0), Some(12000.0), &silence, &mut rng);
            assert!(ex.freq.is_finite() && ex.freq >= 100.0 && ex.freq <= 12000.0);
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
