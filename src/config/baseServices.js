// src/config/baseServices.js
// =============================================================================
// Instantiates the platform's "base layer" services: PostgreSQL pool, Prisma
// client, market oracle, payment gateway, Moolre disbursement/collection,
// Tatum Web3, email, and SMS. These are the leaf dependencies that every
// composite service (see src/services/registry.js) builds on top of.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const { Pool } = require('pg');
const logger = require('../config/logger');

Prisma.Decimal.prototype.toJSON = function () {
    return Number(this.toString());
};
Prisma.Decimal.prototype.valueOf = function () {
    return Number(this.toString());
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle client');
});

// Prisma Client 6 uses its native PostgreSQL driver path. The pg adapter is
// not required by the primary client and is intentionally not loaded here.
const prisma = new PrismaClient();

(async () => {
    try {
        await prisma.$connect();
        logger.info('Prisma connected successfully');
    } catch (error) {
        logger.error({ err: error }, 'Database connection failed');
        process.exit(1);
    }
})();

const { initReadReplica } = require('./readReplica');
initReadReplica();

const OracleService = require('../../services/oracleService');
const marketOracle = new OracleService(prisma);
marketOracle.startOracle();

const GatewayService = require('../../services/gatewayService');
const gatewayService = new GatewayService(prisma);
gatewayService.startRateSync();

// Moolre is the primary fiat disbursement provider.
const MoolreDisbursementService = require('../../services/moolreDisbursementService');
const moolreDisbursementService = new MoolreDisbursementService();

// Moolre fiat collection remains a standalone I/O adapter.
const MoolreCollectionService = require('../../services/moolreCollectionService');
const moolreCollectionService = new MoolreCollectionService();

if (!process.env.MOOLRE_WEBHOOK_SECRET) {
    logger.warn('MOOLRE_WEBHOOK_SECRET is not set — webhook endpoint is disabled');
}

// MOOLRE IS THE ONLY CURRENT EXTERNAL FIAT PROVIDER (r16b P0-A,
// product contract 2026-09-20). MTN / Telecel / AirtelTigo are destination
// NETWORKS under Moolre (channel mapping lives in the Moolre adapter) —
// they are NOT separate Azaman provider contracts. A direct
// MtnDisbursementService is therefore NOT instantiated as a production
// payout provider, and customer money can never fail over onto a direct
// MTN rail. The mtn adapter module and its ownership identity remain
// available for HISTORICAL reconciliation of legacy rows only (see
// services/payoutProviderOwnership.js) — no production dispatch path can
// ever select them.
//
// Unlike the legacy I/O adapters above, failover orchestration is a src-level
// domain service and therefore lives under src/services. The abstraction is
// kept so a future legitimately contracted provider can be added without
// rearchitecting — today the production registry is Moolre-only:
const { PaymentFailoverService } = require('../services/paymentFailoverService');
const paymentFailoverService = new PaymentFailoverService({
    providers: [
        { name: 'moolre', instance: moolreDisbursementService, priority: 1 },
    ],
});

const TatumService = require('../../services/tatumService');
const tatumService = new TatumService();

// The email adapter exports a ready-to-use singleton, not its class.
const emailService = require('../../services/emailService');
const SMSService = require('../../services/smsService');
const smsService = new SMSService();

module.exports = {
    pool,
    prisma,
    marketOracle,
    gatewayService,
    // Historical app-key alias kept for compatibility — it deliberately
    // points at the CANONICAL Moolre instance. Moolre is the current fiat
    // provider; no production code path receives a direct MTN adapter.
    mtnDisbursementService: moolreDisbursementService,
    moolreCollectionService,
    paymentFailoverService,
    tatumService,
    emailService,
    smsService,
};
