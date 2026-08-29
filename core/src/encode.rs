//! WAV encoding — the interchange format between the Rust core and the
//! webview frontend (written to the app cache dir, loaded via
//! `convertFileSrc` + `decodeAudioData`, which natively understands WAV with
//! no extra decoder library needed on the JS side).

use crate::buffer::AudioBuffer;
use crate::error::{CoreError, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::io::Cursor;

pub fn encode_wav_i16(buf: &AudioBuffer) -> Result<Vec<u8>> {
    let spec = WavSpec {
        channels: buf.num_channels() as u16,
        sample_rate: buf.sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut out = Vec::new();
    {
        let cursor = Cursor::new(&mut out);
        let mut writer =
            WavWriter::new(cursor, spec).map_err(|e| CoreError::Decode(format!("wav writer: {e}")))?;
        let n = buf.num_frames();
        for i in 0..n {
            for ch in &buf.channels {
                let s = (ch[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                writer
                    .write_sample(s)
                    .map_err(|e| CoreError::Decode(format!("wav write: {e}")))?;
            }
        }
        writer
            .finalize()
            .map_err(|e| CoreError::Decode(format!("wav finalize: {e}")))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_valid_wav_that_round_trips_via_hound_reader() {
        let mut buf = AudioBuffer::new(48000, 2, 100);
        for (i, s) in buf.channels[0].iter_mut().enumerate() {
            *s = (i as f32 / 100.0) - 0.5;
        }
        let bytes = encode_wav_i16(&buf).unwrap();
        assert!(bytes.len() > 44); // header + data
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");

        let reader = hound::WavReader::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, 48000);
        assert_eq!(reader.spec().channels, 2);
    }
}
