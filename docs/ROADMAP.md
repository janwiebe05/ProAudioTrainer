# Roadmap

Product-direction notes from a planning conversation (2026-08-30) about
where this stands relative to SoundGym.co and what's specifically valuable
for a Tontechnikerschule audience. Nothing here is scheduled — this is a
backlog to work through later, roughly in the order listed within each
section.

## Confirmed — do these

### Must-have

- **Content-pack versioning** — largely covered by *linked folders*
  (Sound Library → "Ordner verknüpfen"): a folder, e.g. a school NAS, is
  registered in place instead of copied, files are identified by their
  path, and "Aktualisieren" adds new files / drops deleted ones without
  duplicates. What is still open is the *copy* import ("Ordner kopieren"):
  re-importing an updated pack copies everything again under new ids. Fix
  when needed: identify copied files by relative path + content hash, or
  simply steer packs to linking. Linked folders are re-read automatically
  (shortly after startup, then every 5 minutes; new files appear, deleted
  ones vanish, an offline share keeps its entries). They are per machine (each
  install links its own path) and shared by all profiles on it.

### Should-have

- **Phase/comb-filter trainer + mono-compatibility check.** No standalone
  echo trainer planned (see declined, below), so this needs its own small
  `paw-core::dsp::delay` — but a much narrower one than a general-purpose
  echo effect: just a single short delay tap (sub-20ms) plus a
  polarity-invert flag, tuned specifically for audible comb-filtering/
  phase-cancellation, not a musical echo with feedback/repeats. Mono
  compatibility (stereo source summed to mono, judge how much is lost) can
  reuse the existing `dsp::stereo_width` code almost as-is — mostly a new
  exercise flow, very little new DSP.

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

- **Delay/Echo Trainer** (standalone musical-echo module). Not needed.
- **Reference-track comparison** (even the light, non-mixer version).
  Leave out for now.
- **Leaderboards/competitions.** Doesn't fit the local-first, per-profile
  model as it stands. Could reconsider *only* as an opt-in, lightweight
  classroom view for a teacher later — not planned now.
- **LUFS/loudness trainer as its own module.** Not a priority right now.
- **Full "remix to match a reference" mixer.** Real DAW-lite scope
  (multitrack input, per-channel strips, live mixing UI) — not worth the
  effort for what this app is.

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
