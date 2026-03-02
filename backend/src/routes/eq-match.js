'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const eqMatchService = require('../services/eqMatchService');

// GET /api/eq-match/random?level=1|2|3
router.get('/random', authMiddleware, async (req, res, next) => {
  try {
    const level = req.query.level;
    const result = await eqMatchService.createExercise(level, req.user.username);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/eq-match/evaluate
router.post('/evaluate', authMiddleware, (req, res, next) => {
  try {
    const { exerciseId, userBands, secondsTaken } = req.body;
    const result = eqMatchService.evaluateAnswer(exerciseId, userBands, secondsTaken);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
