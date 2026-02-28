'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');

const SCORES_FILE = path.join(__dirname, '..', 'data', 'scores.json');

function loadScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); }
  catch { return []; }
}

function saveScores(data) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(data, null, 2));
}

// POST /api/scores — Score speichern
router.post('/', authMiddleware, (req, res) => {
  const { score, rounds, level, streak } = req.body;
  if (score === undefined || score === null) {
    return res.status(400).json({ error: 'Score fehlt' });
  }

  const scores = loadScores();
  const entry = {
    id: uuidv4(),
    username: req.user.username,
    score: Math.max(0, parseInt(score, 10) || 0),
    rounds: rounds || 0,
    level: level || 1,
    streak: streak || 0,
    date: new Date().toISOString()
  };
  scores.push(entry);
  saveScores(scores);
  res.json(entry);
});

// GET /api/scores/highscores — Top 10 global
router.get('/highscores', authMiddleware, (req, res) => {
  const scores = loadScores();
  const top = scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s, i) => ({ ...s, rank: i + 1 }));
  res.json(top);
});

// GET /api/scores/me — eigene Scores
router.get('/me', authMiddleware, (req, res) => {
  const scores = loadScores();
  const mine = scores
    .filter(s => s.username === req.user.username)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  res.json(mine);
});

module.exports = router;
