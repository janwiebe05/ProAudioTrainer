//! Integration tests against real audio, bypassing the Tauri IPC/webview
//! layer (see the plan doc for why: this headless container can't reliably
//! render or click through the webview). These call the same `*_impl`
//! functions the `#[tauri::command]` wrappers delegate to.

use crate::commands::eq::{eq_evaluate_impl, eq_random_impl};
use paw_core::exercise::eq::EqExercise;
use paw_core::store::{Store, Track};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Generates a fresh, self-contained synthetic test library: a ~35s
/// two-tone WAV with a slow amplitude envelope (long/varied enough to
/// exercise decode windowing, EQ, dynamics, pan/width and reverb
/// meaningfully), registered as a shared (owner=None, so visible to any
/// profile), active track in a fresh in-memory Store. No external fixture
/// or manual setup step needed — reproducible on any machine/CI.
fn test_library() -> (PathBuf, Store) {
    use std::f32::consts::PI;
    let dir = std::env::temp_dir().join(format!("paw-synth-lib-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    let sample_rate = 44_100u32;
    let n = (sample_rate as f64 * 35.0) as usize;
    let mut buf = paw_core::AudioBuffer::new(sample_rate, 2, n);
    for ch in buf.channels.iter_mut() {
        for (i, s) in ch.iter_mut().enumerate() {
            let t = i as f32 / sample_rate as f32;
            let tone = 0.3 * (2.0 * PI * 220.0 * t).sin() + 0.15 * (2.0 * PI * 880.0 * t).sin();
            let envelope = 0.3 + 0.7 * (0.5 + 0.5 * (2.0 * PI * 0.2 * t).sin());
            *s = tone * envelope;
        }
    }
    let bytes = paw_core::encode::encode_wav_i16(&buf).expect("synth fixture should encode");
    let filename = "track.wav";
    std::fs::write(dir.join(filename), bytes).expect("synth fixture should write");

    let db = Store::open_in_memory().expect("in-memory store should open");
    db.create_profile("Test Profile", "2026-01-01T00:00:00Z").expect("test profile should be creatable");
    db.add_track(&Track {
        id: "synthetic-track".to_string(),
        filename: filename.to_string(),
        original_name: "Synthetic Test Track.wav".to_string(),
        size: 0,
        duration: None,
        mime_type: Some("audio/wav".to_string()),
        active: true,
        owner: None,
        added_at: "2026-01-01T00:00:00Z".to_string(),
        source_path: None,
        folder_id: None,
    }).expect("registering the synthetic track should succeed");

    (dir, db)
}

/// Full vertical-slice pipeline test against real (synthetic) audio: DB
/// track lookup -> probe duration -> decode a clip -> generate an EQ
/// exercise -> render dry+wet -> write WAV files -> evaluate a guess.
#[test]
fn eq_random_then_evaluate_round_trip_against_real_audio() {
    let (lib_dir, db) = test_library();

    let cache_dir = PathBuf::from("/tmp/paw-test-cache");
    let _ = std::fs::remove_dir_all(&cache_dir);
    let exercises: Mutex<HashMap<String, EqExercise>> = Mutex::new(HashMap::new());

    let response = eq_random_impl(2, None, None, &lib_dir, &db, &cache_dir, &exercises)
        .expect("eq_random_impl should succeed against the synthetic test fixture");

    assert!(PathBuf::from(&response.dry_path).exists());
    assert!(PathBuf::from(&response.processed_path).exists());
    assert_eq!(response.level, 2);
    assert!(response.freq_min > 0.0 && response.freq_max > response.freq_min);

    let dry_size = std::fs::metadata(&response.dry_path).unwrap().len();
    let wet_size = std::fs::metadata(&response.processed_path).unwrap().len();
    assert!(dry_size > 500_000, "dry clip suspiciously small: {dry_size} bytes");
    assert!(wet_size > 500_000, "wet clip suspiciously small: {wet_size} bytes");

    assert_eq!(exercises.lock().unwrap().len(), 1);

    let target_freq = {
        let map = exercises.lock().unwrap();
        map.values().next().unwrap().freq
    };
    let result = eq_evaluate_impl(&response.exercise_id, target_freq, 1.0, &exercises)
        .expect("evaluate should succeed for a just-created exercise");
    assert!(result.hit);
    assert!(result.points > 0);
    assert_eq!(exercises.lock().unwrap().len(), 0, "exercise should be one-shot (removed after evaluate)");

    let second = eq_evaluate_impl(&response.exercise_id, target_freq, 1.0, &exercises);
    assert!(second.is_err());
}

#[test]
fn eq_random_fails_gracefully_on_empty_library() {
    let empty_dir = PathBuf::from("/tmp/paw-test-empty-library");
    std::fs::create_dir_all(&empty_dir).unwrap();
    let empty_db = Store::open_in_memory().unwrap(); // no tracks registered
    let cache_dir = PathBuf::from("/tmp/paw-test-cache-2");
    let exercises: Mutex<HashMap<String, EqExercise>> = Mutex::new(HashMap::new());

    let result = eq_random_impl(1, None, None, &empty_dir, &empty_db, &cache_dir, &exercises);
    assert!(result.is_err());
}

mod dynamics_tests {
    use super::test_library;
    use crate::commands::dynamics::dynamics_random_impl;
    use paw_core::exercise::dynamics::DynamicsExercise;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[test]
    fn dynamics_random_renders_real_clips() {
        let (lib_dir, db) = test_library();
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-dynamics");
        let exercises: Mutex<HashMap<String, DynamicsExercise>> = Mutex::new(HashMap::new());

        let response = dynamics_random_impl(1, &lib_dir, &db, &cache_dir, &exercises)
            .expect("dynamics_random_impl should succeed");
        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());
        assert_eq!(exercises.lock().unwrap().len(), 1);

        // Guard against the camelCase-vs-snake_case serialization bug found
        // during development (see camel_case_response_shape below): the
        // wire JSON must use the exact keys the frontend reads by dot
        // notation (effect, thresholdDb, attackMs, releaseMs, makeupDb,
        // guessMode, amountIndex, amountLabels, dryPath, processedPath).
        let json = serde_json::to_value(&response).unwrap();
        let obj = json.as_object().unwrap();
        for key in ["exerciseId", "dryPath", "processedPath", "effect", "thresholdDb",
                    "ratio", "attackMs", "releaseMs", "makeupDb", "guessMode",
                    "amountIndex", "amountLabels", "level"] {
            assert!(obj.contains_key(key), "missing expected camelCase key {key:?}, got {:?}", obj.keys().collect::<Vec<_>>());
        }
    }
}

mod reverb_tests {
    use super::test_library;
    use crate::commands::reverb::reverb_random_impl;
    use paw_core::exercise::reverb::ReverbExercise;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// The frontend root — reverb exercise::ir_rel_path strings already
    /// start with "/EchoThief/..." (matches lib.rs::resolve_content_dir).
    fn content_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("frontend")
    }

    #[test]
    fn reverb_random_convolves_against_a_real_ir() {
        let (lib_dir, db) = test_library();
        let content_dir = content_dir();
        assert!(content_dir.join("EchoThief").is_dir(), "EchoThief content dir missing under {content_dir:?}");
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-reverb");
        let exercises: Mutex<HashMap<String, ReverbExercise>> = Mutex::new(HashMap::new());

        let response = reverb_random_impl(1, &lib_dir, &db, &content_dir, &cache_dir, &exercises)
            .expect("reverb_random_impl should succeed against a real IR file");
        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());
        assert!(response.wet_mix > 0.0);
    }
}

mod panning_tests {
    use super::test_library;
    use crate::commands::panning::panning_random_impl;
    use paw_core::exercise::panning::PanningExercise;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[test]
    fn panning_random_renders_real_clips_with_camel_case_json() {
        let (lib_dir, db) = test_library();
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-panning");
        let exercises: Mutex<HashMap<String, PanningExercise>> = Mutex::new(HashMap::new());

        let response = panning_random_impl(1, &lib_dir, &db, &cache_dir, &exercises)
            .expect("panning_random_impl should succeed");
        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());

        let json = serde_json::to_value(&response).unwrap();
        let obj = json.as_object().unwrap();
        for key in ["exerciseId", "dryPath", "processedPath", "guessMode",
                    "zoneId", "panValue", "widthId", "width", "panZones", "widthSteps"] {
            assert!(obj.contains_key(key), "missing expected camelCase key {key:?}");
        }
    }
}

mod stereo_tests {
    use super::test_library;
    use crate::commands::stereo::stereo_random_impl;
    use paw_core::exercise::stereo::StereoExercise;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[test]
    fn stereo_random_renders_real_clips() {
        let (lib_dir, db) = test_library();
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-stereo");
        let exercises: Mutex<HashMap<String, StereoExercise>> = Mutex::new(HashMap::new());

        let response = stereo_random_impl(2, &lib_dir, &db, &cache_dir, &exercises)
            .expect("stereo_random_impl should succeed");
        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());
        assert!(!response.options.is_empty());
    }
}

mod transient_tests {
    use super::test_library;
    use crate::commands::transient::transient_random_impl;
    use paw_core::exercise::transient::TransientExercise;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[test]
    fn transient_random_renders_real_clips() {
        let (lib_dir, db) = test_library();
        let cache_dir = PathBuf::from("/tmp/paw-test-cache-transient");
        let exercises: Mutex<HashMap<String, TransientExercise>> = Mutex::new(HashMap::new());

        let response = transient_random_impl(3, &lib_dir, &db, &cache_dir, &exercises)
            .expect("transient_random_impl should succeed");
        assert!(PathBuf::from(&response.dry_path).exists());
        assert!(PathBuf::from(&response.processed_path).exists());
        assert!(!response.options.is_empty());
    }
}

mod eq_match_tests {
    use super::test_library;
    use crate::commands::eq_match::{eq_match_evaluate_impl, eq_match_random_impl};
    use paw_core::exercise::eq_match::{EqMatchExercise, UserBand};
    use std::collections::{BTreeMap, HashMap};
    use std::sync::Mutex;

    #[test]
    fn eq_match_random_then_evaluate_round_trip() {
        let (lib_dir, db) = test_library();
        let exercises: Mutex<HashMap<String, EqMatchExercise>> = Mutex::new(HashMap::new());

        // Unlike every other trainer, this returns the track's own
        // (unmodified) path directly — no rendering, no cache_dir needed.
        let response = eq_match_random_impl(2, &lib_dir, &db, &exercises)
            .expect("eq_match_random_impl should succeed");
        assert!(std::path::PathBuf::from(&response.dry_path).exists());
        assert_eq!(response.hidden_bands.len(), 4);
        assert_eq!(exercises.lock().unwrap().len(), 1);

        let json = serde_json::to_value(&response).unwrap();
        let obj = json.as_object().unwrap();
        for key in ["exerciseId", "dryPath", "level", "hiddenBands", "timeLimit", "userControlsFreq", "userControlsQ"] {
            assert!(obj.contains_key(key), "missing expected camelCase key {key:?}");
        }
        // Legacy JS shape: hiddenBands is keyed "1".."4", not a 0-indexed array.
        let hidden = obj.get("hiddenBands").unwrap().as_object().unwrap();
        for id in ["1", "2", "3", "4"] {
            assert!(hidden.contains_key(id), "hiddenBands missing key {id:?}");
        }

        // A guess matching every hidden band exactly should score high.
        let mut guesses = BTreeMap::new();
        for (id, band) in &{
            let map = exercises.lock().unwrap();
            map.values().next().unwrap().hidden_bands.clone()
        } {
            guesses.insert(*id, UserBand { gain: Some(-band.gain), frequency: Some(band.frequency), q: band.q });
        }
        let result = eq_match_evaluate_impl(&response.exercise_id, &guesses, 0.0, &exercises)
            .expect("evaluate should succeed for a just-created exercise");
        assert!(result.score >= 900, "near-perfect counter-EQ should score high, got {}", result.score);
        assert_eq!(exercises.lock().unwrap().len(), 0, "exercise should be one-shot");
    }
}

/// Guards against the exact bug found during development: a core Result
/// struct without #[serde(rename_all = "camelCase")] silently serializes as
/// snake_case, which the frontend (written expecting camelCase, matching
/// how Tauri auto-converts command *arguments*) would never notice until a
/// live click — return-value serialization is NOT auto-converted by Tauri,
/// unlike command arguments. Check every field name a JS module reads by
/// dot-notation off a `*_evaluate`/`*_random` response is actually camelCase
/// (or single-word, where casing is moot) in the wire JSON.
mod camel_case_response_shape {
    fn assert_has_camel_keys(value: &serde_json::Value, expected_keys: &[&str]) {
        let obj = value.as_object().expect("expected a JSON object");
        for key in expected_keys {
            assert!(
                obj.contains_key(*key),
                "expected camelCase key {key:?} in {obj:?} (found keys: {:?})",
                obj.keys().collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn eq_result_is_camel_case() {
        let r = paw_core::exercise::eq::EqResult {
            hit: true, correct_freq: 1000.0, guess_freq: 990.0,
            octave_dist: 0.01, points: 900, tolerance_octaves: 0.5,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_has_camel_keys(&v, &["hit", "correctFreq", "guessFreq", "octaveDist", "points", "toleranceOctaves"]);
    }

    #[test]
    fn dynamics_result_is_camel_case() {
        let r = paw_core::exercise::dynamics::DynamicsResult { score: 500, type_correct: true };
        let v = serde_json::to_value(&r).unwrap();
        assert_has_camel_keys(&v, &["score", "typeCorrect"]);
    }

    #[test]
    fn panning_result_fields_are_single_word_no_case_ambiguity() {
        let r = paw_core::exercise::panning::PanningResult { score: 1, correct: true };
        let v = serde_json::to_value(&r).unwrap();
        assert_has_camel_keys(&v, &["score", "correct"]);
    }
}
