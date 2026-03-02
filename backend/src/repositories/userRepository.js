'use strict';

const path = require('path');
const { readJSON, writeJSON } = require('../utils/jsonStore');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

module.exports = {
  findAll: async () => {
    return readJSON(USERS_FILE, []);
  },

  findByUsername: async (username) => {
    const users = readJSON(USERS_FILE, []);
    return users.find(u => u.username === username) || null;
  },

  findById: async (id) => {
    const users = readJSON(USERS_FILE, []);
    return users.find(u => u.id === id) || null;
  },

  save: async (user) => {
    const users = readJSON(USERS_FILE, []);
    const idx = users.findIndex(u => u.username === user.username);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    await writeJSON(USERS_FILE, users);
    return user;
  },

  delete: async (id) => {
    const users = readJSON(USERS_FILE, []);
    await writeJSON(USERS_FILE, users.filter(u => u.id !== id));
  },

  updateById: async (id, updates) => {
    const users = readJSON(USERS_FILE, []);
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...updates };
    await writeJSON(USERS_FILE, users);
    return users[idx];
  },
};
