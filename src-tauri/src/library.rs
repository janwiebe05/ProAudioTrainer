//! Minimal local audio library — scans a directory for audio files and picks
//! one at random. This is the placeholder for the planned SQLite-backed
//! library service (shared/school vs. private tracks); the interface here
//! (`pick_random_track`) is deliberately small so swapping the backing store
//! later doesn't touch the command layer.

use rand::Rng;
use std::fs;
use std::path::{Path, PathBuf};

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "ogg", "m4a", "aac"];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn scan_tracks(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    scan_dir_recursive(dir, &mut out);
    out
}

fn scan_dir_recursive(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir_recursive(&path, out);
        } else if is_audio_file(&path) {
            out.push(path);
        }
    }
}

pub fn pick_random_track(dir: &Path, rng: &mut impl Rng) -> Option<PathBuf> {
    let tracks = scan_tracks(dir);
    if tracks.is_empty() {
        return None;
    }
    Some(tracks[rng.gen_range(0..tracks.len())].clone())
}
