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

// MTN remains the secondary provider for automatic off-ramp failover.
const MtnDisbursementService = require('../../services/mtnDisbursementService');
const mtnFallbackService = new MtnDisbursementService();

// Unlike the legacy I/O adapters above, failover orchestration is a src-level
// domain service and therefore lives under src/services.
const { PaymentFailoverService } = require('../services/paymentFailoverService');
const paymentFailoverService = new PaymentFailoverService({
    providers: [
        { name: 'moolre', instance: moolreDisbursementService, priority: 1 },
        { name: 'mtn', instance: mtnFallbackService, priority: 2 },
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
    mtnDisbursementService: moolreDisbursementService,
    moolreCollectionService,
    paymentFailoverService,
    tatumService,
    emailService,
    smsService,
};