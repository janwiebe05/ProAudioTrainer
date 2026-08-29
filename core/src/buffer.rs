//! Planar (per-channel) audio buffer — the common currency between decode,
//! DSP, and the exercise layer. Kept deliberately simple: Vec<Vec<f32>>,
//! one Vec per channel, all channels the same length.

#[derive(Clone, Debug)]
pub struct AudioBuffer {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl AudioBuffer {
    pub fn new(sample_rate: u32, num_channels: usize, num_frames: usize) -> Self {
        Self {
            sample_rate,
            channels: vec![vec![0.0f32; num_frames]; num_channels.max(1)],
        }
    }

    pub fn num_channels(&self) -> usize {
        self.channels.len()
    }

    pub fn num_frames(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }

    pub fn duration_secs(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.num_frames() as f64 / self.sample_rate as f64
        }
    }

    /// Mono downmix (equal-weight average of all channels).
    pub fn to_mono(&self) -> Vec<f32> {
        let n = self.num_frames();
        let ch = self.num_channels().max(1) as f32;
        let mut out = vec![0.0f32; n];
        for c in &self.channels {
            for (o, s) in out.iter_mut().zip(c.iter()) {
                *o += s / ch;
            }
        }
        out
    }

    /// Ensure the buffer has exactly `n` channels: duplicate the last channel
    /// if it has fewer, or drop extras if it has more. Used so mono source
    /// material can go through effects that assume stereo (pan, width).
    pub fn to_channel_count(&self, n: usize) -> AudioBuffer {
        let mut out = AudioBuffer::new(self.sample_rate, n, self.num_frames());
        for (i, ch) in out.channels.iter_mut().enumerate() {
            let src_idx = i.min(self.num_channels().saturating_sub(1));
            if let Some(src) = self.channels.get(src_idx) {
                ch.copy_from_slice(src);
            }
        }
        out
    }

    pub fn peak(&self) -> f32 {
        self.channels
            .iter()
            .flat_map(|c| c.iter())
            .fold(0.0f32, |m, &s| m.max(s.abs()))
    }
}
