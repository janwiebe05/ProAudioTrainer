'use strict';

const userRepository = require('../repositories/userRepository');
const authService = require('./authService');
const { requireFields } = require('../utils/validators');

module.exports = {
  /**
   * List all users (without password hashes).
   * @returns {Promise<object[]>}
   */
  listUsers: async () => {
    const users = await userRepository.findAll();
    return users.map(({ passwordHash, ...u }) => u);
  },

  /**
   * Create a new user (admin action).
   */
  createUser: async (username, password, role) => {
    return await authService.register(username, password, role);
  },

  /**
   * Delete a user by ID.
   * Cannot delete the requesting user.
   */
  deleteUser: async (id, requestingUserId) => {
    if (id === requestingUserId) {
      const err = new Error('Eigenen Account nicht löschbar');
      err.status = 400;
      throw err;
    }

    const user = await userRepository.findById(id);
    if (!user) {
      const err = new Error('User nicht gefunden');
      err.status = 404;
      throw err;
    }

    await userRepository.delete(id);
    return { deleted: true };
  },

  /**
   * Reset a user's password.
   */
  resetPassword: async (id, newPassword) => {
    requireFields({ password: newPassword }, ['password']);

    if (!newPassword || newPassword.length < 6) {
      const err = new Error('Passwort muss mindestens 6 Zeichen lang sein');
      err.status = 400;
      throw err;
    }

    const bcrypt = require('bcryptjs');
    const updated = await userRepository.updateById(id, {
      passwordHash: bcrypt.hashSync(newPassword, 10),
    });

    if (!updated) {
      const err = new Error('User nicht gefunden');
      err.status = 404;
      throw err;
    }

    return { updated: true };
  },
};
