'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middleware/auth');
const libraryService = require('../services/libraryService');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const SHARED_DIR = path.join(UPLOADS_DIR, 'shared');
const PRIVATE_DIR = path.join(UPLOADS_DIR, 'private');

// Ensure base directories exist
fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

// Multer storage — destination depends on user role
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let destDir;
    if (req.user && req.user.role === 'admin') {
      destDir = SHARED_DIR;
    } else {
      destDir = path.join(PRIVATE_DIR, req.user.username);
      fs.mkdirSync(destDir, { recursive: true });
    }
    cb(null, destDir);
  },
  filename: (req, file, cb) => {
    const { v4: uuidv4 } = require('uuid');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.aif', '.m4a'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error(`Dateiformat nicht unterstützt: ${ext}`), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// GET /api/library — shared + eigene Dateien
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const library = await libraryService.getLibraryForUser(req.user.username);
    res.json(library);
  } catch (err) {
    next(err);
  }
});

// GET /api/library/random — zufällige aktive Datei
router.get('/random', authMiddleware, async (req, res, next) => {
  try {
    const track = await libraryService.getRandomTrackForUser(req.user.username);
    res.json(track);
  } catch (err) {
    next(err);
  }
});

// POST /api/library/upload — Datei(en) hochladen
router.post('/upload', authMiddleware, upload.array('files', 50), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      const err = new Error('Keine Dateien hochgeladen');
      err.status = 400;
      throw err;
    }

    const added = [];
    for (const file of req.files) {
      const entry = await libraryService.addTrack(file, req.user);
      added.push(entry);
    }

    res.json({ uploaded: added.length, files: added });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/library/:id/active — active-Flag togglen
router.patch('/:id/active', authMiddleware, async (req, res, next) => {
  try {
    const { active } = req.body;
    const updated = await libraryService.toggleActive(req.params.id, req.user, active);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/library/:id — Datei löschen
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const result = await libraryService.deleteTrack(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/library/:id/audio — Audio-Stream
router.get('/:id/audio', authMiddleware, async (req, res, next) => {
  try {
    const canAccess = await libraryService.canAccessTrack(req.params.id, req.user);
    if (!canAccess) {
      const err = new Error('Kein Zugriff auf diese Datei');
      err.status = 403;
      throw err;
    }

    const entry = await libraryService.getTrackById(req.params.id);
    if (!entry) {
      const err = new Error('Datei nicht gefunden');
      err.status = 404;
      throw err;
    }

    const filePath = libraryService.resolveFilePath(entry);
    if (!fs.existsSync(filePath)) {
      const err = new Error('Datei nicht auf Disk');
      err.status = 404;
      throw err;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': entry.mimeType || 'audio/mpeg',
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': entry.mimeType || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
