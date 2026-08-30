//! Exercise generation & scoring — ported 1:1 from the legacy JS routes
//! (backend/src/routes/{eq,dynamics,panning,stereo,transient,reverb}.js).
//! Each submodule owns its level configs/presets, a `generate()` (random
//! exercise for a level), a `render()` (dry buffer → processed buffer via
//! the DSP in `crate::dsp`), and an `evaluate()` (scoring).

pub mod common;
pub mod dynamics;
pub mod eq;
pub mod eq_match;
pub mod panning;
pub mod reverb;
pub mod stereo;
pub mod transient;
