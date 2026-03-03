'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const progressService = require('../services/progressService');

// GET /api/progress/summary
router.get('/summary', authMiddleware, (req, res, next) => {
  try {
    const data = progressService.getSummary(req.user.username);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/progress/sessions
router.get('/sessions', authMiddleware, (req, res, next) => {
  try {
    const data = progressService.getSessions(req.user.username, 20);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/progress/weakspots
router.get('/weakspots', authMiddleware, (req, res, next) => {
  try {
    const data = progressService.getWeakspots(req.user.username);
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
