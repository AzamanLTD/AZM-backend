#!/usr/bin/env node
// infra/backfill-azaman-ids.js
// =============================================================================
// One-shot, idempotent backfill for Phase 6 / Social & Vouching Evolution:
//
//   1. Assign a unique Azaman_ID ('AZM-#########') to every User row that
//      doesn't already have one. Existing ids are never overwritten.
//   2. Populate `phoneHash` for any user who already has a verified phone
//      (phoneVerified = true) but no phoneHash yet, so Contact_Discovery
//      works for pre-Phase-6 accounts.
//
// Safe to re-run: rows that already have an azamanId / phoneHash are skipped.
//
// Run standalone:   node infra/backfill-azaman-ids.js
// Or in-process from autoRelease at boot (free-tier path).
// =============================================================================

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const { IdentityService } = require('../services/identity/identity.service');
const { hashPhone } = require('../services/identity/phoneHash');

/**
 * @param {import('@prisma/client').PrismaClient} [client]
 * @returns {Promise<{ scanned, assigned, skipped, phoneHashed }>}
 */
async function backfillAzamanIds(client) {
  const prisma = client || new PrismaClient();
  const ownClient = !client;
  const identity = new IdentityService(prisma);
  const stats = { scanned: 0, assigned: 0, skipped: 0, phoneHashed: 0 };

  try {
    // ── 1. Azaman IDs ──────────────────────────────────────────────────
    // Process in batches to keep memory bounded on large user tables.
    const BATCH = 500;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await prisma.user.findMany({
        where: { azamanId: null },
        select: { id: true },
        take: BATCH,
      });
      if (rows.length === 0) break;
      stats.scanned += rows.length;

      for (const row of rows) {
        try {
          const azamanId = await identity.generateUniqueAzamanId(prisma);
          // updateMany with the null guard makes the assignment idempotent
          // under concurrency: if another worker already set it, count = 0.
          const r = await prisma.user.updateMany({
            where: { id: row.id, azamanId: null },
            data: { azamanId },
          });
          if (r.count > 0) stats.assigned += 1;
          else stats.skipped += 1;
        } catch (err) {
          // Unique-collision race → skip; next pass (or boot) will retry.
          stats.skipped += 1;
          logger.warn(`[backfill-azaman-ids] user ${row.id} skipped: ${err.message}`);
        }
      }
      if (rows.length < BATCH) break;
    }

    // ── 2. phoneHash for already-verified phones ───────────────────────
    const phoneRows = await prisma.user.findMany({
      where: { phoneVerified: true, phoneNumber: { not: null }, phoneHash: null },
      select: { id: true, phoneNumber: true },
    });
    for (const row of phoneRows) {
      const h = hashPhone(row.phoneNumber);
      if (!h) continue;
      await prisma.user.update({
        where: { id: row.id },
        data: { phoneHash: h },
      });
      stats.phoneHashed += 1;
    }

    logger.info(
      `[backfill-azaman-ids] done: scanned=${stats.scanned} assigned=${stats.assigned} ` +
      `skipped=${stats.skipped} phoneHashed=${stats.phoneHashed}`,
    );
    return stats;
  } finally {
    if (ownClient) await prisma.$disconnect();
  }
}

module.exports = { backfillAzamanIds };

if (require.main === module) {
  backfillAzamanIds()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err }, '[backfill-azaman-ids] fatal');
      process.exit(1);
    });
}
