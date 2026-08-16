#!/usr/bin/env node
/**
 * Idempotent seed for the private-susu-ecosystem feature foundation.
 *
 * Inserts (if missing):
 *   1. The `azaman-treasury` User row (role=ADMIN, kycStatus=VERIFIED) —
 *      this row's `availableBalance` is the canonical Admin_Dispute_Escrow
 *      wallet referenced by Req 10.8 and Req 11.3.
 *   2. The v1.0 LiabilityContractVersion seeded from
 *      infra/liability-contract-v1.0.md, with contractHash =
 *      sha256(body).
 *
 * Both inserts use ON CONFLICT DO NOTHING via Prisma's create+catch
 * pattern so re-running this script is safe.
 *
 * Usage:
 *   node infra/seed-susu-foundation.js
 *
 * Run automatically:
 *   - At local-dev migration time (call from package.json postmigrate)
 *   - On Render via release-phase command after `prisma migrate deploy`
 */

const logger = require('../src/config/logger');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

async function ensureTreasuryWallet(prisma) {
  const existing = await prisma.user.findUnique({
    where: { username: 'azaman-treasury' },
  });
  if (existing) {
    logger.info(`✓ treasury wallet already exists (id=${existing.id})`);
    return existing;
  }
  // Sentinel password value — auth controller refuses any login attempt
  // that targets the treasury account because the bcrypt compare cannot
  // match this string.
  const SENTINEL = '!unusable-treasury-password!';
  const created = await prisma.user.create({
    data: {
      username: 'azaman-treasury',
      email: 'treasury@azaman.internal',
      password: SENTINEL,
      role: 'ADMIN',
      kycStatus: 'VERIFIED',
      proofOfResidencyStatus: 'VERIFIED',
      proofOfResidencyVerifiedAt: new Date(),
      trustRating: 100,
    },
  });
  logger.info(`✓ treasury wallet created (id=${created.id})`);
  return created;
}

async function ensureLiabilityContractV1(prisma, publisherUserId) {
  const bodyPath = path.join(__dirname, 'liability-contract-v1.0.md');
  const body = fs.readFileSync(bodyPath, 'utf8');
  const contractHash = crypto.createHash('sha256').update(body).digest('hex');
  const version = 'v1.0';

  const existing = await prisma.liabilityContractVersion.findUnique({
    where: { version },
  });
  if (existing) {
    if (existing.contractHash !== contractHash) {
      throw new Error(
        `Liability contract ${version} already exists with a different ` +
        `hash (db=${existing.contractHash} file=${contractHash}). Refusing ` +
        `to overwrite. To revise, publish a new version (v1.1) instead.`
      );
    }
    logger.info(`✓ liability contract ${version} already seeded (hash matches)`);
    return existing;
  }
  const created = await prisma.liabilityContractVersion.create({
    data: {
      version,
      contractHash,
      body,
      publishedBy: publisherUserId,
    },
  });
  logger.info(`✓ liability contract ${version} seeded (hash=${contractHash.slice(0, 12)}...)`);
  return created;
}

/**
 * Idempotent seed. Accepts an existing Prisma client (so it can run
 * in-process from autoRelease over the app's pooled connection) or, when
 * run as a CLI, creates its own.
 *
 * @param {import('@prisma/client').PrismaClient} [client]
 */
async function seedSusuFoundation(client) {
  const prisma = client || new PrismaClient();
  const ownClient = !client;
  try {
    const treasury = await ensureTreasuryWallet(prisma);
    await ensureLiabilityContractV1(prisma, treasury.id);
    logger.info('✓ susu-foundation seed complete');
    return treasury;
  } finally {
    if (ownClient) await prisma.$disconnect();
  }
}

module.exports = { seedSusuFoundation };

// CLI entrypoint: `node infra/seed-susu-foundation.js`
if (require.main === module) {
  seedSusuFoundation()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err }, '✗ susu-foundation seed failed');
      process.exit(1);
    });
}
