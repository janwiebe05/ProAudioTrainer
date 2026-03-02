'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Per-file mutex queue to serialize concurrent writes.
 * Maps filePath → Promise (the tail of the current write chain).
 */
const mutexMap = new Map();

/**
 * Enqueue a task for a specific file, serializing concurrent operations.
 * @param {string} filePath
 * @param {() => Promise<any>} task
 * @returns {Promise<any>}
 */
function withFileLock(filePath, task) {
  const current = mutexMap.get(filePath) || Promise.resolve();
  const next = current.then(task, task); // always run next task even if previous failed
  mutexMap.set(filePath, next.catch(() => {})); // prevent unhandled rejection on the chain
  return next;
}

/**
 * Read and parse a JSON file.
 * Returns the parsed value, or a fallback (default: []) if the file doesn't exist or is invalid.
 * @param {string} filePath
 * @param {any} fallback
 * @returns {any}
 */
function readJSON(filePath, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Write data to a JSON file atomically:
 * 1. Write to a .tmp file
 * 2. fs.renameSync (atomic on Linux — same filesystem)
 *
 * Concurrent writes are serialized via a per-file mutex queue.
 *
 * @param {string} filePath
 * @param {any} data
 * @returns {Promise<void>}
 */
function writeJSON(filePath, data) {
  return withFileLock(filePath, async () => {
    const tmpPath = filePath + '.tmp';
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filePath);
  });
}

module.exports = { readJSON, writeJSON };
