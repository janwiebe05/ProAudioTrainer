'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const adminService = require('../services/adminService');

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    const err = new Error('Kein Zugriff');
    err.status = 403;
    return next(err);
  }
  next();
}

// GET /api/admin/users — alle User auflisten
router.get('/users', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const users = await adminService.listUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users — neuen User anlegen
router.post('/users', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { username, password, role } = req.body;
    const newUser = await adminService.createUser(username, password, role);
    res.status(201).json(newUser);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:id — User löschen
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const result = await adminService.deleteUser(req.params.id, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/password — Passwort zurücksetzen
router.patch('/users/:id/password', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const { password } = req.body;
    const result = await adminService.resetPassword(req.params.id, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
