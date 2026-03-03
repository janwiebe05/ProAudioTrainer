'use strict';

const path = require('path');
const { readJSON } = require('../utils/jsonStore');

const SCORES_FILE = path.join(__dirname, '..', 'data', 'scores.json');

function loadScores(username) {
  const all = readJSON(SCORES_FILE, []);
  return all.filter(s => s.username === username);
}

module.exports = {
  getSummary(username) {
    const scores = loadScores(username);
    if (scores.length === 0) {
      return { totalPoints: 0, totalRounds: 0, avgScore: 0, bestSession: null, currentStreak: 0, sessionCount: 0 };
    }
    const totalPoints = scores.reduce((s, e) => s + (e.score || 0), 0);
    const totalRounds = scores.reduce((s, e) => s + (e.rounds || 0), 0);
    const avgScore = Math.round(totalPoints / scores.length);
    const bestSession = scores.reduce((best, e) => (!best || e.score > best.score) ? e : best, null);
    const currentStreak = scores.reduce((max, e) => Math.max(max, e.streak || 0), 0);
    return { totalPoints, totalRounds, avgScore, bestSession, currentStreak, sessionCount: scores.length };
  },

  getSessions(username, limit = 20) {
    const scores = loadScores(username);
    return scores
      .sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt))
      .slice(0, limit);
  },

  getWeakspots(username) {
    const scores = loadScores(username);
    const byModule = {};
    for (const s of scores) {
      const mod = s.module || 'eq';
      if (!byModule[mod]) byModule[mod] = { total: 0, count: 0 };
      byModule[mod].total += s.score || 0;
      byModule[mod].count += 1;
    }
    return Object.entries(byModule).map(([module, data]) => ({
      module,
      avgScore: Math.round(data.total / data.count),
      sessionCount: data.count,
    })).sort((a, b) => a.avgScore - b.avgScore);
  },
};
