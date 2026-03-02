'use strict';

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const libraryRepository = require('../repositories/libraryRepository');
const { isValidAudioFile } = require('../utils/validators');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const SHARED_DIR = path.join(UPLOADS_DIR, 'shared');
const PRIVATE_DIR = path.join(UPLOADS_DIR, 'private');

/**
 * Resolve the disk path for a library entry based on ownerId.
 */
function resolveFilePath(entry) {
  if (entry.ownerId === null) {
    return path.join(SHARED_DIR, entry.filename);
  }
  return path.join(PRIVATE_DIR, entry.ownerId, entry.filename);
}

module.exports = {
  /**
   * Get all library entries accessible by a user (shared + own).
   * @returns {Promise<object[]>} sorted by uploadedAt desc
   */
  getLibraryForUser: async (username) => {
    const entries = await libraryRepository.findAccessibleByUser(username);
    return entries.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  },

  /**
   * Add a track uploaded via multer.
   * @param {object} file - multer file object
   * @param {object} user - authenticated user { username, role }
   * @returns {Promise<object>} saved library entry
   */
  addTrack: async (file, user) => {
    const isAdmin = user.role === 'admin';

    let duration = null;
    try {
      const { parseBuffer } = await import('music-metadata');
      const buf = fs.readFileSync(file.path);
      const metadata = await parseBuffer(buf, { mimeType: file.mimetype });
      duration = metadata.format.duration || null;
    } catch { /* ignore */ }

    const entry = {
      id: path.basename(file.filename, path.extname(file.filename)),
      originalName: file.originalname,
      filename: file.filename,
      size: file.size,
      duration,
      mimeType: file.mimetype,
      active: false,
      ownerId: isAdmin ? null : user.username,
      uploadedBy: user.username,
      uploadedAt: new Date().toISOString(),
    };

    await libraryRepository.save(entry);
    return entry;
  },

  /**
   * Delete a track by ID. Checks ownership.
   * Admins can delete any track; users only their own.
   */
  deleteTrack: async (id, user) => {
    const entry = await libraryRepository.findById(id);
    if (!entry) {
      const err = new Error('Datei nicht gefunden');
      err.status = 404;
      throw err;
    }

    if (user.role !== 'admin' && entry.ownerId !== user.username) {
      const err = new Error('Keine Berechtigung zum Löschen dieser Datei');
      err.status = 403;
      throw err;
    }

    const filePath = resolveFilePath(entry);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore fs errors */ }

    await libraryRepository.delete(id);
    return { deleted: true };
  },

  /**
   * Toggle the active flag of a track. Checks ownership.
   */
  toggleActive: async (id, user, active) => {
    const entry = await libraryRepository.findById(id);
    if (!entry) {
      const err = new Error('Datei nicht gefunden');
      err.status = 404;
      throw err;
    }

    // Access check: user must have access to the file
    if (entry.ownerId !== null && entry.ownerId !== user.username) {
      const err = new Error('Kein Zugriff auf diese Datei');
      err.status = 403;
      throw err;
    }

    // Ownership check for non-admin
    if (user.role !== 'admin' && entry.ownerId !== user.username) {
      const err = new Error('Nur eigene Dateien können aktiviert werden');
      err.status = 403;
      throw err;
    }

    const newActive = active !== undefined ? active : !entry.active;
    return await libraryRepository.updateActive(id, newActive);
  },

  /**
   * Get a random active track accessible by the user.
   * Falls back to all accessible tracks if none are active.
   */
  getRandomTrackForUser: async (username) => {
    const accessible = await libraryRepository.findAccessibleByUser(username);
    const active = accessible.filter(e => e.active);
    const pool = active.length > 0 ? active : accessible;

    if (pool.length === 0) {
      const err = new Error('Keine Audiodateien in der Library');
      err.status = 404;
      throw err;
    }

    return pool[Math.floor(Math.random() * pool.length)];
  },

  /**
   * Check if a user can access a track (shared or own).
   * @returns {Promise<boolean>}
   */
  canAccessTrack: async (id, user) => {
    const entry = await libraryRepository.findById(id);
    if (!entry) return false;
    return entry.ownerId === null || entry.ownerId === user.username;
  },

  /**
   * Get a library entry by ID (for streaming etc.)
   */
  getTrackById: async (id) => {
    return await libraryRepository.findById(id);
  },

  resolveFilePath,
};
