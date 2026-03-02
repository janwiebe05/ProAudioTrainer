'use strict';

/**
 * In-Memory Repository for EQ-Match exercises.
 * Exercises are ephemeral and expire after TTL_MS.
 */
const TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map();

module.exports = {
  /**
   * Create and store a new exercise.
   * @param {string} id - UUID for the exercise
   * @param {object} exerciseData - { hiddenBands, level, audioId }
   * @returns {object} stored exercise with expiresAt
   */
  create: (id, exerciseData) => {
    const exercise = {
      ...exerciseData,
      expiresAt: Date.now() + TTL_MS,
    };
    store.set(id, exercise);
    return exercise;
  },

  findById: (id) => {
    const exercise = store.get(id);
    if (!exercise) return null;
    if (Date.now() > exercise.expiresAt) {
      store.delete(id);
      return null;
    }
    return exercise;
  },

  delete: (id) => {
    store.delete(id);
  },

  /**
   * Remove all expired exercises from the store.
   */
  cleanup: () => {
    const now = Date.now();
    for (const [id, ex] of store) {
      if (now > ex.expiresAt) store.delete(id);
    }
  },
};
