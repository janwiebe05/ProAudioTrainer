'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await authService.login(username, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify
router.post('/verify', (req, res, next) => {
  try {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false });
    }
    const result = authService.verifyToken(header.slice(7));
    if (!result.valid) return res.status(401).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res, next) => {
  try {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    const tokenResult = authService.verifyToken(header.slice(7));
    if (!tokenResult.valid) return res.status(401).json({ error: 'Token ungültig' });

    const { currentPassword, newPassword } = req.body;
    // Get user id from token payload
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'proaudio-secret-change-in-prod';
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const result = await authService.changePassword(payload.id, currentPassword, newPassword);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
