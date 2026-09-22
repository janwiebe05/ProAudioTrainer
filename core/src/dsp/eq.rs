//! Peaking EQ — RBJ Audio Cookbook biquad, the same characteristic as the
//! Web Audio `BiquadFilterNode` (type "peaking") the old client-side engine
//! used, so exercises sound the same as before the server-rendering detour.

use crate::buffer::AudioBuffer;

/// One RBJ peaking-EQ biquad, Direct Form I, per-channel state.
#[derive(Clone, Copy, Default)]
struct BiquadState {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

struct BiquadCoeffs {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl BiquadCoeffs {
    /// RBJ cookbook peaking-EQ coefficients.
    /// freq: center frequency (Hz), gain_db: boost/cut in dB, q: Q factor.
    fn peaking(sample_rate: f32, freq: f32, gain_db: f32, q: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * (freq / sample_rate).clamp(1e-6, 0.499);
        let alpha = w0.sin() / (2.0 * q.max(0.0001));
        let cos_w0 = w0.cos();

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;

        BiquadCoeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    #[inline]
    fn process(&self, x0: f32, s: &mut BiquadState) -> f32 {
        let y0 = self.b0 * x0 + self.b1 * s.x1 + self.b2 * s.x2 - self.a1 * s.y1 - self.a2 * s.y2;
        s.x2 = s.x1;
        s.x1 = x0;
        s.y2 = s.y1;
        s.y1 = y0;
        y0
    }
}

/// Apply a peaking-EQ boost/cut in place, independently per channel.
pub fn apply_peaking_eq(buf: &mut AudioBuffer, freq: f32, gain_db: f32, q: f32) {
    let coeffs = BiquadCoeffs::peaking(buf.sample_rate as f32, freq, gain_db, q);
    for channel in buf.channels.iter_mut() {
        let mut state = BiquadState::default();
        for sample in channel.iter_mut() {
            *sample = coeffs.process(*sample, &mut state);
        }
    }
}

/// Magnitude response in dB at `freq_hz`, used for canvas/curve display
/// parity with the old client-side `getFrequencyResponse()` calls.
pub fn frequency_response_db(sample_rate: f32, center_freq: f32, gain_db: f32, q: f32, freq_hz: f32) -> f32 {
    let c = BiquadCoeffs::peaking(sample_rate, center_freq, gain_db, q);
    let w = 2.0 * std::f32::consts::PI * (freq_hz / sample_rate);
    let (cos_w, sin_w) = (w.cos(), w.sin());
    let (cos_2w, sin_2w) = ((2.0 * w).cos(), (2.0 * w).sin());

    // H(e^jw) = (b0 + b1*e^-jw + b2*e^-2jw) / (1 + a1*e^-jw + a2*e^-2jw)
    let num_re = c.b0 + c.b1 * cos_w + c.b2 * cos_2w;
    let num_im = -c.b1 * sin_w - c.b2 * sin_2w;
    let den_re = 1.0 + c.a1 * cos_w + c.a2 * cos_2w;
    let den_im = -c.a1 * sin_w - c.a2 * sin_2w;

    let num_mag = (num_re * num_re + num_im * num_im).sqrt();
    let den_mag = (den_re * den_re + den_im * den_im).sqrt().max(1e-12);
    20.0 * (num_mag / den_mag).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_at_center_freq_matches_requested_gain() {
        let db = frequency_response_db(48000.0, 1000.0, 9.0, 4.0, 1000.0);
        assert!((db - 9.0).abs() < 0.05, "expected ~9dB at center, got {db}");
    }

    #[test]
    fn response_far_from_center_is_near_zero() {
        let db = frequency_response_db(48000.0, 1000.0, 12.0, 4.0, 50.0);
        assert!(db.abs() < 1.0, "expected ~0dB far from center, got {db}");
    }

    #[test]
    fn processing_a_buffer_does_not_produce_nan_or_explode() {
        let mut buf = AudioBuffer::new(48000, 2, 4800);
        for ch in buf.channels.iter_mut() {
            for (i, s) in ch.iter_mut().enumerate() {
                *s = (i as f32 * 0.01).sin() * 0.5;
            }
        }
        apply_peaking_eq(&mut buf, 1000.0, 12.0, 4.0);
        for ch in &buf.channels {
            for &s in ch {
                assert!(s.is_finite());
                assert!(s.abs() < 10.0, "sample exploded: {s}");
            }
        }
    }
}
