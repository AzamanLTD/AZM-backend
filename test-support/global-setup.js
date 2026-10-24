// test-support/global-setup.js — jest globalSetup (runs ONCE, before any
// suite, in both CI and local gates).
//
// WHY THIS EXISTS
// ───────────────
// A freshly-pushed CI database (prisma db push --accept-data-loss + the
// overlay installer chain) carries the schema and every overlay table, but
// NOT the runtime singleton rows that the release/deploy chain and the live
// gateway converge on first use. The suite battery historically ran against
// local databases that had accumulated those singletons from earlier
// sessions, so suites could silently assume they exist (e.g.
// p5d-fiat-liquidity-authority's setAuthorityFlag upserts GlobalSettings
// WITHOUT the NOT NULL rate columns — valid only as an UPDATE against an
// existing row). Jest's default sequencer orders suites by file size, so
// adding or resizing any test file can reorder the battery and put such a
// suite FIRST against a still-empty database, failing the whole gate (and
// the residue from those early failures then cascades into later suites).
//
// The fix is the same contract the runtime guarantees: GlobalSettings id=1
// EXISTS from the start. Every column carries a schema default except
// updatedAt (Prisma-managed @updatedAt, no DB default), so the canonical
// fresh-install insert is the bare key + a timestamp. Suites that need
// specific rate/source values set and restore them themselves.
//
// Deliberately NOT seeded here: SystemFiatPool, SystemMasterCrypto,
// SystemProfitFees, FiatLiquidityState — suites either upsert their own
// instance or explicitly leave them in the fresh-install posture (see
// p5d's afterAll), and pre-seeding would contaminate the
// order-independence contract in the other direction.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.test') });

const dbUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/azm_test';

module.exports = async () => {
    process.env.DATABASE_URL = dbUrl;
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';

    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    try {
        await prisma.$executeRaw`INSERT INTO "GlobalSettings" ("id", "updatedAt") VALUES (1, now()) ON CONFLICT ("id") DO NOTHING`;
    } finally {
        await prisma.$disconnect();
    }
};
