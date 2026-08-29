//! Shared scoring helpers — the two time-factor formulas used across every
//! exercise route in the legacy JS backend.

/// Used by dynamics/panning/stereo/transient/reverb: `max(0.3, 1 - t/45)`.
pub fn time_factor_45(seconds_taken: f32) -> f32 {
    (1.0 - seconds_taken.max(0.0) / 45.0).max(0.3)
}

/// Used by EQ: `max(0, 1 - t/10)`.
pub fn time_factor_10(seconds_taken: f32) -> f32 {
    (1.0 - seconds_taken.max(0.0) / 10.0).max(0.0)
}

/// Fixed exercise-clip length, matches the legacy CLIP_DURATION.
pub const CLIP_DURATION_SECS: f64 = 20.0;
