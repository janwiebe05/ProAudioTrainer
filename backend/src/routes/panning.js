'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const path = require('path');
const fs   = require('fs');

const LIBRARY_FILE = path.join(__dirname, '..', 'data', 'library.json');
const EXERCISE_TTL = 30 * 60 * 1000;
const exerciseStore = new Map();

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); } catch { return []; }
}
function purgeExpired() {
  const now = Date.now();
  for (const [id, ex] of exerciseStore) if (now > ex.expiresAt) exerciseStore.delete(id);
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min, max) { return Math.round(Math.random() * (max - min) + min); }

// Level I: 7 discrete zones
const PAN_ZONES = [
  { id: 'L100', label: 'L 100', value: -100 },
  { id: 'L66',  label: 'L 66',  value: -66  },
  { id: 'L33',  label: 'L 33',  value: -33  },
  { id: 'C',    label: 'CENTER', value: 0   },
  { id: 'R33',  label: 'R 33',  value: 33   },
  { id: 'R66',  label: 'R 66',  value: 66   },
  { id: 'R100', label: 'R 100', value: 100  },
];

// Level III: 5 width categories
const WIDTH_STEPS = [
  { id: 'mono',       label: 'MONO',       value: 0   },
  { id: 'narrow',     label: 'SCHMAL',     value: 50  },
  { id: 'normal',     label: 'NORMAL',     value: 100 },
  { id: 'wide',       label: 'BREIT',      value: 150 },
  { id: 'very_wide',  label: 'SEHR BREIT', value: 200 },
];

// GET /api/panning/random?level=1|2|3
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();
  const library = loadLibrary();
  const pool = library.filter(e => e.active).length > 0 ? library.filter(e => e.active) : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });

  const audio = pick(pool);
  const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));

  let params, guessMode;

  if (level === 1) {
    // Pick a random zone, avoid CENTER too often (weight away from index 3)
    const weights = [2, 2, 2, 1, 2, 2, 2]; // CENTER less frequent
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, zoneIdx = 0;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { zoneIdx = i; break; } }
    const zone = PAN_ZONES[zoneIdx];
    params = { panValue: zone.value, zoneId: zone.id };
    guessMode = 'zone';
  } else if (level === 2) {
    // Full range, weighted away from -10..+10 (too easy)
    let panValue;
    do { panValue = rand(-100, 100); } while (Math.abs(panValue) < 15 && Math.random() < 0.7);
    params = { panValue };
    guessMode = 'value';
  } else {
    // Width: pick one of the 5 steps, avoid 'normal' too often
    const weights = [2, 2, 1, 2, 2];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, stepIdx = 0;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { stepIdx = i; break; } }
    const step = WIDTH_STEPS[stepIdx];
    params = { width: step.value, widthId: step.id };
    guessMode = 'width';
  }

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, { params, guessMode, audioId: audio.id, expiresAt: Date.now() + EXERCISE_TTL });

  res.json({
    exerciseId,
    audioUrl: `/api/library/${audio.id}/audio`,
    params,
    guessMode,
    panZones:    PAN_ZONES,
    widthSteps:  WIDTH_STEPS,
  });
});

// POST /api/panning/evaluate
router.post('/evaluate', authMiddleware, (req, res) => {
  const { exerciseId, guessZone, guessPan, guessWidth, secondsTaken } = req.body;
  const exercise = exerciseStore.get(exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Übung nicht gefunden oder abgelaufen' });
  exerciseStore.delete(exerciseId);

  const { params, guessMode } = exercise;
  const timeFactor = Math.max(0.3, 1 - (secondsTaken || 0) / 45);

  if (guessMode === 'zone') {
    const correctIdx = PAN_ZONES.findIndex(z => z.id === params.zoneId);
    const guessIdx   = PAN_ZONES.findIndex(z => z.id === guessZone);
    const diff = Math.abs(correctIdx - guessIdx);
    const correct = diff === 0;
    const partial = diff === 1; // adjacent zone = partial credit
    const score = Math.round((correct ? 1000 : partial ? 400 : 0) * timeFactor);
    return res.json({
      score, correct, guessMode,
      correctZone: PAN_ZONES[correctIdx],
      feedback: correct
        ? `Richtig: ${PAN_ZONES[correctIdx].label}`
        : `Falsch. Richtig: ${PAN_ZONES[correctIdx].label}${partial ? ' (Nachbarzone)' : ''}`,
    });
  }

  if (guessMode === 'value') {
    const diff = Math.abs((guessPan || 0) - params.panValue);
    const correct = diff <= 15;
    const partial = diff <= 30;
    const accuracy = Math.max(0, 1 - diff / 100);
    const score = Math.round(accuracy * 1000 * timeFactor);
    return res.json({
      score, correct, guessMode,
      correctValue: params.panValue,
      feedback: `Richtig: ${params.panValue > 0 ? 'R' : params.panValue < 0 ? 'L' : 'C'} ${Math.abs(params.panValue)} | Dein Wert: ${guessPan > 0 ? 'R' : guessPan < 0 ? 'L' : 'C'} ${Math.abs(guessPan || 0)}`,
    });
  }

  // width
  const correctStep = WIDTH_STEPS.find(s => s.id === params.widthId);
  const guessStep   = WIDTH_STEPS.find(s => s.id === guessWidth);
  const correctIdx  = WIDTH_STEPS.indexOf(correctStep);
  const guessIdx    = WIDTH_STEPS.indexOf(guessStep ?? WIDTH_STEPS[2]);
  const diff = Math.abs(correctIdx - guessIdx);
  const correct = diff === 0;
  const partial = diff === 1;
  const score = Math.round((correct ? 1000 : partial ? 400 : 0) * timeFactor);
  return res.json({
    score, correct, guessMode,
    correctWidth: correctStep,
    feedback: correct
      ? `Richtig: ${correctStep.label}`
      : `Falsch. Richtig: ${correctStep.label}${partial ? ' (Nachbarstufe)' : ''}`,
  });
});

module.exports = router;
