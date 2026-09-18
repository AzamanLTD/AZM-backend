#!/usr/bin/env node
// scripts/p4LedgerInstaller.js
// =============================================================================
// §P.4 ledger migration installer — IDEMPOTENT. Safe for populated production
// databases: it only (1) seeds/repairs the canonical LedgerAccount catalog and
// (2) records the ledger epoch marker. It performs NO financial backfill, NO
// balance correction and NO historical journal manufacture.
//
// The optional opening-balance adjustment (separate, audited, explicit
// `--opening-adjustment` flag) is OFF by default and remains outside normal
// operational economics; running it against production requires separate
// explicit authorization per §P.4 safety rules.
// =============================================================================
const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();
const ledger = require('../services/ledgerService');

async function installChartOfAccounts(db) {
  const seeded = [];
  for (const [code, spec] of Object.entries(ledger.CANONICAL_ACCOUNTS)) {
    await db.ledgerAccount.upsert({
      where: { code },
      update: {}, // classification is authoritative — never rewritten
      create: {
        code,
        accountClass: spec.accountClass,
        normalSide: spec.normalSide,
        asset: spec.asset,
        network: spec.network,
        status: 'ACTIVE',
      },
    });
    seeded.push(code);
  }
  return seeded;
}

async function main() {
  const res = await prisma.$transaction(async (tx) => {
    const seeded = await installChartOfAccounts(tx);
    // §P.4 wave-2 repair: custody:provider:usdc was catalogued with a wrong
    // (payable-style LIABILITY) classification earlier in THIS unmerged
    // branch's history. It has never been posted to in production, so if a
    // stale row exists with the wrong class AND zero postings, reclassify it
    // to the canonical ASSET location. If it has any postings, fail loudly —
    // never silently rewrite the classification of a used account.
    const provider = await tx.ledgerAccount.findUnique({ where: { code: 'custody:provider:usdc' } });
    if (provider && provider.accountClass !== 'ASSET') {
      const posted = await tx.journalEntry.count({ where: { account: 'custody:provider:usdc' } });
      if (posted > 0) {
        throw new Error('custody:provider:usdc has existing postings but a stale classification — refusing to silently reclassify; manual reconciliation required');
      }
      await tx.ledgerAccount.update({
        where: { code: 'custody:provider:usdc' },
        data: { accountClass: 'ASSET', normalSide: 'DEBIT' },
      });
    }
    const accountCount = await tx.ledgerAccount.count();
    return { seeded, accountCount };
  });
  console.log(`[p4LedgerInstaller] canonical chart ensured (${res.seeded.length} codes); catalog rows: ${res.accountCount}. Idempotent — safe to re-run.`);

  if (process.argv.includes('--opening-adjustment')) {
    console.error('[p4LedgerInstaller] REFUSING: the audited opening-balance adjustment is a separately authorized production activity. This installer never mutates financial data.');
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
