//! Equal-power panning — the exact Web Audio spec algorithm for
//! `StereoPannerNode`, applied directly to the stereo signal. This restores
//! the pre-regression behavior: the legacy FFmpeg path downmixed to mono
//! before panning (a workaround for FFmpeg's `pan` filter), which discarded
//! the original stereo image entirely. Real equal-power panning only
//! reduces one side's gain — it does not collapse the source to mono first.

use crate::buffer::AudioBuffer;

/// pan_value: -100 (hard left) .. +100 (hard right), 0 = center.
pub fn apply_pan(buf: &AudioBuffer, pan_value: f32) -> AudioBuffer {
    let pan = (pan_value / 100.0).clamp(-1.0, 1.0);
    let n = buf.num_frames();
    let mut out = AudioBuffer::new(buf.sample_rate, 2, n);

    if buf.num_channels() == 1 {
        // Mono source → stereo field (spec's mono-input panning law).
        let x = (pan + 1.0) / 2.0;
        let (gain_l, gain_r) = ((x * std::f32::consts::FRAC_PI_2).cos(), (x * std::f32::consts::FRAC_PI_2).sin());
        let src = &buf.channels[0];
        for i in 0..n {
            out.channels[0][i] = src[i] * gain_l;
            out.channels[1][i] = src[i] * gain_r;
        }
        return out;
    }

    // Stereo source → stereo field (spec's stereo-input panning law).
    let x = if pan <= 0.0 { pan + 1.0 } else { pan };
    let (gain_l, gain_r) = ((x * std::f32::consts::FRAC_PI_2).cos(), (x * std::f32::consts::FRAC_PI_2).sin());
    let (l, r) = (&buf.channels[0], &buf.channels[1]);
    for i in 0..n {
        if pan <= 0.0 {
            out.channels[0][i] = l[i] + r[i] * gain_l;
            out.channels[1][i] = r[i] * gain_r;
        } else {
            out.channels[0][i] = l[i] * gain_l;
            out.channels[1][i] = r[i] + l[i] * gain_r;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mono_impulse_as_stereo(n: usize) -> AudioBuffer {
        let mut b = AudioBuffer::new(48000, 2, n);
        for ch in b.channels.iter_mut() {
            ch[0] = 1.0;
        }
        b
    }

    #[test]
    fn center_pan_is_unity_both_channels() {
        let src = mono_impulse_as_stereo(4);
        let out = apply_pan(&src, 0.0);
        assert!((out.channels[0][0] - 1.0).abs() < 1e-5);
        assert!((out.channels[1][0] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn hard_left_silences_right_contribution_from_right_channel() {
        let src = mono_impulse_as_stereo(4);
        let out = apply_pan(&src, -100.0);
        // gain_r = sin(0) = 0 → right channel's own signal is fully attenuated
        assert!(out.channels[1][0].abs() < 1e-5);
        // left channel keeps its full signal plus right bleed at gain_l=cos(0)=1
        assert!((out.channels[0][0] - 2.0).abs() < 1e-4);
    }

    #[test]
    fn hard_right_silences_left_contribution_from_left_channel() {
        let src = mono_impulse_as_stereo(4);
        let out = apply_pan(&src, 100.0);
        assert!(out.channels[0][0].abs() < 1e-5);
        assert!((out.channels[1][0] - 2.0).abs() < 1e-4);
    }
}
