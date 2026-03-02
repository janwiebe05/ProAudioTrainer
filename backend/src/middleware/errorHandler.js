'use strict';

/**
 * Central error handling middleware.
 * Must be registered LAST in Express (after all routes).
 */
module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Interner Serverfehler';

  // Log server errors for debugging
  if (status >= 500) {
    console.error('[Error]', req.method, req.path, '-', err.stack || err.message);
  }

  res.status(status).json({ error: message });
};
