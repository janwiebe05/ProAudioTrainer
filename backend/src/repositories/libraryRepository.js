'use strict';

const path = require('path');
const { readJSON, writeJSON } = require('../utils/jsonStore');

const LIBRARY_FILE = path.join(__dirname, '..', 'data', 'library.json');

module.exports = {
  findAll: async () => {
    return readJSON(LIBRARY_FILE, []);
  },

  findById: async (id) => {
    const library = readJSON(LIBRARY_FILE, []);
    return library.find(e => e.id === id) || null;
  },

  /**
   * Returns entries accessible by the user:
   * - shared entries (ownerId === null)
   * - entries owned by the user (ownerId === username)
   */
  findAccessibleByUser: async (username) => {
    const library = readJSON(LIBRARY_FILE, []);
    return library.filter(e => e.ownerId === null || e.ownerId === username);
  },

  save: async (entry) => {
    const library = readJSON(LIBRARY_FILE, []);
    const idx = library.findIndex(e => e.id === entry.id);
    if (idx >= 0) library[idx] = entry;
    else library.push(entry);
    await writeJSON(LIBRARY_FILE, library);
    return entry;
  },

  delete: async (id) => {
    const library = readJSON(LIBRARY_FILE, []);
    await writeJSON(LIBRARY_FILE, library.filter(e => e.id !== id));
  },

  updateActive: async (id, active) => {
    const library = readJSON(LIBRARY_FILE, []);
    const idx = library.findIndex(e => e.id === id);
    if (idx === -1) return null;
    library[idx].active = active;
    await writeJSON(LIBRARY_FILE, library);
    return library[idx];
  },
};
