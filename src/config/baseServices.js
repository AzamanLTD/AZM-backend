// src/config/baseServices.js
// =============================================================================
// Instantiates the platform's "base layer" services: PostgreSQL pool, Prisma
// client, market oracle, payment gateway, Moolre disbursement/collection,
// Tatum Web3, email, and SMS. These are the leaf dependencies that every
// composite service (see src/services/registry.js) builds on top of.
//
// Exports: { pool, prisma, marketOracle, gatewayService, mtnDisbursementService,
//           moolreCollectionService, paymentFailoverService, tatumService,
//           emailService, smsService }
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const logger = require('../config/logger');

// ── Phase J3: Prisma Decimal → Number JSON Serialization ─────────────────────
// Prisma returns NUMERIC/DECIMAL columns as Decimal.js objects which serialize
// to strings in JSON ("12.50" instead of 12.50). This patch ensures they
// serialize as plain numbers for all res.json() calls and socket emissions.
Prisma.Decimal.prototype.toJSON = function () {
    return Number(this.toString());
};
Prisma.Decimal.prototype.valueOf = function () {
    return Number(this.toString());
};

// 1. Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle client');
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Test database connection on startup
(async () => {
    try {
        await prisma.$connect();
        logger.info('Prisma connected successfully');
    } catch (error) {
        logger.error({ err: error }, 'Database connection failed');
        process.exit(1);
    }
})();

// ── Read Replica (Phase 2: Scalability & Security) ────────────────────────
// Optional secondary PrismaClient for analytics / dashboard queries.
// Falls back to primary when DATABASE_REPLICA_URL is not set.
const { initReadReplica } = require('./readReplica');
initReadReplica();

// --- LIVE MARKET ORACLE ---
const OracleService = require('../../services/oracleService');
const marketOracle = new OracleService(prisma);
marketOracle.startOracle();

// --- KOTANI PAY V3 GATEWAY ---
const GatewayService = require('../../services/gatewayService');
const gatewayService = new GatewayService(prisma);
gatewayService.startRateSync();

// ── PRIMARY: Moolre (fiat off-ramp disbursement) ──────────────────────────────
const MoolreDisbursementService = require('../../services/moolreDisbursementService');
const mtnDisbursementService = new MoolreDisbursementService();

// ── PRIMARY: Moolre (fiat on-ramp collection) ────────────────────────────────
const MoolreCollectionService = require('../../services/moolreCollectionService');
const moolreCollectionService = new MoolreCollectionService();

if (!process.env.MOOLRE_WEBHOOK_SECRET) {
    logger.warn('MOOLRE_WEBHOOK_SECRET is not set — webhook endpoint is disabled');
}

// ── FALLBACK: MTN MoMo (secondary provider for automatic failover) ─────────
const MtnDisbursementService = require('../../services/mtnDisbursementService');
const mtnFallbackService = new MtnDisbursementService();

// ── PAYMENT FAILOVER SERVICE (wraps Moolre primary + MTN secondary) ─────────
const { PaymentFailoverService } = require('../services/paymentFailoverService');
const paymentFailoverService = new PaymentFailoverService({
    providers: [
        { name: 'moolre', instance: mtnDisbursementService, priority: 1 },
        { name: 'mtn',    instance: mtnFallbackService,     priority: 2 },
    ],
});

// --- TATUM WEB3 SERVICE ---
const TatumService = require('../../services/tatumService');
const tatumService = new TatumService();

// --- EMAIL SERVICE (Phase L1) ---
const emailService = require('../../services/emailService');


// --- SMS SERVICE (Phase L2) ---
const SMSService = require('../../services/smsService');
const smsService = new SMSService();

module.exports = {
    pool,
    prisma,
    marketOracle,
    gatewayService,
    mtnDisbursementService,
    moolreCollectionService,
    paymentFailoverService,
    tatumService,
    emailService,
    smsService,
};
