'use strict';

const { v4: uuidv4 } = require('uuid');
const scoreRepository = require('../repositories/scoreRepository');
const { requireFields } = require('../utils/validators');

module.exports = {
  /**
   * Submit a new score entry.
   * @param {object} scoreData - { score, rounds, level, streak, username }
   * @returns {Promise<object>} saved score entry
   */
  submitScore: async (scoreData) => {
    requireFields(scoreData, ['username', 'score']);

    const entry = {
      id: uuidv4(),
      username: scoreData.username,
      score: Math.max(0, parseInt(scoreData.score, 10) || 0),
      rounds: scoreData.rounds || 0,
      level: scoreData.level || 1,
      streak: scoreData.streak || 0,
      date: new Date().toISOString(),
    };

    return await scoreRepository.save(entry);
  },

  /**
   * Get the top N scores globally.
   * @param {number} n
   * @returns {Promise<object[]>}
   */
  getTopScores: async (n = 10) => {
    return await scoreRepository.findTopN(n);
  },

  /**
   * Get all scores for a specific user, sorted by score desc.
   * @param {string} username
   * @param {number} [limit=10]
   * @returns {Promise<object[]>}
   */
  getUserScores: async (username, limit = 10) => {
    const scores = await scoreRepository.findByUsername(username);
    return scores.slice(0, limit);
  },
};
