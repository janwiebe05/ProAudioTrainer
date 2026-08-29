//! Audio decoding via symphonia — no external ffmpeg/ffprobe binary needed.
//! This is the structural fix for the two bugs found in the legacy FFmpeg-CLI
//! approach: (1) ffmpeg-static ships no ffprobe binary, so duration probing
//! silently fell back to a hardcoded 30s for every track; (2) the reverb
//! filter `aconvolve` does not exist in FFmpeg at all. Both concerns are
//! replaced here by pure-Rust decoding + our own DSP (see dsp::reverb).

use crate::buffer::AudioBuffer;
use crate::error::{CoreError, Result};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

fn open_probed(path: &Path) -> Result<(Box<dyn symphonia::core::formats::FormatReader>, u32, usize)> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| CoreError::Decode(format!("probe failed for {}: {e}", path.display())))?;

    let format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| CoreError::UnsupportedFormat("no default track".into()))?;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| CoreError::UnsupportedFormat("unknown sample rate".into()))?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2);

    Ok((format, sample_rate, channels))
}

/// Full-file duration in seconds. Replaces the old ffprobe round-trip.
pub fn probe_duration_secs(path: &Path) -> Result<f64> {
    let (mut format, sample_rate, _channels) = open_probed(path)?;
    let track_id = format
        .default_track()
        .ok_or_else(|| CoreError::UnsupportedFormat("no default track".into()))?
        .id;

    // Prefer the container-reported duration (fast path, no full decode).
    if let Some(track) = format.tracks().iter().find(|t| t.id == track_id) {
        if let (Some(n_frames), Some(sr)) = (track.codec_params.n_frames, track.codec_params.sample_rate) {
            if sr > 0 {
                return Ok(n_frames as f64 / sr as f64);
            }
        }
    }

    // Fallback: decode packet timestamps to find the end (slower, rare path
    // for containers without an up-front frame count, e.g. some raw streams).
    let codec_params = format
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .unwrap()
        .codec_params
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| CoreError::Decode(e.to_string()))?;

    let mut last_ts = 0u64;
    loop {
        match format.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id {
                    continue;
                }
                last_ts = packet.ts();
                let _ = decoder.decode(&packet);
            }
            Err(_) => break,
        }
    }
    Ok(last_ts as f64 / sample_rate as f64)
}

/// Decode a time-windowed clip `[start_secs, start_secs + duration_secs)` from
/// `path` into a planar AudioBuffer. If the file is shorter than requested,
/// the returned buffer is simply shorter (never panics/errors on that).
pub fn decode_clip(path: &Path, start_secs: f64, duration_secs: f64) -> Result<AudioBuffer> {
    let (mut format, sample_rate, channels) = open_probed(path)?;
    let track = format
        .default_track()
        .ok_or_else(|| CoreError::UnsupportedFormat("no default track".into()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| CoreError::Decode(e.to_string()))?;

    let start_frame = (start_secs.max(0.0) * sample_rate as f64).round() as i64;
    let end_frame = start_frame + (duration_secs.max(0.0) * sample_rate as f64).round() as i64;

    let mut out = AudioBuffer::new(sample_rate, channels, 0);
    for c in out.channels.iter_mut() {
        c.reserve((end_frame - start_frame).max(0) as usize);
    }

    let mut frame_cursor: i64 = 0;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // EOF or unrecoverable — stop, return what we have
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue, // skip bad packet, keep going
        };

        let n_frames_in_packet = decoded.frames() as i64;
        let packet_start = frame_cursor;
        let packet_end = frame_cursor + n_frames_in_packet;
        frame_cursor = packet_end;

        if packet_end <= start_frame {
            continue; // entirely before the window
        }
        if packet_start >= end_frame {
            break; // entirely after the window — done
        }

        let local_start = (start_frame - packet_start).max(0) as usize;
        let local_end = (end_frame - packet_start).min(n_frames_in_packet) as usize;

        append_ref_range(&decoded, out.channels.len(), local_start, local_end, &mut out.channels);
    }

    Ok(out)
}

/// Copy samples[local_start..local_end] from every plane of `decoded` into
/// `dst` (one Vec<f32> per output channel — extra source channels beyond
/// `dst.len()` are dropped, missing ones are filled from channel 0).
fn append_ref_range(
    decoded: &AudioBufferRef,
    dst_channels: usize,
    local_start: usize,
    local_end: usize,
    dst: &mut [Vec<f32>],
) {
    macro_rules! copy_planes {
        ($buf:expr) => {{
            let spec_channels = $buf.spec().channels.count();
            for ch in 0..dst_channels {
                let src_ch = ch.min(spec_channels.saturating_sub(1));
                let plane = $buf.chan(src_ch);
                for i in local_start..local_end.min(plane.len()) {
                    dst[ch].push(plane[i] as f32);
                }
            }
        }};
    }

    match decoded {
        AudioBufferRef::U8(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            (s as f32 - 128.0) / 128.0
        }),
        AudioBufferRef::U16(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            (s as f32 - 32768.0) / 32768.0
        }),
        AudioBufferRef::U24(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            (s.inner() as f32 - 8_388_608.0) / 8_388_608.0
        }),
        AudioBufferRef::U32(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            (s as f64 - 2_147_483_648.0) as f32 / 2_147_483_648.0
        }),
        AudioBufferRef::S8(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            s as f32 / 128.0
        }),
        AudioBufferRef::S16(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            s as f32 / 32768.0
        }),
        AudioBufferRef::S24(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            s.inner() as f32 / 8_388_608.0
        }),
        AudioBufferRef::S32(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            s as f64 as f32 / 2_147_483_648.0
        }),
        AudioBufferRef::F32(b) => copy_planes!(b),
        AudioBufferRef::F64(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| {
            s as f32
        }),
    }
}

fn copy_planes_convert<S: symphonia::core::sample::Sample + Copy>(
    buf: &symphonia::core::audio::AudioBuffer<S>,
    dst_channels: usize,
    local_start: usize,
    local_end: usize,
    dst: &mut [Vec<f32>],
    convert: impl Fn(S) -> f32,
) {
    let spec_channels = buf.spec().channels.count();
    for ch in 0..dst_channels {
        let src_ch = ch.min(spec_channels.saturating_sub(1));
        let plane = buf.chan(src_ch);
        for i in local_start..local_end.min(plane.len()) {
            dst[ch].push(convert(plane[i]));
        }
    }
}
