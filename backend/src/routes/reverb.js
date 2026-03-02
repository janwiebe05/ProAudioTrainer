'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');

const EXERCISE_TTL = 30 * 60 * 1000;
const exerciseStore = new Map();

// IR catalogue — paths relative to frontend root, served by nginx
// Categories map to perceptually distinct room types students must learn
const IR_CATALOGUE = {
  cathedral: [
    '/EchoThief/Sanctuaries/St Paul\'s Cathedral San Diego California.wav',
    '/EchoThief/Sanctuaries/First Church of Christ Scientist Original Edifice Boston Massachusetts.wav',
    '/EchoThief/Sanctuaries/Founders Chapel University of San Diego California.wav',
    '/EchoThief/Sanctuaries/Immaculata Dome University of San Diego California.wav',
    '/EchoThief/Domes/Immaculata Dome University of San Diego California.wav',
    '/EchoThief/Domes/Square Victoria Dome Montreal Quebec.wav',
  ],
  concert_hall: [
    '/EchoThief/Venues/Conrad Prebys Concert Hall Seat F111 UC San Diego California.wav',
    '/EchoThief/Venues/Orpheum Theatre Omaha Grand Tier D8 Nebraska.wav',
    '/EchoThief/Venues/Steinman Hall Millersville University Pennsylvania.wav',
    '/EchoThief/Venues/City Heights Performance Annex San Diego California.wav',
    '/EchoThief/Miscellaneous/Littlefield Concert Hall Lobby Mills College Oakland California.wav',
  ],
  room: [
    '/EchoThief/Recreation/Racquetball Court UC San Diego California.wav',
    '/EchoThief/Recreation/Hale Holistic Yoga Studio San Diego California.wav',
    '/EchoThief/Miscellaneous/Warren Lecture Hall 2005 UC San Diego California.wav',
    '/EchoThief/Miscellaneous/Hawxhurst Mansion Ballroom Newport Rhode Island.wav',
    '/EchoThief/Miscellaneous/Bar Monsieur Ricard Montreal Quebec.wav',
    '/EchoThief/Stairwells/CCRMA Stairwell Stanford University California.wav',
  ],
  tunnel: [
    '/EchoThief/Underground/Lake Mead Aqueduct Nevada.wav',
    '/EchoThief/Underground/Meadowbrook Tunnel Storm Drain Poway California.wav',
    '/EchoThief/Underpasses/Echo Bridge Newton Upper Falls Massachusetts.wav',
    '/EchoThief/Underpasses/Dipway Arch Central Park New York.wav',
    '/EchoThief/Underground/Subway Cave Lava Tube Sanctum Lassen National Forest California.wav',
    '/EchoThief/Underpasses/Cleft Ridge Span Prospect Park Brooklyn New York.wav',
  ],
  outdoor: [
    '/EchoThief/Nature/Byron Glacier Alaska.wav',
    '/EchoThief/Nature/Isla Mujeres Cave Quintana Roo.wav',
    '/EchoThief/Nature/Subway Cave Lava Tube Sanctum Lassen National Forest California.wav',
    '/EchoThief/Venues/Mills Greek Theater Oakland California.wav',
    '/EchoThief/Nature/Purgatory Chasm Rhode Island.wav',
  ],
};

// Level config: which categories appear at each level
const LEVEL_CATEGORIES = {
  1: ['room', 'concert_hall', 'cathedral'],
  2: ['room', 'concert_hall', 'cathedral', 'tunnel'],
  3: ['room', 'concert_hall', 'cathedral', 'tunnel', 'outdoor'],
};

// Human-readable labels
const CATEGORY_LABELS = {
  room:         'Small Room',
  concert_hall: 'Concert Hall',
  cathedral:    'Cathedral / Church',
  tunnel:       'Tunnel / Underpass',
  outdoor:      'Outdoor / Cave',
};

function purgeExpired() {
  const now = Date.now();
  for (const [id, ex] of exerciseStore) {
    if (now > ex.expiresAt) exerciseStore.delete(id);
  }
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// GET /api/reverb/random?level=1|2|3
router.get('/random', authMiddleware, (req, res) => {
  purgeExpired();
  const level      = Math.min(3, Math.max(1, parseInt(req.query.level, 10) || 1));
  const categories = LEVEL_CATEGORIES[level];
  const category   = pick(categories);
  const irPath     = pick(IR_CATALOGUE[category]);

  // Wet/dry mix: level 1 = obvious (0.6-0.8), level 3 = subtle (0.2-0.5)
  const wetRanges  = { 1: [0.6, 0.8], 2: [0.4, 0.7], 3: [0.2, 0.5] };
  const [wMin, wMax] = wetRanges[level];
  const wetMix     = parseFloat((Math.random() * (wMax - wMin) + wMin).toFixed(2));

  const exerciseId = uuidv4();
  exerciseStore.set(exerciseId, {
    category, irPath, wetMix,
    expiresAt: Date.now() + EXERCISE_TTL,
  });

  res.json({
    exerciseId,
    irPath,
    wetMix,
    availableCategories: categories.map(c => ({ id: c, label: CATEGORY_LABELS[c] })),
  });
});

// POST /api/reverb/evaluate
router.post('/evaluate', authMiddleware, (req, res) => {
  const { exerciseId, guessCategory, secondsTaken } = req.body;
  const exercise = exerciseStore.get(exerciseId);
  if (!exercise) return res.status(404).json({ error: 'Übung nicht gefunden oder abgelaufen' });
  exerciseStore.delete(exerciseId);

  const { category, irPath, wetMix } = exercise;
  const correct    = guessCategory === category;
  const timeFactor = Math.max(0.3, 1 - (secondsTaken || 0) / 45);
  const score      = Math.round((correct ? 1000 : 0) * timeFactor);

  res.json({
    score, correct, category, irPath, wetMix,
    categoryLabel: CATEGORY_LABELS[category],
    feedback: correct
      ? `Richtig: ${CATEGORY_LABELS[category]}`
      : `Falsch. Es war: ${CATEGORY_LABELS[category]}`,
  });
});

module.exports = router;
