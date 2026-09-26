#!/usr/bin/env node
// infra/encrypt-id-numbers.js
// =============================================================================
// One-shot, idempotent backfill: encrypt any plaintext User.idNumber values
// at rest (Phase 5 / Workstream A). Safe to re-run — already-encrypted rows
// are skipped (fieldCipher.isEncrypted), and encryption is a no-op without
// ENCRYPTION_KEY.
//
// Run standalone:   node infra/encrypt-id-numbers.js
// Or in-process from autoRelease at boot (free-tier path).
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const fieldCipher = require('../services/crypto/fieldCipher');

/**
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<{ scanned: number, encrypted: number, skipped: number }>}
 */
async function encryptIdNumbers(client) {
  const prisma = client || new PrismaClient();
  const ownClient = !client;
  const stats = { scanned: 0, encrypted: 0, skipped: 0 };
  try {
    // No-op when encryption isn't configured — nothing to migrate to.
    if (!fieldCipher.isConfigured()) {
      logger.info('[encrypt-id-numbers] ENCRYPTION_KEY not set — skipping backfill.');
      return stats;
    }

    const rows = await prisma.user.findMany({
      where: { idNumber: { not: null } },
      select: { id: true, idNumber: true },
    });
    stats.scanned = rows.length;

    for (const row of rows) {
      if (fieldCipher.isEncrypted(row.idNumber)) {
        stats.skipped += 1;
        continue;
      }
      const enc = fieldCipher.encrypt(row.idNumber);
      // Guard: only write if encryption actually changed the value.
      if (enc !== row.idNumber) {
        await prisma.user.update({
          where: { id: row.id },
          data: { idNumber: enc },
        });
        stats.encrypted += 1;
      } else {
        stats.skipped += 1;
      }
    }

    logger.info(
      `[encrypt-id-numbers] done: scanned=${stats.scanned} ` +
      `encrypted=${stats.encrypted} skipped=${stats.skipped}`,
    );
    return stats;
  } finally {
    if (ownClient) await prisma.$disconnect();
  }
}

module.exports = { encryptIdNumbers };

if (require.main === module) {
  encryptIdNumbers()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err }, '[encrypt-id-numbers] fatal');
      process.exit(1);
    });
}
