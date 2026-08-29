//! Convolution reverb via FFT — the direct fix for the legacy bug where
//! `audioProcessor.js` called the FFmpeg filter `aconvolve`, which does not
//! exist in FFmpeg (verified against the bundled ffmpeg-static binary; only
//! `afir` exists). This implements the convolution ourselves so no external
//! binary is needed on any platform, including a future iOS build.

use crate::buffer::AudioBuffer;
use rustfft::{num_complex::Complex32, FftPlanner};

fn next_pow2(n: usize) -> usize {
    n.next_power_of_two()
}

/// Full linear convolution of two real signals via zero-padded FFT.
/// Output length = dry.len() + ir.len() - 1.
fn fft_convolve(dry: &[f32], ir: &[f32]) -> Vec<f32> {
    if dry.is_empty() || ir.is_empty() {
        return vec![0.0; dry.len()];
    }
    let out_len = dry.len() + ir.len() - 1;
    let fft_len = next_pow2(out_len);

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_len);
    let ifft = planner.plan_fft_inverse(fft_len);

    let mut a: Vec<Complex32> = dry.iter().map(|&s| Complex32::new(s, 0.0)).collect();
    a.resize(fft_len, Complex32::new(0.0, 0.0));
    let mut b: Vec<Complex32> = ir.iter().map(|&s| Complex32::new(s, 0.0)).collect();
    b.resize(fft_len, Complex32::new(0.0, 0.0));

    fft.process(&mut a);
    fft.process(&mut b);

    for (x, y) in a.iter_mut().zip(b.iter()) {
        *x *= y;
    }

    ifft.process(&mut a);

    let norm = 1.0 / fft_len as f32;
    a.into_iter().take(out_len).map(|c| c.re * norm).collect()
}

/// Energy-normalize an impulse response so convolving with it doesn't wildly
/// change overall level (mirrors FFmpeg's `aconvolve normalize=true` intent).
fn normalize_ir(ir: &[f32]) -> Vec<f32> {
    let energy: f32 = ir.iter().map(|s| s * s).sum();
    if energy <= 0.0 {
        return ir.to_vec();
    }
    let norm = 1.0 / energy.sqrt();
    ir.iter().map(|s| s * norm).collect()
}

/// Render a send-style reverb: `dry + wet_mix * (dry ⊛ ir)`, matching the
/// legacy semantics (`amix=inputs=2:weights="1 wetMix"`). Output is trimmed
/// back to the dry clip's original length.
pub fn apply_reverb(dry: &AudioBuffer, ir: &AudioBuffer, wet_mix: f32) -> AudioBuffer {
    let n = dry.num_frames();
    let mut out = AudioBuffer::new(dry.sample_rate, dry.num_channels(), n);

    for (ch_idx, dry_ch) in dry.channels.iter().enumerate() {
        let ir_ch_idx = ch_idx.min(ir.num_channels().saturating_sub(1));
        let ir_ch = normalize_ir(&ir.channels[ir_ch_idx]);
        let wet = fft_convolve(dry_ch, &ir_ch);

        for i in 0..n {
            out.channels[ch_idx][i] = dry_ch[i] + wet_mix * wet.get(i).copied().unwrap_or(0.0);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convolving_with_a_unit_impulse_is_identity() {
        let dry = vec![0.1, 0.2, -0.3, 0.4, -0.5];
        let ir = vec![1.0];
        let out = fft_convolve(&dry, &ir);
        for (a, b) in out.iter().zip(dry.iter()) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    #[test]
    fn convolution_output_length_is_full_linear_length() {
        let dry = vec![1.0; 10];
        let ir = vec![1.0; 5];
        let out = fft_convolve(&dry, &ir);
        assert_eq!(out.len(), 14);
    }

    #[test]
    fn reverb_at_zero_wet_mix_is_unchanged_dry_signal() {
        let mut dry = AudioBuffer::new(48000, 1, 100);
        for (i, s) in dry.channels[0].iter_mut().enumerate() {
            *s = (i as f32 * 0.1).sin() * 0.3;
        }
        let mut ir = AudioBuffer::new(48000, 1, 200);
        ir.channels[0][0] = 1.0;
        for s in ir.channels[0].iter_mut().skip(1) {
            *s = 0.01;
        }

        let out = apply_reverb(&dry, &ir, 0.0);
        for (a, b) in out.channels[0].iter().zip(dry.channels[0].iter()) {
            assert!((a - b).abs() < 1e-5);
        }
    }

    #[test]
    fn reverb_output_stays_same_length_as_dry_clip() {
        let dry = AudioBuffer::new(48000, 2, 1000);
        let mut ir = AudioBuffer::new(48000, 2, 5000);
        ir.channels[0][0] = 1.0;
        ir.channels[1][0] = 1.0;
        let out = apply_reverb(&dry, &ir, 0.5);
        assert_eq!(out.num_frames(), 1000);
    }
}
