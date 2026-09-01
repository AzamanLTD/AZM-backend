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

const MoolreDisbursementService = require('../../services/moolreDisbursementService');
const mtnDisbursementService = new MoolreDisbursementService(prisma);

const MoolreCollectionService = require('../../services/moolreCollectionService');
const moolreCollectionService = new MoolreCollectionService(prisma);

const PaymentFailoverService = require('../../services/paymentFailoverService');
const paymentFailoverService = new PaymentFailoverService(prisma);

const TatumService = require('../../services/tatumService');
const tatumService = new TatumService(prisma);

const EmailService = require('../../services/emailService');
const emailService = new EmailService();
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
