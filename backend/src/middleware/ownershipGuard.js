'use strict';

const libraryService = require('../services/libraryService');

/**
 * Middleware that checks if the authenticated user can access a library item.
 * Expects `req.params.id` to be the library entry ID.
 * Sets `req.libraryEntry` for downstream use.
 */
async function canAccessLibraryItem(req, res, next) {
  try {
    const id = req.params.id;
    if (!id) return next();

    const canAccess = await libraryService.canAccessTrack(id, req.user);
    if (!canAccess) {
      const err = new Error('Kein Zugriff auf diese Datei');
      err.status = 403;
      return next(err);
    }

    // Cache the entry for downstream handlers
    const entry = await libraryService.getTrackById(id);
    req.libraryEntry = entry;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { canAccessLibraryItem };
