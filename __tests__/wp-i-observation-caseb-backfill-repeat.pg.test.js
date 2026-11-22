// __tests__/wp-i-observation-caseb-backfill-repeat.pg.test.js
// =============================================================================
// §WP-I — REPEATED PRODUCTION BACKFILL PRESERVES ACCUMULATED CASE B EVIDENCE
//
// The Case B writer merges evidence instead of replacing it. A unit test of
// mergeCaseDetails() would prove the JSON helper, not the product. This suite
// runs the ACTUAL production backfill — the release-chain installer
// infra/install-provider-observation-claim.js, as a real child process — THREE
// times against real PostgreSQL, adding evidence between runs, and reads the
// persisted ReconciliationException row each time.
//
// PROVES
//   run 1: the first evidence set creates the case;
//   run 2: the original evidence is still there, the new evidence is appended,
//          identifier arrays are deduplicated, and distinct contradictory
//          references survive;
//   run 3: re-running with no new evidence leaves the stored result unchanged.
//
// The only field that advances on a repeat run is `lastMergedAt`, which by design
// records WHEN the case was last observed. Every semantic field — ties,
// evidenceIds, providerRef, txHash, note — must be identical.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('child_process');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const describeDB = DB_URL ? describe : describe.skip;

const REPO = path.join(__dirname, '..');
const INSTALLER = path.join(REPO, 'infra', 'install-provider-observation-claim.js');
const REASON = 'CONTRADICTORY_PROVIDER_REFERENCE';
const TAG = `cb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Fields that must never change across repeated runs. */
const SEMANTIC_FIELDS = ['ties', 'providerRef', 'txHash', 'evidenceIds', 'note'];

describeDB('§WP-I repeated production backfill — Case B evidence preservation', () => {
    let prisma;
    let userId;
    const depositId = `dep-${TAG}`;
    const merchantRef = `ext-${TAG}`;
    const providerRefA = `provA-${TAG}`;
    const providerRefB = `provB-${TAG}`;
    const txHash = `tx-${TAG}`;
    const eventA = `evtA-${TAG}`;
    const eventB = `evtB-${TAG}`;

    /** Run the REAL production backfill as a child process. */
    function runBackfill() {
        const res = spawnSync(process.execPath, [INSTALLER, '--json'], {
            cwd: REPO,
            env: { ...process.env, DATABASE_URL: DB_URL },
            encoding: 'utf8',
        });
        if (res.status !== 0) {
            throw new Error(`backfill exited ${res.status}: ${(res.stderr || '').slice(0, 800)}`);
        }
        const line = (res.stdout || '').split('\n').reverse().find((l) => l.trim().startsWith('{'));
        return { report: line ? JSON.parse(line) : null, stdout: res.stdout || '' };
    }

    async function readCase() {
        const rows = await prisma.$queryRawUnsafe(
            `SELECT "entityId","reference","reason","status","details"
               FROM "ReconciliationException"
              WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1 AND "reason" = $2
              ORDER BY "entityId" ASC`,
            depositId, REASON,
        );
        return Array.isArray(rows) ? rows : [];
    }

    beforeAll(async () => {
        prisma = new PrismaClient();
        const user = await prisma.user.create({
            data: {
                email: `wp-i-caseb-${TAG}@fixture.invalid`,
                username: `wp-i-caseb-${TAG}`,
                password: 'not-a-real-password-hash',
            },
        });
        userId = user.id;

        // A COMPLETED fiat deposit whose TWO provider references disagree, with no
        // provider event tied to it yet: no agreed wallet exists, so no canonical
        // key can be trusted and the backfill must record a Case B instead of
        // inventing one.
        await prisma.transactionHistory.create({
            data: {
                id: depositId,
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'COMPLETED',
                amountUsdc: '10.00000000',
                amountGhs: '120.00',
                txHash,
                providerRef: providerRefA,
                metadata: {
                    provider: 'MTN_MOMO',
                    selectedRoute: 'MOOLRE_MOMO_COLLECTION',
                    settlementCurrency: 'USDC',
                    settlementExternalRef: merchantRef,
                    settlementProviderRef: providerRefB,
                    quoteId: `${TAG}-quote`,
                },
            },
        });
    }, 60000);

    afterAll(async () => {
        await prisma.$executeRawUnsafe(
            `DELETE FROM "ReconciliationException" WHERE "entityId" = $1`, depositId,
        );
        await prisma.fiatProviderEvent.deleteMany({ where: { dedupKey: { contains: TAG } } });
        await prisma.transactionHistory.deleteMany({ where: { id: depositId } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.$disconnect();
    }, 60000);

    test('run 1 — the production backfill records the first Case B evidence set', async () => {
        runBackfill();

        const rows = await readCase();
        expect(rows).toHaveLength(1);
        const details = rows[0].details;
        expect(rows[0].status).toBe('OPEN');
        // Both contradictory references are retained as distinct ties.
        expect(details.ties).toContain(`providerRef(${providerRefA})`);
        expect(details.ties).toContain(`settlementProviderRef(${providerRefB})`);
        // No event was tied yet, so no evidence id exists — and none was invented.
        expect(details.evidenceIds).toEqual([]);
        expect(details.note).toMatch(/no canonical observation key/i);
    }, 90000);

    test('run 2 — new evidence is appended and the original evidence survives', async () => {
        const before = (await readCase())[0].details;

        // Additional provider evidence for the SAME unresolved case: two events,
        // each tied to the deposit, disagreeing about which wallet received it —
        // so the case stays unresolved rather than collapsing into a claim.
        await prisma.fiatProviderEvent.create({
            data: {
                id: eventA, provider: 'MOOLRE', rail: 'BANK', direction: 'INBOUND',
                status: 'SUCCESSFUL', providerRef: providerRefA, dedupKey: `event:moolre-collection:${merchantRef}-a`,
                amountGhs: '120.00', relatedReference: txHash, walletAccount: '0244000000',
            },
        });
        await prisma.fiatProviderEvent.create({
            data: {
                id: eventB, provider: 'MOOLRE', rail: 'BANK', direction: 'INBOUND',
                status: 'SUCCESSFUL', providerRef: providerRefB, dedupKey: `event:moolre-collection:${merchantRef}-b`,
                amountGhs: '120.00', relatedReference: txHash, walletAccount: '0244000009',
            },
        });

        runBackfill();

        const rows = await readCase();
        expect(rows).toHaveLength(1);
        const after = rows[0].details;

        // 6. the first evidence remains
        expect(after.ties).toEqual(expect.arrayContaining(before.ties));
        expect(after.providerRef).toBe(before.providerRef);
        expect(after.note).toBe(before.note);
        // 7. the new evidence is present
        expect(after.evidenceIds).toEqual(expect.arrayContaining([eventA, eventB]));
        // 8. identifier arrays are deduplicated
        expect(new Set(after.evidenceIds).size).toBe(after.evidenceIds.length);
        expect(new Set(after.ties).size).toBe(after.ties.length);
        // 9. distinct contradictory references are not lost
        expect(after.ties).toContain(`providerRef(${providerRefA})`);
        expect(after.ties).toContain(`settlementProviderRef(${providerRefB})`);
    }, 90000);

    test('run 3 — re-running with no new evidence leaves the stored result unchanged', async () => {
        const before = (await readCase())[0].details;

        runBackfill();

        const rows = await readCase();
        // Still exactly one case: a repeat run accumulates, never duplicates.
        expect(rows).toHaveLength(1);
        const after = rows[0].details;

        // 10. unchanged — every semantic field is byte-identical.
        for (const field of SEMANTIC_FIELDS) {
            expect({ field, value: after[field] }).toEqual({ field, value: before[field] });
        }
        // lastMergedAt is the ONE field that advances, by design: it records when
        // the case was last observed, not what was observed.
        expect(typeof after.lastMergedAt).toBe('string');
    }, 90000);
});
