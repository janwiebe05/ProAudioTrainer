'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { readJSON, writeJSON } = require('../utils/jsonStore');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

function loadUsers() {
  return readJSON(USERS_FILE, []);
}

async function saveUsers(data) {
  await writeJSON(USERS_FILE, data);
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Kein Zugriff' });
  next();
}

// GET /api/admin/users — alle User auflisten (ohne Passwort-Hash)
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const users = loadUsers().map(({ passwordHash, ...u }) => u);
  res.json(users);
});

// POST /api/admin/users — neuen User anlegen
router.post('/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username und Passwort erforderlich' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein' });
  }

  const users = loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Username bereits vergeben' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    passwordHash: hash,
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  await saveUsers(users);

  const { passwordHash, ...safe } = newUser;
  res.status(201).json(safe);
});

// DELETE /api/admin/users/:id — User löschen
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  if (req.user.sub === req.params.id || req.user.id === req.params.id) {
    return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });
  }
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User nicht gefunden' });
  users.splice(idx, 1);
  await saveUsers(users);
  res.json({ deleted: true });
});

// PATCH /api/admin/users/:id/password — Passwort zurücksetzen
router.patch('/users/:id/password', authMiddleware, adminOnly, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein' });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden' });
  user.passwordHash = bcrypt.hashSync(password, 10);
  await saveUsers(users);
  res.json({ updated: true });
});

module.exports = router;
