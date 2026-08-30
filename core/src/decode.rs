//! Audio decoding via symphonia — no external ffmpeg/ffprobe binary needed.
//! This is the structural fix for the two bugs found in the legacy FFmpeg-CLI
//! approach: (1) ffmpeg-static ships no ffprobe binary, so duration probing
//! silently fell back to a hardcoded 30s for every track; (2) the reverb
//! filter `aconvolve` does not exist in FFmpeg at all. Both concerns are
//! replaced here by pure-Rust decoding + our own DSP (see dsp::reverb).
//!
//! Every public entry point here opens the file exactly once — earlier
//! versions had callers separately call `probe_duration_secs` then
//! `decode_clip`, each doing its own `File::open` + format probe on the
//! same file.

use crate::buffer::AudioBuffer;
use crate::error::{CoreError, Result};
use rand::Rng;
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{CodecParameters, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// An opened, probed file: format reader plus everything decode_clip-style
/// functions need, gathered in one probe pass.
struct OpenedTrack {
    format: Box<dyn FormatReader>,
    track_id: u32,
    codec_params: CodecParameters,
    sample_rate: u32,
    channels: usize,
    /// Container-reported duration, when available without a full decode
    /// (the common case for WAV/MP3/FLAC/OGG headers with a frame count).
    known_duration_secs: Option<f64>,
}

fn open_and_probe(path: &Path) -> Result<OpenedTrack> {
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
    // A malformed header can report Some(0) rather than None — reject it
    // explicitly, since 0 silently divides-by-zero downstream (e.g.
    // dsp::dynamics's one_pole_coeff) instead of failing loudly here.
    if sample_rate == 0 {
        return Err(CoreError::UnsupportedFormat("sample rate is zero".into()));
    }
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let known_duration_secs = match (codec_params.n_frames, codec_params.sample_rate) {
        (Some(n_frames), Some(sr)) if sr > 0 => Some(n_frames as f64 / sr as f64),
        _ => None,
    };

    Ok(OpenedTrack { format, track_id, codec_params, sample_rate, channels, known_duration_secs })
}

/// Duration in seconds, decoding packet timestamps to find the end only if
/// the container didn't report a frame count up front.
fn resolve_duration(opened: &mut OpenedTrack) -> Result<f64> {
    if let Some(d) = opened.known_duration_secs {
        return Ok(d);
    }
    // Rare fallback path: some containers/raw streams don't carry an
    // up-front frame count. Has to actually decode every packet to find
    // the last timestamp — inherently a full scan, no way around it.
    let mut decoder = symphonia::default::get_codecs()
        .make(&opened.codec_params, &DecoderOptions::default())
        .map_err(|e| CoreError::Decode(e.to_string()))?;
    let mut last_ts = 0u64;
    while let Ok(packet) = opened.format.next_packet() {
        if packet.track_id() != opened.track_id {
            continue;
        }
        last_ts = packet.ts();
        let _ = decoder.decode(&packet);
    }
    Ok(last_ts as f64 / opened.sample_rate as f64)
}

/// Full-file duration in seconds. Replaces the old ffprobe round-trip.
pub fn probe_duration_secs(path: &Path) -> Result<f64> {
    let mut opened = open_and_probe(path)?;
    resolve_duration(&mut opened)
}

/// Decode every packet of `opened` into a planar AudioBuffer, keeping only
/// frames within `[start_frame, end_frame)`. `end_frame` may be
/// `i64::MAX` to mean "to EOF".
fn decode_window(mut opened: OpenedTrack, start_frame: i64, end_frame: i64) -> Result<AudioBuffer> {
    let mut decoder = symphonia::default::get_codecs()
        .make(&opened.codec_params, &DecoderOptions::default())
        .map_err(|e| CoreError::Decode(e.to_string()))?;

    let mut out = AudioBuffer::new(opened.sample_rate, opened.channels, 0);
    if end_frame != i64::MAX {
        for c in out.channels.iter_mut() {
            c.reserve((end_frame - start_frame).max(0) as usize);
        }
    }

    let mut frame_cursor: i64 = 0;
    loop {
        let packet = match opened.format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // EOF or unrecoverable — stop, return what we have
        };
        if packet.track_id() != opened.track_id {
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
        let local_end = (end_frame - packet_start).clamp(0, n_frames_in_packet) as usize;

        append_ref_range(&decoded, out.channels.len(), local_start, local_end, &mut out.channels);
    }

    Ok(out)
}

/// Decode an entire file in one open — no pass to probe duration first
/// (used for short assets like impulse responses, where windowing isn't
/// needed and the container's frame count doesn't even need to be read).
pub fn decode_full(path: &Path) -> Result<AudioBuffer> {
    let opened = open_and_probe(path)?;
    decode_window(opened, 0, i64::MAX)
}

/// Decode a time-windowed clip `[start_secs, start_secs + duration_secs)` from
/// `path` into a planar AudioBuffer, in one open+probe pass. If the file is
/// shorter than requested, the returned buffer is simply shorter (never
/// panics/errors on that).
pub fn decode_clip(path: &Path, start_secs: f64, duration_secs: f64) -> Result<AudioBuffer> {
    let opened = open_and_probe(path)?;
    let sample_rate = opened.sample_rate;
    let start_frame = (start_secs.max(0.0) * sample_rate as f64).round() as i64;
    let end_frame = start_frame + (duration_secs.max(0.0) * sample_rate as f64).round() as i64;
    decode_window(opened, start_frame, end_frame)
}

/// Pick a random `window_secs`-long clip from `path` and decode it — the
/// single-open replacement for the old "probe_duration_secs then
/// decode_clip" two-call, two-open pattern every *_random command used.
pub fn decode_random_window(path: &Path, window_secs: f64, rng: &mut impl Rng) -> Result<AudioBuffer> {
    let mut opened = open_and_probe(path)?;
    let duration_secs = resolve_duration(&mut opened)?;
    let sample_rate = opened.sample_rate;

    let start_secs = rng.gen::<f64>() * (duration_secs - window_secs).max(0.0);
    let start_frame = (start_secs * sample_rate as f64).round() as i64;
    let end_frame = start_frame + (window_secs.max(0.0) * sample_rate as f64).round() as i64;
    decode_window(opened, start_frame, end_frame)
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
        // F32 is the identity conversion — reuse the same generic path
        // instead of a separate hand-rolled loop that used to duplicate it.
        AudioBufferRef::F32(b) => copy_planes_convert(b, dst_channels, local_start, local_end, dst, |s| s),
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
