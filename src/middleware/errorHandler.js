// src/middleware/errorHandler.js
// =============================================================================
// Centralized Express error handling — 404 catch-all, Sentry integration,
// and the global error handler with production-safe message sanitization.
// =============================================================================

const logger = require('../config/logger');

/**
 * Mount the 404 catch-all, optional Sentry error handler, and the global
 * error handler onto an Express app. Must be called AFTER all routes are
 * registered.
 *
 * @param {import('express').Express} app
 * @param {{ Sentry?: object, isProduction: boolean }} opts
 */
function mountErrorHandlers(app, { Sentry, isProduction } = {}) {
    // 404 catch-all
    app.use((req, res) => {
        res.status(404).json({ success: false, error: 'Endpoint not found', path: req.originalUrl });
    });

    // WS6: Sentry error handler — must come AFTER all controllers/routes and the
    // 404 catch-all, but BEFORE our own error responder so the exception is
    // captured first, then formatted for the client below. No-op without SENTRY_DSN.
    if (Sentry && process.env.SENTRY_DSN) {
        Sentry.setupExpressErrorHandler(app);
    }

    // HIGH-4: Global error handler — sanitize in production
    app.use((err, req, res, next) => {
        logger.error({ err }, 'Server error');
        if (!isProduction) {
            logger.error({ err }, err.stack);
        }

        // Multer file size error
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                success: false,
                message: 'File too large. Maximum size is 5MB.'
            });
        }

        // Multer file type error
        if (err.message && err.message.includes('Only image files')) {
            return res.status(400).json({
                success: false,
                message: err.message
            });
        }

        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            // HIGH-4: Only expose details in non-production
            ...(isProduction ? {} : { details: err.message })
        });
    });
}

module.exports = { mountErrorHandlers };
