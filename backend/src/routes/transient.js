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

const TRANSIENT_PRESETS = {
  'klar':            { attack: 50,  ratio: 2, threshold: -20 },
  'leicht gedämpft': { attack: 10,  ratio: 4, threshold: -24 },
  'mittel gedämpft': { attack: 3,   ratio: 6, threshold: -28 },
  'stark gedämpft':  { attack: 0.5, ratio: 8, threshold: -32 },
};

const LEVEL_OPTIONS = {
  1: ['klar', 'stark gedämpft'],
  2: ['klar', 'leicht gedämpft', 'stark gedämpft'],
  3: ['klar', 'leicht gedämpft', 'mittel gedämpft', 'stark gedämpft'],
};

const EXPLANATIONS = {
  'klar':            'Attack 50ms — langsamer Attack lässt Transienten (Konsonanten) durch.',
  'leicht gedämpft': 'Attack 10ms — mittlerer Attack dämpft Transienten leicht.',
  'mittel gedämpft': 'Attack 3ms — schneller Attack schneidet Konsonanten merklich ab.',
  'stark gedämpft':  'Attack 0.5ms — sehr schneller Attack, Transienten fast vollständig weg.',
};

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); }
  catch { return []; }
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, ex] of exerciseStore) {
    if (now > ex.expiresAt) exerciseStore.delete(id);
  }
}

// GET /api/transient/random?level=1|2|3
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();
  const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));
  const library = loadLibrary();
  const active = library.filter(e => e.active);
  const pool = active.length > 0 ? active : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });

  const audio = pool[Math.floor(Math.random() * pool.length)];
  const options = LEVEL_OPTIONS[level];
  const correctAnswer = options[Math.floor(Math.random() * options.length)];
  const preset = TRANSIENT_PRESETS[correctAnswer];

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, {
    correctAnswer, preset, level, audioId: audio.id,
    expiresAt: Date.now() + EXERCISE_TTL,
  });

  res.json({ exerciseId, audioId: audio.id, audioUrl: `/api/library/${audio.id}/audio`, level, options, preset });
});

// POST /api/transient/evaluate
router.post('/evaluate', authMiddleware, (req, res) => {
  const { exerciseId, answer, secondsTaken } = req.body;
  const exercise = exerciseStore.get(exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Übung nicht gefunden oder abgelaufen' });
  exerciseStore.delete(exerciseId);

  const correct = answer === exercise.correctAnswer;
  const timeFactor = Math.max(0.3, 1 - (secondsTaken || 0) / 45);
  const points = Math.round((correct ? 1000 : 0) * timeFactor);

  res.json({
    correct,
    correctAnswer: exercise.correctAnswer,
    preset: exercise.preset,
    points,
    explanation: EXPLANATIONS[exercise.correctAnswer] || '',
  });
});

module.exports = router;
