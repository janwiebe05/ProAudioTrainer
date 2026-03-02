'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { readJSON, writeJSON } = require('../utils/jsonStore');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const SHARED_DIR = path.join(UPLOADS_DIR, 'shared');
const PRIVATE_DIR = path.join(UPLOADS_DIR, 'private');
const LIBRARY_FILE = path.join(__dirname, '..', 'data', 'library.json');

// Ensure base directories exist
fs.mkdirSync(SHARED_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

function loadLibrary() {
  return readJSON(LIBRARY_FILE, []);
}

async function saveLibrary(data) {
  await writeJSON(LIBRARY_FILE, data);
}

/**
 * Resolve the disk path for a library entry based on ownerId.
 * ownerId === null  → uploads/shared/<filename>
 * ownerId === "xyz" → uploads/private/xyz/<filename>
 */
function resolveFilePath(entry) {
  if (entry.ownerId === null) {
    return path.join(SHARED_DIR, entry.filename);
  }
  return path.join(PRIVATE_DIR, entry.ownerId, entry.filename);
}

/**
 * Check if a user has access to a library entry.
 * Access = entry is shared (ownerId null) OR entry belongs to the user.
 */
function hasAccess(entry, user) {
  return entry.ownerId === null || entry.ownerId === user.username;
}

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

// GET /api/library — gibt shared + eigene Dateien zurück, sortiert nach uploadedAt
router.get('/', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const visible = library
    .filter(e => hasAccess(e, req.user))
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(visible);
});

// POST /api/library/upload — Datei(en) hochladen
router.post('/upload', authMiddleware, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
  }

  const isAdmin = req.user.role === 'admin';
  const library = loadLibrary();
  const added = [];

  for (const file of req.files) {
    // Versuche Dauer zu ermitteln (optional)
    let duration = null;
    try {
      const { parseBuffer } = await import('music-metadata');
      const buf = fs.readFileSync(file.path);
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
      ownerId: isAdmin ? null : req.user.username,
      uploadedBy: req.user.username,
      uploadedAt: new Date().toISOString()
    };

    library.push(entry);
    added.push(entry);
  }

  await saveLibrary(library);
  res.json({ uploaded: added.length, files: added });
});

// PATCH /api/library/:id/active — active-Flag togglen
// Admin: darf shared Dateien togglen
// User: darf nur eigene Dateien togglen
router.patch('/:id/active', authMiddleware, async (req, res) => {
  const library = loadLibrary();
  const entry = library.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Datei nicht gefunden' });

  // Access check
  if (!hasAccess(entry, req.user)) {
    return res.status(403).json({ error: 'Kein Zugriff auf diese Datei' });
  }

  // Ownership check for non-admin: can only toggle own files
  if (req.user.role !== 'admin' && entry.ownerId !== req.user.username) {
    return res.status(403).json({ error: 'Nur eigene Dateien können aktiviert werden' });
  }

  entry.active = !entry.active;
  await saveLibrary(library);
  res.json(entry);
});

// DELETE /api/library/:id — Datei löschen
// Admin: darf alles löschen
// User: nur eigene Dateien
router.delete('/:id', authMiddleware, async (req, res) => {
  const library = loadLibrary();
  const idx = library.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Datei nicht gefunden' });

  const entry = library[idx];

  // Access / ownership check
  if (req.user.role !== 'admin' && entry.ownerId !== req.user.username) {
    return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieser Datei' });
  }

  const filePath = resolveFilePath(entry);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignoriere */ }

  library.splice(idx, 1);
  await saveLibrary(library);
  res.json({ deleted: true });
});

// GET /api/library/:id/audio — Audio-Stream
// Prüft ob User Zugriff hat (shared oder eigene)
router.get('/:id/audio', authMiddleware, (req, res) => {
  const library = loadLibrary();
  const entry = library.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Datei nicht gefunden' });

  // Access check
  if (!hasAccess(entry, req.user)) {
    return res.status(403).json({ error: 'Kein Zugriff auf diese Datei' });
  }

  const filePath = resolveFilePath(entry);
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

// GET /api/library/random — zufällige aktive Datei für den aktuellen User
// Wählt aus: shared-aktiven + eigenen-aktiven Tracks
router.get('/random', authMiddleware, (req, res) => {
  const library = loadLibrary();
  // Filter: user has access AND file is active
  const activeVisible = library.filter(e => hasAccess(e, req.user) && e.active);
  // Fallback: alle zugänglichen Dateien
  const pool = activeVisible.length > 0 ? activeVisible : library.filter(e => hasAccess(e, req.user));
  if (pool.length === 0) return res.status(404).json({ error: 'Keine Audiodateien in der Library' });
  const pick = pool[Math.floor(Math.random() * pool.length)];
  res.json(pick);
});

module.exports = router;
