'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const scoreService = require('../services/scoreService');

// POST /api/scores — Score speichern
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { score, rounds, level, streak } = req.body;
    const entry = await scoreService.submitScore({
      username: req.user.username,
      score,
      rounds,
      level,
      streak,
    });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// GET /api/scores/highscores — Top 10 global
router.get('/highscores', authMiddleware, async (req, res, next) => {
  try {
    const top = await scoreService.getTopScores(10);
    res.json(top);
  } catch (err) {
    next(err);
  }
});

// GET /api/scores/me — eigene Scores
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const mine = await scoreService.getUserScores(req.user.username, 10);
    res.json(mine);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
