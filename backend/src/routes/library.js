'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const LIBRARY_FILE = path.join(__dirname, '..', 'data', 'library.json');

function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')); }
  catch { return []; }
}

function saveLibrary(data) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(data, null, 2));
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${id}${ext}`);
  }
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
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// GET /library and specific URLs for each file
router.get('/', authMiddleware, (req, res) => {
  const library = loadLibrary();
  res.json(library);
});

// POST /api/library/upload — Datei(en) hochladen
router.post('/upload', authMiddleware, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
  }

  const library = loadLibrary();
  const added = [];

  for (const file of req.files) {
    // Versuche Dauer zu ermitteln (optional, ohne externe Abhängigkeit)
    let duration = null;
    try {
      const { parseBuffer } = await import('music-metadata');
      const buf = require('fs').readFileSync(file.path);
      const metadata = await parseBuffer(buf, { mimeType: file.mimetype });
      duration = metadata.format.duration || null;
    } catch { /* ignoriere Fehler */ }

    const entry = {
      id: path.basename(file.filename, path.extname(file.filename)),
      originalName: file.originalname,
      filename: file.filename,
      size: file.size,
      duration,
      mimeType: file.mimetype,
      active: false,
      uploadedBy: req.user.username,
      uploadedAt: new Date().toISOString()
    };

    library.push(entry);
    added.push(entry);
  }

  saveLibrary(library);
  res.json({ uploaded: added.length, files: added });
});

// PATCH /api/library/:id/active — active-Flag togglen
router.patch('/:id/active', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const entry = library.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Datei nicht gefunden' });
  entry.active = !entry.active;
  saveLibrary(library);
  res.json(entry);
});

// DELETE /api/library/:id — Datei löschen
router.delete('/:id', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const idx = library.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Datei nicht gefunden' });

  const entry = library[idx];
  const filePath = path.join(UPLOADS_DIR, entry.filename);

  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignoriere */ }

  library.splice(idx, 1);
  saveLibrary(library);
  res.json({ deleted: true });
});

// GET /api/library/:id/audio — Audio-Stream
router.get('/:id/audio', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const entry = library.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Datei nicht gefunden' });

  const filePath = path.join(UPLOADS_DIR, entry.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Datei nicht auf Disk' });

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
});

// GET /api/library/random — zufällige aktive Datei (oder alle wenn keine aktiv)
router.get('/random', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const active = library.filter(e => e.active);
  const pool = active.length > 0 ? active : library;
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });
  const pick = pool[Math.floor(Math.random() * pool.length)];
  res.json(pick);
});

module.exports = router;
