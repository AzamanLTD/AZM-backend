'use strict';

// infra/install-native-ghs-settlement-overlay.js — native-GHS settlement.
//
// Idempotent structural overlay for the native-GHS collection settlement
// authority (owner intent, #369). Mirrors the established overlay pattern:
// safe on an empty database, safe on a populated production database, safe
// to re-run any number of times.
//
// Structures installed:
//   • GlobalSettings."nativeGhsSettlementEnabled" BOOLEAN NOT NULL DEFAULT
//     false — the rollout authority. OFF (the shipped default) keeps the
//     legacy USDC conversion credit byte-identical; ON settles settled
//     Moolre collections into the customer's native-GHS wallet in exact
//     pesewas. The column ships NOT NULL DEFAULT false so every existing
//     production row inherits the disabled behaviour with no data change.
//
// Release-chain contract (mirrors every other overlay): wired into
// `npm run release`, the CI test workflow, the financial-durability
// workflow, and the converge prod-branch chain — see
// docs/native-ghs-settlement.md.

const { PrismaClient } = require('@prisma/client');

const STATEMENTS = [
    `ALTER TABLE "GlobalSettings"
       ADD COLUMN IF NOT EXISTS "nativeGhsSettlementEnabled" BOOLEAN NOT NULL DEFAULT false;`,
];

async function main() {
    const prisma = new PrismaClient();
    try {
        for (const sql of STATEMENTS) {
            await prisma.$executeRawUnsafe(sql);
        }
        process.stdout.write('[install-native-ghs-settlement-overlay] ok: nativeGhsSettlementEnabled guard in place\\n');
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[install-native-ghs-settlement-overlay] FAILED:', err && err.message);
        process.exit(1);
    });
}

module.exports = { STATEMENTS };
