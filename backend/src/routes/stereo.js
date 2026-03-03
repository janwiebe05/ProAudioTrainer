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

const STEREO_LEVELS = {
  1: { options: ['mono', 'stereo'], widths: { mono: 0, stereo: 1.0 } },
  2: { options: ['schmal', 'mittel', 'breit'], widths: { schmal: 0.2, mittel: 0.5, breit: 1.0 } },
  3: { options: ['mono', 'sehr schmal', 'schmal', 'breit', 'sehr breit'], widths: { mono: 0, 'sehr schmal': 0.15, schmal: 0.35, breit: 0.7, 'sehr breit': 1.0 } },
};

const EXPLANATIONS = {
  mono: 'Mono: Kein Stereoanteil — beide Kanäle identisch.',
  stereo: 'Stereo: Volle Stereobreite — L und R unterschiedlich.',
  schmal: 'Schmal: Wenig Stereoanteil, klingt fast mono.',
  mittel: 'Mittel: Ausgewogene Stereobreite.',
  breit: 'Breit: Deutliche Stereobreite, füllt den Raum.',
  'sehr schmal': 'Sehr schmal: Kaum Stereoanteil, fast mono.',
  'sehr breit': 'Sehr breit: Maximale Stereobreite, fast übertrieben.',
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

// GET /api/stereo/random?level=1|2|3
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();
  const level = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));
  const library = loadLibrary();
  const active = library.filter(e => e.active);
  const pool = active.length > 0 ? active : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });

  const audio = pool[Math.floor(Math.random() * pool.length)];
  const cfg = STEREO_LEVELS[level];
  const options = cfg.options;
  const correctAnswer = options[Math.floor(Math.random() * options.length)];
  const width = cfg.widths[correctAnswer];

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, {
    correctAnswer, width, level, audioId: audio.id,
    expiresAt: Date.now() + EXERCISE_TTL,
  });

  res.json({ exerciseId, audioId: audio.id, audioUrl: `/api/library/${audio.id}/audio`, level, options, width });
});

// POST /api/stereo/evaluate
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
    width: exercise.width,
    points,
    explanation: EXPLANATIONS[exercise.correctAnswer] || '',
  });
});

module.exports = router;
