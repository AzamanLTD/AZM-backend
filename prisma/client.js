// prisma/client.js
// =============================================================================
// Singleton PrismaClient export — fallback for routes that aren't mounted
// on the main Express app (which sets app.set('prisma', client) at startup).
// In production, prefer req.app.get('prisma'). This module is only used when
// that's unavailable (e.g. standalone scripts, background workers, tests).
// =============================================================================

const { PrismaClient } = require('@prisma/client');

let _client = null;

function getClient() {
    if (!_client) {
        _client = new PrismaClient({
            log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
        });
    }
    return _client;
}

module.exports = getClient();
