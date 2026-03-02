'use strict';

/**
 * Throws a 400 error if any required fields are missing or falsy on the object.
 * @param {object} obj
 * @param {string[]} fields
 */
function requireFields(obj, fields) {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length > 0) {
    const err = new Error(`Pflichtfelder fehlen: ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Check if a MIME type is an allowed audio format.
 * @param {string} mimetype
 * @returns {boolean}
 */
function isValidAudioFile(mimetype) {
  const allowed = [
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/flac',
    'audio/x-flac',
    'audio/aiff',
    'audio/x-aiff',
    'audio/mp4',
    'audio/x-m4a',
    'audio/m4a',
  ];
  return allowed.includes(mimetype);
}

module.exports = { requireFields, isValidAudioFile };
