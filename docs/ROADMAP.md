# Roadmap

Product-direction notes from a planning conversation (2026-08-30) about
where this stands relative to SoundGym.co and what's specifically valuable
for a Tontechnikerschule audience. Nothing here is scheduled — this is a
backlog to work through later, roughly in the order listed within each
section.

## Confirmed — do these

### Must-have

- **Content-pack versioning.** `library_import_shared_folder` currently
  re-imports every file with a fresh id on each run — reimporting an
  updated shared pack (e.g. the school pushes a revised sample folder)
  creates duplicates instead of merging/updating. Needs some stable
  identity for an imported file (path-relative-to-pack + a content hash,
  most likely) so a re-import can detect "this file already exists,
  skip/update" vs. "this is new, add it", and probably a notion of "which
  pack does this shared track belong to" so a pack can be removed/replaced
  as a unit later.

### Should-have

- **Delay/Echo Trainer.** The one classic SoundGym module with no
  equivalent here. Needs a new `paw-core::dsp::delay` (a delay line with
  feedback — much simpler than the reverb convolution, no FFT needed) and
  a new `paw-core::exercise::delay` following the existing dynamics-style
  level pattern (L1 type-only, L2 discrete time/feedback buckets, L3 exact
  ms values). Fits the established `render_random_exercise` pattern
  directly.

- **Phase/comb-filter trainer + mono-compatibility check.** Reuses the
  delay-line DSP built for the item above, just tuned to sub-20ms ranges
  plus a polarity-invert flag, instead of a separate DSP module. Mono
  compatibility (stereo source summed to mono, judge how much is lost) can
  reuse the existing `dsp::stereo_width` code almost as-is — mostly a new
  exercise flow, very little new DSP. Do this together with the delay
  trainer, not before it.

- **Golden Ears-style composite score.** An aggregate certification/rank
  computed across all modules' `progress_overview()` data (already scoped
  per profile) rather than a new DSP concern — mostly a store query
  (weighted composite of per-module best/average scores) plus a dashboard
  view. Natural fit once there are 8-9 modules instead of 6.

- **Adaptive difficulty.** Instead of the student manually picking level
  1/2/3, adjust level automatically based on recent performance (e.g.
  rolling accuracy over the last N rounds in a module). Needs a small
  amount of new state (recent-round history per module, already
  reconstructable from `scores`) and a level-selection policy in the
  frontend or a new command; the existing three-level generate() functions
  don't need to change, only how a level gets chosen per round.

- **Reference-track comparison (light version, not a full mixer).**
  Explicitly *not* "remix stems until it matches a reference" (that's a
  DAW-lite feature, real effort, not recommended). Instead: load two
  finished files (the student's own mix + a reference), compute/display
  loudness (RMS at least, LUFS if the loudness-trainer work below happens
  first), a coarse frequency-balance comparison, and stereo width/
  correlation — plus a light ear-training quiz ("which one is louder /
  brighter / wider?") built from the student's own uploaded pairs. No new
  effect chain, just analysis of two already-rendered files.

- **Noise/hum identification trainer.** Recognizing 50/60Hz mains hum,
  ground-loop noise, etc. — relevant for live sound and broadcast work.
  Needs synthesized/library noise beds mixed into a clip at varying levels
  for the student to identify; scope not detailed yet, revisit when
  picked up.

- **Calibration reminder.** A short onboarding/pre-session prompt (and
  optionally a reference tone, e.g. pink noise at a known relative level)
  reminding the student to set a consistent monitoring level before
  training — human hearing's frequency perception shifts with playback
  volume (equal-loudness contours), so unlevelled sessions produce
  inconsistent training data. No new DSP, a UI addition plus maybe a
  simple tone generator.

## Explicitly declined for now

- **Leaderboards/competitions.** Doesn't fit the local-first, per-profile
  model as it stands. Could reconsider *only* as an opt-in, lightweight
  classroom view for a teacher later — not planned now.
- **LUFS/loudness trainer as its own module.** Not a priority right now.
  (Note: if the reference-track comparison above eventually wants real
  LUFS instead of RMS, that's a small, separable addition to revisit then
  — not blocking.)
- **Full "remix to match a reference" mixer.** Real DAW-lite scope
  (multitrack input, per-channel strips, live mixing UI) — not worth the
  effort for what this app is. The light comparison version above covers
  the valuable part of this idea instead.

## Still open / not yet decided

Carried over from an earlier review pass, not yet confirmed either way:

- **Practice vs. assessment mode.** A fixed-round, no-retry, exportable-
  result mode distinct from free practice — relevant if the school wants
  to grade sessions, not just let students train freely.
- **Progress export.** PDF/CSV report of training history, for a student
  portfolio or teacher assessment.
- **Accessibility.** Keyboard navigation only exists in the EQ trainer
  today (the `n` shortcut); nothing elsewhere. Worth a pass if the school
  context requires it.

## User will handle separately (not this app's dev work)

- Real Windows/macOS builds via the CI workflow, tested on actual hardware.
- Listening-test verification of `dsp::reverb`'s energy-based IR
  normalization across categories (see the code-review discussion from
  2026-08-30 — deliberately not changed blind).

## Known technical backlog (lower priority, no product impact)

From the full code-review pass on 2026-08-30, already fixed where they
were real bugs; these are the remaining non-urgent items:

- Exercise-store entries (`eq_exercises`, `dynamics_exercises`, etc.) have
  no TTL — an abandoned round (never submitted) stays in memory for the
  life of the process. Low impact for a single-session desktop app, worth
  a cheap sweep-on-insert if it's ever noticed in practice.
- The AB-toggle/round-timer boilerplate in dynamics/panning/stereo/
  transient/reverb-trainer.js is still hand-rolled per module; a shared
  `RoundTimer` class already exists in `frontend/shared/dry-wet-player.js`
  for future modules to use, but the five existing ones weren't migrated
  (deliberately, to avoid an unreviewed behavior change across five
  working files in the same pass that added the helper).
