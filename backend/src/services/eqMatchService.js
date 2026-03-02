'use strict';

const { v4: uuidv4 } = require('uuid');
const exerciseRepository = require('../repositories/exerciseRepository');
const libraryService = require('./libraryService');

// ─── Band Definitions ────────────────────────────────────────────────────────
const BAND_DEFS = {
  1: { type: 'lowshelf',  label: 'LOW SHELF',  freqRange: [40, 300],    qRange: null },
  2: { type: 'peaking',   label: 'LOW MID',    freqRange: [200, 1200],  qRange: [0.5, 4.0] },
  3: { type: 'peaking',   label: 'HIGH MID',   freqRange: [1000, 8000], qRange: [0.5, 4.0] },
  4: { type: 'highshelf', label: 'HIGH SHELF', freqRange: [4000, 16000], qRange: null },
};

// ─── Level Configuration ─────────────────────────────────────────────────────
const LEVEL_CONFIG = {
  1: {
    minBands: 1, maxBands: 2,
    gainRange: [6, 12],
    fixedQ: 1.0,
    fixedFreq: true,
    userControlsFreq: false,
    userControlsQ: false,
    timeLimit: null,
  },
  2: {
    minBands: 2, maxBands: 3,
    gainRange: [3, 8],
    fixedQ: null,
    fixedFreq: false,
    userControlsFreq: true,
    userControlsQ: true,
    timeLimit: null,
  },
  3: {
    minBands: 4, maxBands: 4,
    gainRange: [2, 5],
    fixedQ: null,
    fixedFreq: false,
    userControlsFreq: true,
    userControlsQ: true,
    timeLimit: 90,
  },
};

const FIXED_FREQS = { 1: 100, 2: 500, 3: 3000, 4: 8000 };

// ─── Helper Functions ─────────────────────────────────────────────────────────
function rand(min, max, decimals = 1) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randInt(min, max) {
  return Math.round(Math.random() * (max - min) + min);
}

function generateHiddenEQ(level) {
  const config = LEVEL_CONFIG[level];
  const allBands = [1, 2, 3, 4];
  const count = randInt(config.minBands, config.maxBands);
  const shuffled = [...allBands].sort(() => Math.random() - 0.5);
  const activeBandIds = level === 3 ? allBands : shuffled.slice(0, count);

  const bands = {};
  for (const bandId of allBands) {
    const def = BAND_DEFS[bandId];
    const isActive = activeBandIds.includes(bandId);

    if (!isActive) {
      const centerFreq = config.fixedFreq
        ? FIXED_FREQS[bandId]
        : Math.round((def.freqRange[0] + def.freqRange[1]) / 2);
      bands[bandId] = {
        type: def.type, label: def.label,
        frequency: centerFreq, gain: 0,
        Q: def.qRange ? 1.0 : null,
        active: false,
      };
      continue;
    }

    const freq = config.fixedFreq ? FIXED_FREQS[bandId] : randInt(def.freqRange[0], def.freqRange[1]);
    const absGain = rand(config.gainRange[0], config.gainRange[1], 1);
    const gain = Math.random() < 0.5 ? absGain : -absGain;
    let Q = null;
    if (def.qRange) {
      Q = config.fixedQ !== null ? config.fixedQ : rand(def.qRange[0], def.qRange[1], 1);
    }

    bands[bandId] = { type: def.type, label: def.label, frequency: freq, gain, Q, active: true };
  }
  return bands;
}

// ─── Service ──────────────────────────────────────────────────────────────────
module.exports = {
  BAND_DEFS,
  LEVEL_CONFIG,

  /**
   * Create a new EQ exercise for a user.
   * @param {number} level - 1, 2, or 3
   * @param {string} username
   * @returns {Promise<object>} exercise data for the client
   */
  createExercise: async (level, username) => {
    exerciseRepository.cleanup();

    const clampedLevel = Math.min(3, Math.max(1, parseInt(level, 10) || 1));
    const config = LEVEL_CONFIG[clampedLevel];

    const audio = await libraryService.getRandomTrackForUser(username);
    const hiddenBands = generateHiddenEQ(clampedLevel);
    const exerciseId = uuidv4();

    exerciseRepository.create(exerciseId, {
      hiddenBands,
      level: clampedLevel,
      audioId: audio.id,
    });

    return {
      exerciseId,
      audioUrl: `/api/library/${audio.id}/audio`,
      hiddenBands,
      level: clampedLevel,
      timeLimit: config.timeLimit,
      userControlsFreq: config.userControlsFreq,
      userControlsQ: config.userControlsQ,
      bandDefs: BAND_DEFS,
    };
  },

  /**
   * Evaluate a user's answer for an exercise.
   * @param {string} exerciseId
   * @param {object} userBands - { [bandId]: { gain, frequency, Q } }
   * @param {number} [secondsTaken]
   * @returns {object} evaluation result with score and band details
   */
  evaluateAnswer: (exerciseId, userBands, secondsTaken) => {
    const exercise = exerciseRepository.findById(exerciseId);
    if (!exercise) {
      const err = new Error('Übung nicht gefunden oder abgelaufen');
      err.status = 404;
      throw err;
    }
    exerciseRepository.delete(exerciseId);

    const { hiddenBands, level } = exercise;
    const config = LEVEL_CONFIG[level];

    const bandResults = {};
    let totalScore = 0;
    let bandCount = 0;

    for (const bandId of [1, 2, 3, 4]) {
      const hidden = hiddenBands[bandId];
      const user = userBands?.[bandId] || { gain: 0, frequency: hidden.frequency, Q: hidden.Q };

      if (!hidden.active) {
        const gainDiff = Math.abs(user.gain || 0);
        const gainScore = Math.max(0, 1 - gainDiff / 3);
        bandResults[bandId] = {
          active: false, hiddenGain: 0, userGain: user.gain || 0, idealGain: 0,
          gainScore, score: Math.round(gainScore * 1000),
        };
        totalScore += gainScore;
        bandCount++;
        continue;
      }

      const idealGain = -hidden.gain;
      const gainDiff = Math.abs((user.gain || 0) - idealGain);

      let gainScore;
      if (gainDiff <= 1.5) gainScore = 1.0;
      else if (gainDiff <= 3.0) gainScore = 1.0 - (gainDiff - 1.5) / 3.0;
      else gainScore = Math.max(0, 0.5 - (gainDiff - 3.0) / 12.0);

      let freqScore = 1.0;
      let qScore = 1.0;

      if (config.userControlsFreq && hidden.frequency) {
        const freqDiffOctaves = Math.abs(Math.log2((user.frequency || hidden.frequency) / hidden.frequency));
        freqScore = freqDiffOctaves <= 0.25 ? 1.0 : Math.max(0, 1.0 - (freqDiffOctaves - 0.25) / 1.5);
      }

      if (config.userControlsQ && hidden.Q !== null) {
        const qDiff = Math.abs((user.Q || 1.0) - hidden.Q);
        qScore = qDiff <= 0.5 ? 1.0 : Math.max(0, 1.0 - (qDiff - 0.5) / 3.0);
      }

      const hasQ = hidden.Q !== null && config.userControlsQ;
      const hasFreq = config.userControlsFreq;
      let bandScore;
      if (hasFreq && hasQ) bandScore = gainScore * 0.55 + freqScore * 0.30 + qScore * 0.15;
      else if (hasFreq) bandScore = gainScore * 0.65 + freqScore * 0.35;
      else bandScore = gainScore;

      bandResults[bandId] = {
        active: true, type: hidden.type,
        hiddenFreq: hidden.frequency, hiddenGain: hidden.gain, hiddenQ: hidden.Q,
        userFreq: user.frequency, userGain: user.gain || 0, userQ: user.Q,
        idealGain,
        gainScore: parseFloat(gainScore.toFixed(3)),
        freqScore: hasFreq ? parseFloat(freqScore.toFixed(3)) : null,
        qScore: hasQ ? parseFloat(qScore.toFixed(3)) : null,
        bandScore: parseFloat(bandScore.toFixed(3)),
        score: Math.round(bandScore * 1000),
      };

      totalScore += bandScore;
      bandCount++;
    }

    const maxTime = config.timeLimit || 120;
    const timeFactor = config.timeLimit ? Math.max(0.3, 1 - (secondsTaken || 0) / maxTime) : 1.0;
    const avgScore = bandCount > 0 ? totalScore / bandCount : 0;
    const finalScore = Math.round(avgScore * 1000 * timeFactor);

    return {
      score: finalScore,
      timeFactor: parseFloat(timeFactor.toFixed(3)),
      secondsTaken,
      bandResults,
      hiddenBands,
    };
  },
};
