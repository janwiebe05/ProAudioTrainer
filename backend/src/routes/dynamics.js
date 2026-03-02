'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middleware/auth');

const LIBRARY_FILE = path.join(__dirname, '..', 'data', 'library.json');
const EXERCISE_TTL = 30 * 60 * 1000;
const exerciseStore = new Map();

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); }
  catch { return []; }
}

function rand(min, max, decimals = 1) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

// ─── Level 1: "type-only" — offensichtliche Einstellungen, random ────────────
const PRESETS_L1 = {
  compressor: { threshold: [-45, -28], ratio: [5, 8],   attack: [5, 20],  release: [80, 200],  makeup: [6, 14] },
  limiter:    { threshold: [-6,  -1],  ratio: [18, 20],  attack: [0.1, 1], release: [50, 150],  makeup: [0, 4]  },
  gate:       { threshold: [-45, -25], ratio: [16, 20],  attack: [1, 5],   release: [150, 350], makeup: [0, 4]  },
  expander:   { threshold: [-38, -20], ratio: [3, 6],   attack: [10, 40], release: [100, 280], makeup: [2, 8]  },
};

// ─── Level 2: "type-amount" — 4 diskrete Stärken ────────────────────────────
const AMOUNT_LABELS = ['leicht', 'mittel', 'stark', 'sehr stark'];
const AMOUNT_PRESETS = {
  compressor: [
    { threshold: -15, ratio: 2,   attack: 30,  release: 250, makeupGain: 1 },
    { threshold: -24, ratio: 4,   attack: 15,  release: 150, makeupGain: 4 },
    { threshold: -32, ratio: 6,   attack: 8,   release: 100, makeupGain: 8 },
    { threshold: -42, ratio: 8,   attack: 4,   release: 80,  makeupGain: 12 },
  ],
  limiter: [
    { threshold: -3,  ratio: 20,  attack: 1,   release: 100, makeupGain: 1 },
    { threshold: -6,  ratio: 20,  attack: 0.5, release: 80,  makeupGain: 2 },
    { threshold: -9,  ratio: 20,  attack: 0.2, release: 60,  makeupGain: 4 },
    { threshold: -12, ratio: 20,  attack: 0.1, release: 50,  makeupGain: 6 },
  ],
  gate: [
    { threshold: -50, ratio: 10,  attack: 5,   release: 300, makeupGain: 0 },
    { threshold: -38, ratio: 15,  attack: 3,   release: 200, makeupGain: 0 },
    { threshold: -28, ratio: 18,  attack: 2,   release: 120, makeupGain: 0 },
    { threshold: -18, ratio: 20,  attack: 1,   release: 80,  makeupGain: 0 },
  ],
  expander: [
    { threshold: -18, ratio: 1.5, attack: 50,  release: 350, makeupGain: 1 },
    { threshold: -28, ratio: 2,   attack: 30,  release: 220, makeupGain: 3 },
    { threshold: -38, ratio: 2.5, attack: 15,  release: 150, makeupGain: 5 },
    { threshold: -46, ratio: 3,   attack: 8,   release: 100, makeupGain: 8 },
  ],
};

// ─── Level 3: "type-params" — subtile Zufalls-Einstellungen ─────────────────
const PRESETS_L3 = {
  compressor: { threshold: [-30, -10], ratio: [2, 5],    attack: [3, 80],  release: [50, 400],  makeup: [1, 8]  },
  limiter:    { threshold: [-14, -1],  ratio: [12, 20],  attack: [0.1, 3], release: [30, 250],  makeup: [0, 8]  },
  gate:       { threshold: [-60, -15], ratio: [10, 20],  attack: [1, 15],  release: [80, 500],  makeup: [0, 8]  },
  expander:   { threshold: [-50, -10], ratio: [2, 5],   attack: [5, 90],  release: [60, 500],  makeup: [0, 10] },
};

const LEVEL_EFFECTS = {
  1: ['compressor', 'limiter', 'gate', 'expander'],
  2: ['compressor', 'limiter', 'gate', 'expander'],
  3: ['compressor', 'limiter', 'gate', 'expander'],
};

function purgeExpired() {
  const now = Date.now();
  for (const [id, ex] of exerciseStore) {
    if (now > ex.expiresAt) exerciseStore.delete(id);
  }
}

// ─── GET /api/dynamics/random?level=1|2|3 ───────────────────────────────────
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();

  const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));
  const library = loadLibrary();
  const active = library.filter(e => e.active);
  const pool = active.length > 0 ? active : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });

  const audio = pool[Math.floor(Math.random() * pool.length)];
  const effects = LEVEL_EFFECTS[level];
  const effectType = effects[Math.floor(Math.random() * effects.length)];

  let params, guessMode, amountIndex = null;

  if (level === 1) {
    guessMode = 'type-only';
    const r = PRESETS_L1[effectType];
    params = {
      threshold:  rand(r.threshold[0], r.threshold[1], 0),
      ratio:      rand(r.ratio[0],     r.ratio[1],     1),
      attack:     rand(r.attack[0],    r.attack[1],    1),
      release:    rand(r.release[0],   r.release[1],   0),
      makeupGain: rand(r.makeup[0],    r.makeup[1],    1),
    };
  } else if (level === 2) {
    guessMode = 'type-amount';
    amountIndex = Math.floor(Math.random() * 4);
    params = { ...AMOUNT_PRESETS[effectType][amountIndex] };
  } else {
    guessMode = 'type-params';
    const r = PRESETS_L3[effectType];
    params = {
      threshold:  rand(r.threshold[0], r.threshold[1], 0),
      ratio:      rand(r.ratio[0],     r.ratio[1],     1),
      attack:     rand(r.attack[0],    r.attack[1],    1),
      release:    rand(r.release[0],   r.release[1],   0),
      makeupGain: rand(r.makeup[0],    r.makeup[1],    1),
    };
  }

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, {
    effectType, params, amountIndex, guessMode, audioId: audio.id,
    expiresAt: Date.now() + EXERCISE_TTL,
  });

  res.json({
    exerciseId,
    audioId: audio.id,
    audioUrl: `/api/library/${audio.id}/audio`,
    effectType,
    params,
    guessMode,
    amountIndex,
    amountLabels: AMOUNT_LABELS,
    availableEffects: LEVEL_EFFECTS[level],
  });
});

// ─── POST /api/dynamics/evaluate ─────────────────────────────────────────────
router.post('/evaluate', authMiddleware, (req, res) => {
  const { exerciseId, guessType, guessAmount, guessThreshold, guessRatio,
          guessAttack, guessRelease, guessGain, secondsTaken } = req.body;

  const exercise = exerciseStore.get(exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Übung nicht gefunden oder abgelaufen' });
  exerciseStore.delete(exerciseId);

  const { effectType, params, amountIndex, guessMode } = exercise;
  const typeCorrect = guessType === effectType;
  const timeFactor = Math.max(0.3, 1 - (secondsTaken || 0) / 45);
  const typeNames = { compressor: 'COMPRESSOR', limiter: 'LIMITER', gate: 'GATE', expander: 'EXPANDER' };

  // ── Level 1: nur Effekttyp ────────────────────────────────────────────────
  if (guessMode === 'type-only') {
    const score = Math.round((typeCorrect ? 1000 : 0) * timeFactor);
    return res.json({
      score, typeCorrect, guessMode, effectType,
      params, amountIndex: null,
      feedback: {
        type: typeCorrect
          ? `Richtig: ${typeNames[effectType]}`
          : `Falsch. Es war: ${typeNames[effectType]}`,
      },
    });
  }

  // ── Level 2: Typ + Stärke ─────────────────────────────────────────────────
  if (guessMode === 'type-amount') {
    const amountCorrect = parseInt(guessAmount, 10) === amountIndex;
    const amountDiff = Math.abs(parseInt(guessAmount, 10) - amountIndex);
    const amountScore = amountDiff === 0 ? 600 : amountDiff === 1 ? 300 : 0;
    const score = Math.round((typeCorrect ? 400 : 0) + amountScore) * timeFactor;
    return res.json({
      score: Math.round(score), typeCorrect, guessMode, effectType,
      params, amountIndex,
      feedback: {
        type: typeCorrect ? `Richtig: ${typeNames[effectType]}` : `Falsch. Es war: ${typeNames[effectType]}`,
        amount: amountCorrect
          ? `Stärke korrekt: ${AMOUNT_LABELS[amountIndex]}`
          : `Stärke: du hast ${AMOUNT_LABELS[guessAmount] || '?'} gewählt, richtig wäre ${AMOUNT_LABELS[amountIndex]}`,
      },
    });
  }

  // ── Level 3: Effekt-spezifische Parameter ────────────────────────────────
  // Which params each effect type actually uses
  const EFFECT_EVAL_PARAMS = {
    compressor: ['threshold', 'ratio', 'attack', 'release', 'makeupGain'],
    limiter:    ['threshold', 'attack', 'release', 'makeupGain'],
    gate:       ['threshold', 'ratio', 'attack', 'release'],
    expander:   ['threshold', 'ratio', 'attack', 'release'],
  };

  const r = PRESETS_L3[effectType];
  function paramAcc(guess, correct, [min, max]) {
    return Math.max(0, 1 - Math.abs(guess - correct) / (Math.max(max - min, 1) * 0.5));
  }

  // Map param names to submitted guess values and formatting
  const paramMap = {
    threshold:  { guess: guessThreshold, range: r.threshold, fmt: v => `${v} dB`    },
    ratio:      { guess: guessRatio,      range: r.ratio,     fmt: v => `${v}:1`     },
    attack:     { guess: guessAttack,     range: r.attack,    fmt: v => `${v} ms`    },
    release:    { guess: guessRelease,    range: r.release,   fmt: v => `${v} ms`    },
    makeupGain: { guess: guessGain,       range: r.makeup,    fmt: v => `+${v} dB`   },
  };

  const evalParams = EFFECT_EVAL_PARAMS[effectType] || EFFECT_EVAL_PARAMS.compressor;
  const feedback = { type: typeCorrect ? `Richtig: ${typeNames[effectType]}` : `Falsch. Es war: ${typeNames[effectType]}` };
  let totalAcc = 0, paramCount = 0;

  for (const pName of evalParams) {
    const def = paramMap[pName];
    if (def.guess == null) continue;
    totalAcc += paramAcc(def.guess, params[pName], def.range);
    paramCount++;
    feedback[pName] = `Richtig: ${def.fmt(params[pName])}  |  Dein Wert: ${def.fmt(def.guess)}`;
  }

  const avgAcc = paramCount > 0 ? totalAcc / paramCount : 0;
  const score  = Math.round(((typeCorrect ? 400 : 0) + Math.round(avgAcc * 600)) * timeFactor);

  res.json({ score, typeCorrect, guessMode, effectType, params, amountIndex: null, feedback });
});

module.exports = router;
