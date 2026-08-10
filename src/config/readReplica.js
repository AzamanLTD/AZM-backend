// src/config/readReplica.js
// =============================================================================
// AZAMAN — Read Replica Prisma Client (Phase 2: Scalability & Security)
//
// Creates a secondary PrismaClient that points to a PostgreSQL read replica
// (DATABASE_REPLICA_URL) for heavy read queries — analytics, dashboards,
// leaderboard aggregation, admin reports.
//
// When DATABASE_REPLICA_URL is not set, returns the primary prisma instance.
// This makes the read replica opt-in with zero code changes needed for
// existing callers — they just call getReadPrisma() instead of req.app.get('prisma').
//
// Usage in controllers:
//   const { getReadPrisma } = require('../src/config/readReplica');
//   const readPrisma = getReadPrisma(req.app);
//   const stats = await readPrisma.transactionHistory.aggregate({ ... });
//
// IMPORTANT: Never use the read replica for writes or reads that require
// immediate consistency (e.g. balance checks before a withdrawal). The replica
// may lag by a few seconds. Only use it for analytics, reports, dashboards.
// =============================================================================

const logger = require('./logger');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

let _readPrisma = null;
let _initialized = false;

/**
 * Initialise the read replica connection. Called once at boot.
 * If DATABASE_REPLICA_URL is not set, this is a no-op.
 */
function initReadReplica() {
    if (_initialized) return;
    _initialized = true;

    if (!process.env.DATABASE_REPLICA_URL) {
        logger.info('[ReadReplica] No DATABASE_REPLICA_URL — analytics queries use primary DB');
        return;
    }

    try {
        const pool = new Pool({
            connectionString: process.env.DATABASE_REPLICA_URL,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            logger.error({ err }, '[ReadReplica] Pool error');
        });

        // Guard against adapter-pg major version mismatch (v7 adapter with v6 client)
        let adapterOk = false;
        try {
            const av = require('@prisma/adapter-pg/package.json').version;
            const cv = require('@prisma/client/package.json').version;
            adapterOk = av.split('.')[0] === cv.split('.')[0];
        } catch (_) { adapterOk = false; }

        if (adapterOk) {
            const adapter = new PrismaPg(pool);
            _readPrisma = new PrismaClient({ adapter });
        } else {
            logger.warn('[ReadReplica] Adapter version mismatch — using plain PrismaClient for replica');
            _readPrisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_REPLICA_URL } } });
        }

        // Test connection
        _readPrisma.$connect()
            .then(() => logger.info('[ReadReplica] Connected to read replica'))
            .catch(err => logger.error({ err: err.message }, '[ReadReplica] Connection failed — falling back to primary'));
    } catch (err) {
        logger.warn({ err: err.message }, '[ReadReplica] Failed to initialise, using primary');
        _readPrisma = null;
    }
}

/**
 * Get the read replica PrismaClient. Falls back to primary if replica
 * is not configured or connection failed.
 *
 * @param {import('express').Express} app — Express app instance
 * @returns {PrismaClient}
 */
function getReadPrisma(app) {
    if (_readPrisma) {
        // Health check — if the replica is disconnected, fall back
        return _readPrisma;
    }
    // Fallback to primary
    return app.get('prisma');
}

module.exports = { initReadReplica, getReadPrisma };
