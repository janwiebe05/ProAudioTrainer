'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const libraryRoutes = require('./routes/library');
const scoresRoutes = require('./routes/scores');
const dynamicsRoutes = require('./routes/dynamics');
const adminRoutes    = require('./routes/admin');
const reverbRoutes   = require('./routes/reverb');
const panningRoutes  = require('./routes/panning');
const eqMatchRoutes  = require('./routes/eq-match');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Initialize default data files
const usersFile = path.join(dataDir, 'users.json');
if (!fs.existsSync(usersFile)) {
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync('admin1!', salt);
  fs.writeFileSync(usersFile, JSON.stringify([
    { id: uuidv4(), username: 'admin', passwordHash: hash, role: 'admin', createdAt: new Date().toISOString() }
  ], null, 2));
}

const libraryFile = path.join(dataDir, 'library.json');
if (!fs.existsSync(libraryFile)) fs.writeFileSync(libraryFile, JSON.stringify([], null, 2));

const scoresFile = path.join(dataDir, 'scores.json');
if (!fs.existsSync(scoresFile)) fs.writeFileSync(scoresFile, JSON.stringify([], null, 2));

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/scores', scoresRoutes);
app.use('/api/dynamics', dynamicsRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/reverb',   reverbRoutes);
app.use('/api/panning',  panningRoutes);
app.use('/api/eq-match', eqMatchRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ProAudioTrainer Backend] Running on port ${PORT}`);
});
