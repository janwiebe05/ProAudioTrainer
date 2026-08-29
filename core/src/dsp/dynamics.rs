//! Compressor, limiter, gate and expander — the gate/expander formulas are a
//! direct port of the old client-side AudioWorklet processors
//! (frontend/worklets/gate-processor.js, expander-processor.js), so the
//! exercises sound the same as they did before the broken FFmpeg detour.
//! Compressor/limiter use a standard feedforward soft-knee gain computer
//! (Giannoulis/Massberg/Reiss) since the original relied on the browser's
//! opaque native DynamicsCompressorNode curve, which isn't a portable spec.

use crate::buffer::AudioBuffer;

#[derive(Clone, Copy, Debug)]
pub struct DynamicsParams {
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_s: f32,
    pub release_s: f32,
    pub makeup_db: f32,
}

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn lin_to_db(lin: f32) -> f32 {
    20.0 * lin.max(1e-9).log10()
}

fn one_pole_coeff(sample_rate: f32, time_s: f32) -> f32 {
    if time_s <= 0.0 {
        0.0
    } else {
        (-1.0 / (sample_rate * time_s)).exp()
    }
}

/// Stereo-linked peak envelope: one scalar envelope shared across all
/// channels (matches the worklets' `max(|input[ch][i]|)` peak detector), so
/// gain reduction never shifts the stereo image.
struct PeakEnvelope {
    value: f32,
    attack_coeff: f32,
    release_coeff: f32,
}

impl PeakEnvelope {
    fn new(sample_rate: f32, attack_s: f32, release_s: f32, initial: f32) -> Self {
        Self {
            value: initial,
            attack_coeff: one_pole_coeff(sample_rate, attack_s),
            release_coeff: one_pole_coeff(sample_rate, release_s),
        }
    }

    #[inline]
    fn step(&mut self, peak: f32) -> f32 {
        let coeff = if peak > self.value { self.attack_coeff } else { self.release_coeff };
        self.value = coeff * self.value + (1.0 - coeff) * peak;
        self.value
    }
}

#[inline]
fn frame_peak(buf: &AudioBuffer, i: usize) -> f32 {
    buf.channels.iter().fold(0.0f32, |m, c| m.max(c[i].abs()))
}

fn apply_gain_curve(
    buf: &mut AudioBuffer,
    params: &DynamicsParams,
    compute_desired_gain: impl Fn(f32, f32, f32) -> f32, // (env_lin, env_db, thresh_db) -> gain
) {
    let sample_rate = buf.sample_rate as f32;
    let n = buf.num_frames();
    let mut env = PeakEnvelope::new(sample_rate, params.attack_s, params.release_s, 0.0);
    let makeup_lin = db_to_lin(params.makeup_db);

    for i in 0..n {
        let peak = frame_peak(buf, i);
        let env_lin = env.step(peak);
        let env_db = lin_to_db(env_lin);
        let gain = compute_desired_gain(env_lin, env_db, params.threshold_db).clamp(0.0, 4.0) * makeup_lin;
        for ch in buf.channels.iter_mut() {
            ch[i] *= gain;
        }
    }
}

/// Soft-knee feedforward compressor. `knee_db` of 0 makes it a hard-knee
/// limiter-style curve (used by `apply_limiter` below).
fn compressor_gain_computer(env_db: f32, threshold_db: f32, ratio: f32, knee_db: f32) -> f32 {
    let half_knee = knee_db * 0.5;
    let gr_db = if env_db < threshold_db - half_knee {
        0.0
    } else if env_db > threshold_db + half_knee {
        (env_db - threshold_db) * (1.0 / ratio - 1.0)
    } else {
        let d = env_db - threshold_db + half_knee;
        ((1.0 / ratio - 1.0) * d * d) / (2.0 * knee_db.max(1e-6))
    };
    db_to_lin(gr_db)
}

pub fn apply_compressor(buf: &mut AudioBuffer, params: &DynamicsParams) {
    let p = *params;
    apply_gain_curve(buf, &p, move |_env_lin, env_db, thresh| {
        compressor_gain_computer(env_db, thresh, p.ratio, 3.0)
    });
}

/// Hard-knee, high-ratio compressor — same engine as the compressor, tuned
/// to behave like a brickwall limiter (matches the legacy preset tables,
/// which already set ratio≈20 for "limiter" level configs).
pub fn apply_limiter(buf: &mut AudioBuffer, params: &DynamicsParams) {
    let p = *params;
    apply_gain_curve(buf, &p, move |_env_lin, env_db, thresh| {
        compressor_gain_computer(env_db, thresh, p.ratio, 0.0)
    });
}

/// Noise gate — 1:1 port of gate-processor.js's transfer function, plus its
/// extra 0.99/0.01 fixed-rate gain smoothing on top of the attack/release
/// envelope.
pub fn apply_gate(buf: &mut AudioBuffer, params: &DynamicsParams) {
    let sample_rate = buf.sample_rate as f32;
    let n = buf.num_frames();
    let thresh_lin = db_to_lin(params.threshold_db);
    let mut env = PeakEnvelope::new(sample_rate, params.attack_s, params.release_s, 0.0);
    let mut gain_smooth = 1.0f32;
    let makeup_lin = db_to_lin(params.makeup_db);

    for i in 0..n {
        let peak = frame_peak(buf, i);
        let env_lin = env.step(peak);

        let desired_gain = if env_lin >= thresh_lin {
            1.0
        } else {
            let env_db = lin_to_db(env_lin);
            let attenuation_db = (params.threshold_db - env_db) * (1.0 - 1.0 / params.ratio);
            db_to_lin(-attenuation_db).clamp(0.0, 1.0)
        };

        gain_smooth = 0.99 * gain_smooth + 0.01 * desired_gain;
        let gain = gain_smooth * makeup_lin;
        for ch in buf.channels.iter_mut() {
            ch[i] *= gain;
        }
    }
}

/// Downward expander — 1:1 port of expander-processor.js.
pub fn apply_expander(buf: &mut AudioBuffer, params: &DynamicsParams) {
    let sample_rate = buf.sample_rate as f32;
    let n = buf.num_frames();
    let thresh_lin = db_to_lin(params.threshold_db);
    let mut env = PeakEnvelope::new(sample_rate, params.attack_s, params.release_s, 0.0);
    let attack_coeff = one_pole_coeff(sample_rate, params.attack_s);
    let release_coeff = one_pole_coeff(sample_rate, params.release_s);
    let mut gain_smooth = 1.0f32;
    let makeup_lin = db_to_lin(params.makeup_db);

    for i in 0..n {
        let peak = frame_peak(buf, i);
        let env_lin = env.step(peak);

        let desired_gain = if env_lin >= thresh_lin {
            1.0
        } else {
            let env_db = lin_to_db(env_lin);
            let out_db = params.threshold_db + (env_db - params.threshold_db) * params.ratio;
            db_to_lin(out_db - env_db).clamp(0.0, 1.0)
        };

        let coeff = if desired_gain < gain_smooth { attack_coeff } else { release_coeff };
        gain_smooth = coeff * gain_smooth + (1.0 - coeff) * desired_gain;
        let gain = gain_smooth * makeup_lin;
        for ch in buf.channels.iter_mut() {
            ch[i] *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(frames: usize) -> AudioBuffer {
        AudioBuffer::new(48000, 2, frames)
    }

    fn full_scale_tone(frames: usize, amp: f32) -> AudioBuffer {
        let mut b = AudioBuffer::new(48000, 2, frames);
        for ch in b.channels.iter_mut() {
            for (i, s) in ch.iter_mut().enumerate() {
                *s = amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin();
            }
        }
        b
    }

    #[test]
    fn compressor_below_threshold_is_untouched() {
        let mut b = full_scale_tone(4800, 0.05); // ~ -26 dBFS peak
        let before = b.clone();
        apply_compressor(&mut b, &DynamicsParams {
            threshold_db: -6.0, ratio: 4.0, attack_s: 0.005, release_s: 0.1, makeup_db: 0.0,
        });
        // after the envelope settles, signal should be ~unchanged (well below threshold)
        let tail_before: f32 = before.channels[0][4000..].iter().map(|s| s.abs()).sum();
        let tail_after: f32 = b.channels[0][4000..].iter().map(|s| s.abs()).sum();
        assert!((tail_after - tail_before).abs() / tail_before < 0.05);
    }

    #[test]
    fn compressor_above_threshold_reduces_level() {
        let mut b = full_scale_tone(9600, 0.9); // loud
        apply_compressor(&mut b, &DynamicsParams {
            threshold_db: -12.0, ratio: 6.0, attack_s: 0.002, release_s: 0.05, makeup_db: 0.0,
        });
        let tail_peak = b.channels[0][8000..].iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(tail_peak < 0.9, "expected gain reduction, got peak {tail_peak}");
    }

    #[test]
    fn gate_closes_on_silence() {
        let mut b = silence(4800);
        apply_gate(&mut b, &DynamicsParams {
            threshold_db: -40.0, ratio: 10.0, attack_s: 0.003, release_s: 0.1, makeup_db: 0.0,
        });
        for ch in &b.channels {
            for &s in &ch[1000..] {
                assert!(s.abs() < 1e-6);
            }
        }
    }

    #[test]
    fn expander_passes_loud_signal_through() {
        let mut b = full_scale_tone(4800, 0.9);
        apply_expander(&mut b, &DynamicsParams {
            threshold_db: -30.0, ratio: 2.0, attack_s: 0.01, release_s: 0.1, makeup_db: 0.0,
        });
        let tail_peak = b.channels[0][2000..].iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(tail_peak > 0.85, "loud signal should pass through mostly unattenuated, got {tail_peak}");
    }

    #[test]
    fn no_nan_or_blowup_on_any_processor() {
        for f in [
            apply_compressor as fn(&mut AudioBuffer, &DynamicsParams),
            apply_limiter,
            apply_gate,
            apply_expander,
        ] {
            let mut b = full_scale_tone(2000, 0.5);
            f(&mut b, &DynamicsParams { threshold_db: -20.0, ratio: 8.0, attack_s: 0.005, release_s: 0.1, makeup_db: 6.0 });
            for ch in &b.channels {
                for &s in ch {
                    assert!(s.is_finite());
                }
            }
        }
    }
}
