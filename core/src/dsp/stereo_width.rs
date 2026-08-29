//! Mid/Side stereo-width processing — 1:1 port of the client-side
//! ms-width-processor.js AudioWorklet formula.

use crate::buffer::AudioBuffer;

/// width_factor: 0.0 = mono, 1.0 = unmodified stereo, 2.0 = extra-wide.
pub fn apply_stereo_width(buf: &AudioBuffer, width_factor: f32) -> AudioBuffer {
    let stereo = buf.to_channel_count(2);
    let n = stereo.num_frames();
    let mut out = AudioBuffer::new(stereo.sample_rate, 2, n);
    let (l, r) = (&stereo.channels[0], &stereo.channels[1]);

    for i in 0..n {
        let m = (l[i] + r[i]) * 0.5;
        let s = (l[i] - r[i]) * 0.5;
        out.channels[0][i] = m + s * width_factor;
        out.channels[1][i] = m - s * width_factor;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_test_signal(n: usize) -> AudioBuffer {
        let mut b = AudioBuffer::new(48000, 2, n);
        for i in 0..n {
            b.channels[0][i] = 1.0;
            b.channels[1][i] = -1.0;
        }
        b
    }

    #[test]
    fn width_zero_collapses_to_mono() {
        let src = stereo_test_signal(4);
        let out = apply_stereo_width(&src, 0.0);
        for i in 0..4 {
            assert!((out.channels[0][i] - out.channels[1][i]).abs() < 1e-6);
        }
    }

    #[test]
    fn width_one_is_passthrough() {
        let src = stereo_test_signal(4);
        let out = apply_stereo_width(&src, 1.0);
        for i in 0..4 {
            assert!((out.channels[0][i] - 1.0).abs() < 1e-6);
            assert!((out.channels[1][i] - (-1.0)).abs() < 1e-6);
        }
    }

    #[test]
    fn width_two_doubles_side_energy() {
        let src = stereo_test_signal(4);
        let out = apply_stereo_width(&src, 2.0);
        assert!((out.channels[0][0] - 2.0).abs() < 1e-6);
        assert!((out.channels[1][0] - (-2.0)).abs() < 1e-6);
    }
}
