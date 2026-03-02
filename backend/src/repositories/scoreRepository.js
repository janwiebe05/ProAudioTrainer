'use strict';

const path = require('path');
const { readJSON, writeJSON } = require('../utils/jsonStore');

const SCORES_FILE = path.join(__dirname, '..', 'data', 'scores.json');

module.exports = {
  findAll: async () => {
    return readJSON(SCORES_FILE, []);
  },

  findTopN: async (n) => {
    const scores = readJSON(SCORES_FILE, []);
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((s, i) => ({ ...s, rank: i + 1 }));
  },

  findByUsername: async (username) => {
    const scores = readJSON(SCORES_FILE, []);
    return scores
      .filter(s => s.username === username)
      .sort((a, b) => b.score - a.score);
  },

  save: async (score) => {
    const scores = readJSON(SCORES_FILE, []);
    scores.push(score);
    await writeJSON(SCORES_FILE, scores);
    return score;
  },
};
