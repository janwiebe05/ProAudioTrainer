'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const userRepository = require('../repositories/userRepository');
const { requireFields } = require('../utils/validators');

const JWT_SECRET = process.env.JWT_SECRET || 'proaudio-secret-change-in-prod';
const JWT_EXPIRES = '24h';

module.exports = {
  /**
   * Register a new user.
   * @param {string} username
   * @param {string} password
   * @param {string} [role='user']
   * @returns {Promise<object>} user without passwordHash
   */
  register: async (username, password, role = 'user') => {
    requireFields({ username, password }, ['username', 'password']);

    if (password.length < 6) {
      const err = new Error('Passwort muss mindestens 6 Zeichen lang sein');
      err.status = 400;
      throw err;
    }

    const existing = await userRepository.findByUsername(username);
    if (existing) {
      const err = new Error('Username bereits vergeben');
      err.status = 409;
      throw err;
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const newUser = {
      id: uuidv4(),
      username,
      passwordHash,
      role: role === 'admin' ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };

    await userRepository.save(newUser);
    const { passwordHash: _, ...safe } = newUser;
    return safe;
  },

  /**
   * Login with username/password.
   * @returns {Promise<{ token: string, username: string, role: string }>}
   */
  login: async (username, password) => {
    requireFields({ username, password }, ['username', 'password']);

    const user = await userRepository.findByUsername(username);
    if (!user) {
      const err = new Error('Ungültige Anmeldedaten');
      err.status = 401;
      throw err;
    }

    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      const err = new Error('Ungültige Anmeldedaten');
      err.status = 401;
      throw err;
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    return { token, username: user.username, role: user.role };
  },

  /**
   * Change password for authenticated user.
   */
  changePassword: async (userId, currentPassword, newPassword) => {
    requireFields({ currentPassword, newPassword }, ['currentPassword', 'newPassword']);

    if (newPassword.length < 6) {
      const err = new Error('Neues Passwort muss mindestens 6 Zeichen lang sein');
      err.status = 400;
      throw err;
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      const err = new Error('User nicht gefunden');
      err.status = 404;
      throw err;
    }

    const valid = bcrypt.compareSync(currentPassword, user.passwordHash);
    if (!valid) {
      const err = new Error('Aktuelles Passwort ist falsch');
      err.status = 401;
      throw err;
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await userRepository.updateById(userId, { passwordHash });
    return { success: true };
  },

  /**
   * Verify a JWT token.
   * @param {string} token
   * @returns {{ valid: boolean, username?: string, role?: string }}
   */
  verifyToken: (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      return { valid: true, username: payload.username, role: payload.role };
    } catch {
      return { valid: false };
    }
  },
};
