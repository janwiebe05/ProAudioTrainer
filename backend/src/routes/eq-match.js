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
function rand(min, max, decimals = 1) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}
function randInt(min, max) { return Math.round(Math.random() * (max - min) + min); }

// ─── Band Definitions ────────────────────────────────────────────────────────
const BAND_DEFS = {
  1: { type: 'lowshelf',  label: 'LOW SHELF',  freqRange: [40, 300],    qRange: null },
  2: { type: 'peaking',   label: 'LOW MID',    freqRange: [200, 1200],  qRange: [0.5, 4.0] },
  3: { type: 'peaking',   label: 'HIGH MID',   freqRange: [1000, 8000], qRange: [0.5, 4.0] },
  4: { type: 'highshelf', label: 'HIGH SHELF', freqRange: [4000, 16000], qRange: null },
};

// ─── Level Configuration ─────────────────────────────────────────────────────
// Level 1: 1-2 bands, large gain, fixed freq, no Q control, no time limit
// Level 2: 2-3 bands, moderate gain, variable freq+Q, no time limit
// Level 3: all 4 bands, subtle gain, variable freq+Q, 90s time limit
const LEVEL_CONFIG = {
  1: {
    minBands: 1, maxBands: 2,
    gainRange: [6, 12],
    fixedQ: 1.0,
    fixedFreq: true,
    userControlsFreq: false,
    userControlsQ: false,
    timeLimit: null,
  },
  2: {
    minBands: 2, maxBands: 3,
    gainRange: [3, 8],
    fixedQ: null,
    fixedFreq: false,
    userControlsFreq: true,
    userControlsQ: true,
    timeLimit: null,
  },
  3: {
    minBands: 4, maxBands: 4,
    gainRange: [2, 5],
    fixedQ: null,
    fixedFreq: false,
    userControlsFreq: true,
    userControlsQ: true,
    timeLimit: 90,
  },
};

// Fixed center frequencies for Level 1
const FIXED_FREQS = { 1: 100, 2: 500, 3: 3000, 4: 8000 };

function generateHiddenEQ(level) {
  const config = LEVEL_CONFIG[level];
  const allBands = [1, 2, 3, 4];

  const count = randInt(config.minBands, config.maxBands);
  const shuffled = [...allBands].sort(() => Math.random() - 0.5);
  const activeBandIds = level === 3 ? allBands : shuffled.slice(0, count);

  const bands = {};
  for (const bandId of allBands) {
    const def = BAND_DEFS[bandId];
    const isActive = activeBandIds.includes(bandId);

    if (!isActive) {
      const centerFreq = config.fixedFreq ? FIXED_FREQS[bandId] : Math.round((def.freqRange[0] + def.freqRange[1]) / 2);
      bands[bandId] = {
        type: def.type, label: def.label,
        frequency: centerFreq, gain: 0,
        Q: def.qRange ? 1.0 : null,
        active: false,
      };
      continue;
    }

    const freq = config.fixedFreq ? FIXED_FREQS[bandId] : randInt(def.freqRange[0], def.freqRange[1]);
    const absGain = rand(config.gainRange[0], config.gainRange[1], 1);
    const gain = Math.random() < 0.5 ? absGain : -absGain;
    let Q = null;
    if (def.qRange) {
      Q = config.fixedQ !== null ? config.fixedQ : rand(def.qRange[0], def.qRange[1], 1);
    }

    bands[bandId] = { type: def.type, label: def.label, frequency: freq, gain, Q, active: true };
  }
  return bands;
}

// ─── GET /api/eq-match/random?level=1|2|3 ───────────────────────────────────
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();
  const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));
  const config = LEVEL_CONFIG[level];

  const library = loadLibrary();
  const active = library.filter(e => e.active);
  const pool = active.length > 0 ? active : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });

  const audio = pick(pool);
  const hiddenBands = generateHiddenEQ(level);

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, {
    hiddenBands, level, audioId: audio.id,
    expiresAt: Date.now() + EXERCISE_TTL,
  });

  res.json({
    exerciseId,
    audioUrl: `/api/library/${audio.id}/audio`,
    hiddenBands,
    level,
    timeLimit: config.timeLimit,
    userControlsFreq: config.userControlsFreq,
    userControlsQ: config.userControlsQ,
    bandDefs: BAND_DEFS,
  });
});

// ─── POST /api/eq-match/evaluate ─────────────────────────────────────────────
router.post('/evaluate', authMiddleware, (req, res) => {
  const { exerciseId, userBands, secondsTaken } = req.body;

  const exercise = exerciseStore.get(exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Übung nicht gefunden oder abgelaufen' });
  exerciseStore.delete(exerciseId);

  const { hiddenBands, level } = exercise;
  const config = LEVEL_CONFIG[level];

  const bandResults = {};
  let totalScore = 0;
  let bandCount = 0;

  for (const bandId of [1, 2, 3, 4]) {
    const hidden = hiddenBands[bandId];
    const user = userBands?.[bandId] || { gain: 0, frequency: hidden.frequency, Q: hidden.Q };

    if (!hidden.active) {
      const gainDiff = Math.abs(user.gain || 0);
      const gainScore = Math.max(0, 1 - gainDiff / 3);
      bandResults[bandId] = {
        active: false, hiddenGain: 0, userGain: user.gain || 0, idealGain: 0,
        gainScore, score: Math.round(gainScore * 1000),
      };
      totalScore += gainScore;
      bandCount++;
      continue;
    }

    const idealGain = -hidden.gain;
    const gainDiff = Math.abs((user.gain || 0) - idealGain);

    let gainScore;
    if (gainDiff <= 1.5) gainScore = 1.0;
    else if (gainDiff <= 3.0) gainScore = 1.0 - (gainDiff - 1.5) / 3.0;
    else gainScore = Math.max(0, 0.5 - (gainDiff - 3.0) / 12.0);

    let freqScore = 1.0;
    let qScore = 1.0;

    if (config.userControlsFreq && hidden.frequency) {
      const freqDiffOctaves = Math.abs(Math.log2((user.frequency || hidden.frequency) / hidden.frequency));
      freqScore = freqDiffOctaves <= 0.25 ? 1.0 : Math.max(0, 1.0 - (freqDiffOctaves - 0.25) / 1.5);
    }

    if (config.userControlsQ && hidden.Q !== null) {
      const qDiff = Math.abs((user.Q || 1.0) - hidden.Q);
      qScore = qDiff <= 0.5 ? 1.0 : Math.max(0, 1.0 - (qDiff - 0.5) / 3.0);
    }

    const hasQ = hidden.Q !== null && config.userControlsQ;
    const hasFreq = config.userControlsFreq;
    let bandScore;
    if (hasFreq && hasQ) bandScore = gainScore * 0.55 + freqScore * 0.30 + qScore * 0.15;
    else if (hasFreq) bandScore = gainScore * 0.65 + freqScore * 0.35;
    else bandScore = gainScore;

    bandResults[bandId] = {
      active: true, type: hidden.type,
      hiddenFreq: hidden.frequency, hiddenGain: hidden.gain, hiddenQ: hidden.Q,
      userFreq: user.frequency, userGain: user.gain || 0, userQ: user.Q,
      idealGain: idealGain,
      gainScore: parseFloat(gainScore.toFixed(3)),
      freqScore: hasFreq ? parseFloat(freqScore.toFixed(3)) : null,
      qScore: hasQ ? parseFloat(qScore.toFixed(3)) : null,
      bandScore: parseFloat(bandScore.toFixed(3)),
      score: Math.round(bandScore * 1000),
    };

    totalScore += bandScore;
    bandCount++;
  }

  const maxTime = config.timeLimit || 120;
  const timeFactor = config.timeLimit ? Math.max(0.3, 1 - (secondsTaken || 0) / maxTime) : 1.0;
  const avgScore = bandCount > 0 ? totalScore / bandCount : 0;
  const finalScore = Math.round(avgScore * 1000 * timeFactor);

  res.json({
    score: finalScore,
    timeFactor: parseFloat(timeFactor.toFixed(3)),
    secondsTaken, bandResults, hiddenBands,
  });
});

module.exports = router;
