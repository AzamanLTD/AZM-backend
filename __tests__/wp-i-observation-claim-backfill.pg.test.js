// __tests__/wp-i-observation-claim-backfill.pg.test.js
// =============================================================================
// §WP-I — THE BACKFILL, PROVEN ON REAL POSTGRESQL
//
// The installer exists because observations consumed BEFORE this release have no
// claim row. Getting that wrong is expensive in both directions:
//
//   * claim too much — treat a provider EVENT (a payment that was merely
//     observed, or was still pending) as an economic use, and a deposit that
//     never settled is blocked from ever settling;
//   * claim too little — miss a settled deposit or a treasury witness, and the
//     same provider payment can be consumed twice on a live system;
//   * resolve a collision by picking a winner — two economic uses share one
//     reference, and a judgement made by a script silently pays or blocks the
//     wrong one. That is an operator's decision, not the installer's.
//
// Nothing here is mocked. The installer runs as its own process, exactly as the
// release chain runs it, against real PostgreSQL.
// =============================================================================
'use strict';

const DB_URL = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

if (!DB_URL && IS_CI) {
    test('WP-I claim backfill requires TEST_DATABASE_URL in CI', () => {
        throw new Error('TEST_DATABASE_URL is not set: a skipped backfill proof must not look like a green build');
    });
}

const run = DB_URL ? describe : describe.skip;

run('§WP-I — provider-observation claim backfill (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const { canonicalObservationIdentity } = require('../src/services/providerObservationIdentity');

    const REPO = path.join(__dirname, '..');
    const INSTALLER = path.join(REPO, 'infra', 'install-provider-observation-claim.js');
    const SQL_FILE = path.join(REPO, 'infra', 'sql', 'provider-observation-claim.sql');

    const tag = `bf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ref = (n) => `${tag}-${n}`;
    const key = (r) => `moolre|collection|${r}`;

    // The three references that MUST end up claimed.
    const SETTLED_REF = ref('settled');
    const WITNESS_REF = ref('witness');
    // References that must NOT be claimed on their own.
    const PENDING_REF = ref('pending');
    const EVENT_ONLY_REF = ref('eventonly');
    // One reference used economically on BOTH paths.
    const COLLIDE_REF = ref('collide');

    let prisma;
    let userId;
    let settledTxId;
    let collideTxId;

    /** Run the installer exactly as the release chain does. */
    function runInstaller(extraArgs = [], dbUrl = DB_URL) {
        const res = spawnSync(process.execPath, [INSTALLER, ...extraArgs], {
            cwd: REPO,
            env: { ...process.env, DATABASE_URL: dbUrl },
            encoding: 'utf8',
        });
        return {
            code: res.status,
            stdout: res.stdout || '',
            stderr: res.stderr || '',
        };
    }

    /** The counts the installer prints, so results are asserted, not inferred. */
    function reported(out) {
        const pick = (name) => {
            const m = out.match(new RegExp(`${name}=([0-9]+)`));
            return m ? Number(m[1]) : null;
        };
        return {
            depositClaims: pick('depositClaims'),
            witnessClaims: pick('witnessClaims'),
            installed: /installed=(true|false)/.exec(out)?.[1] === 'true',
        };
    }

    const claimsFor = (refs) =>
        prisma.providerObservationClaim.findMany({
            where: { observationKey: { in: refs.map(key) } },
            select: { observationKey: true, purpose: true, claimedByRef: true, provider: true },
        });

    beforeAll(async () => {
        prisma = new PrismaClient();
        await prisma.$connect();

        // Start from a known state for this tag only.
        await prisma.providerObservationClaim.deleteMany({ where: { observationKey: { contains: tag } } });

        const user = await prisma.user.create({
            data: { username: tag, email: `${tag}@example.invalid`, password: 'not-a-real-hash' },
        });
        userId = user.id;

        // 1. A genuinely settled customer deposit: COMPLETED, with the exact
        //    provider reference the settlement committed with.
        const settled = await prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'COMPLETED',
                amountUsdc: '10.00000000',
                amountGhs: '120.00',
                txHash: `${tag}-settled-tx`,
                metadata: { provider: 'moolre', settlementExternalRef: SETTLED_REF },
            },
        });
        settledTxId = settled.id;

        // 2. A deposit that has NOT settled. Same shape, same metadata, but the
        //    money never committed, so it is not an economic use.
        await prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'PENDING',
                amountUsdc: '10.00000000',
                amountGhs: '120.00',
                txHash: `${tag}-pending-tx`,
                metadata: { provider: 'moolre', settlementExternalRef: PENDING_REF },
            },
        });

        // 3. A provider EVENT with no money behind it at all — an observation
        //    recorded before any settlement. This is the trap: it is the same
        //    provider, the same reference shape, and nothing was paid out.
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE',
                direction: 'INBOUND',
                status: 'PENDING',
                providerRef: EVENT_ONLY_REF,
                dedupKey: `${tag}-event-only`,
                amountGhs: '120.00',
            },
        });

        // 4. A treasury witness, whose reference comes from its own requestParams.
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-1`,
                provider: 'MOOLRE',
                fundingType: 'COLLECTION',
                witnessKind: 'payment_status_lookup',
                walletAccount: '0244000000',
                currency: 'GHS',
                netPesewas: 12000n,
                grossPesewas: 12000n,
                providerState: 'settled',
                endpoint: '/payment/status',
                requestParams: { id: WITNESS_REF },
                rawResponseDigest: 'digest-1',
                rawResponse: JSON.stringify({ status: 1, data: { transactionid: WITNESS_REF } }),
                fetchedAt: new Date(),
            },
        });

        // 5. A witness carrying NO derivable reference: nothing to key on, so it
        //    must be counted as skipped rather than guessed at.
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-2`,
                provider: 'MOOLRE',
                fundingType: 'COLLECTION',
                witnessKind: 'payment_status_lookup',
                walletAccount: '0244000000',
                currency: 'GHS',
                netPesewas: 5000n,
                providerState: 'settled',
                endpoint: '/payment/status',
                requestParams: {},
                rawResponseDigest: 'digest-2',
                rawResponse: 'not json at all',
                fetchedAt: new Date(),
            },
        });

        // 6. The historical cross-path collision: one provider reference that is
        //    BOTH a settled deposit and a treasury witness.
        const collideTx = await prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'COMPLETED',
                amountUsdc: '5.00000000',
                amountGhs: '60.00',
                txHash: `${tag}-collide-tx`,
                metadata: { provider: 'moolre', settlementExternalRef: COLLIDE_REF },
            },
        });
        collideTxId = collideTx.id;

        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-3`,
                provider: 'MOOLRE',
                fundingType: 'COLLECTION',
                witnessKind: 'payment_status_lookup',
                walletAccount: '0244000000',
                currency: 'GHS',
                netPesewas: 6000n,
                providerState: 'settled',
                endpoint: '/payment/status',
                requestParams: { id: COLLIDE_REF },
                rawResponseDigest: 'digest-3',
                rawResponse: JSON.stringify({ status: 1 }),
                fetchedAt: new Date(),
            },
        });
    }, 60000);

    afterAll(async () => {
        if (prisma) {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: { contains: tag } } });
            await prisma.providerSettlementWitness.deleteMany({ where: { openingDedupKey: { contains: tag } } });
            await prisma.fiatProviderEvent.deleteMany({ where: { dedupKey: { contains: tag } } });
            await prisma.transactionHistory.deleteMany({ where: { txHash: { contains: tag } } });
            if (userId) await prisma.user.deleteMany({ where: { id: userId } });
            await prisma.$disconnect();
        }
    }, 60000);

    // ── the overlay and the constraint it relies on ───────────────────────────

    test('the overlay is idempotent DDL and the database really enforces one claim per observation', async () => {
        const sql = fs.readFileSync(SQL_FILE, 'utf8');

        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "ProviderObservationClaim"/);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "ProviderObservationClaim_observationKey_key"/);
        // The unique index is the arbiter, so it must be on the observation key
        // itself, not on a surrogate id.
        expect(sql).toMatch(/"observationKey"\)/);

        const idx = await prisma.$queryRawUnsafe(
            `SELECT indexdef FROM pg_indexes
              WHERE tablename = 'ProviderObservationClaim' AND indexname = 'ProviderObservationClaim_observationKey_key'`,
        );
        expect(idx.length).toBe(1);
        expect(idx[0].indexdef).toMatch(/UNIQUE INDEX/);
        expect(idx[0].indexdef).toMatch(/"observationKey"/);
    });

    test('the database refuses a second claim for the same observation', async () => {
        const k = key(ref('unique-probe'));
        await prisma.providerObservationClaim.create({
            data: { observationKey: k, purpose: 'CUSTOMER_DEPOSIT', claimedByRef: 'probe', provider: 'moolre' },
        });
        await expect(
            prisma.providerObservationClaim.create({
                data: { observationKey: k, purpose: 'TREASURY_WITNESS', claimedByRef: 'probe2', provider: 'moolre' },
            }),
        ).rejects.toThrow();
        await prisma.providerObservationClaim.deleteMany({ where: { observationKey: k } });
    });

    // ── nothing unrelated moves ───────────────────────────────────────────────

    test('a backfill run mutates claims only: no balance, ledger, reserve or witness movement', async () => {
        const snapshot = async () => {
            const [users, txs, witnesses] = await Promise.all([
                prisma.$queryRawUnsafe(
                    `SELECT COALESCE(SUM("nativeGhsBalance"),0)::text AS ghs,
                            COALESCE(SUM("availableBalance"),0)::text AS usdc,
                            COALESCE(SUM("escrowLockedBalance"),0)::text AS escrow
                       FROM "User"`,
                ),
                prisma.$queryRawUnsafe(
                    `SELECT count(*)::int AS n,
                            COALESCE(SUM("amountUsdc"),0)::text AS usdc,
                            COALESCE(SUM("amountGhs"),0)::text AS ghs
                       FROM "TransactionHistory"`,
                ),
                prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ProviderSettlementWitness"`),
            ]);
            return {
                balances: users[0],
                ledger: txs[0],
                witnesses: witnesses[0].n,
                claims: await prisma.providerObservationClaim.count(),
            };
        };

        const before = await snapshot();
        const res = runInstaller();
        expect(res.code).toBe(0);
        const after = await snapshot();

        expect(after.balances).toEqual(before.balances);
        expect(after.ledger).toEqual(before.ledger);
        expect(after.witnesses).toBe(before.witnesses);
        // And the run did claim the candidates it should have.
        expect(after.claims).toBeGreaterThan(before.claims);
    }, 60000);

    // ── what is claimed, and what is deliberately not ──────────────────────────

    test('only economically settled observations are claimed', async () => {
        const res = runInstaller();
        expect(res.code).toBe(0);
        const report = reported(res.stdout);
        expect(report.installed).toBe(true);

        const rows = await claimsFor([SETTLED_REF, PENDING_REF, EVENT_ONLY_REF, WITNESS_REF, COLLIDE_REF]);
        const byKey = new Map(rows.map((r) => [r.observationKey, r]));

        // A settled deposit is a customer-deposit claim, attributed to the exact
        // transaction that settled.
        const settledClaim = byKey.get(key(SETTLED_REF));
        expect(settledClaim).toBeDefined();
        expect(settledClaim.purpose).toBe('CUSTOMER_DEPOSIT');
        expect(settledClaim.claimedByRef).toBe(settledTxId);
        expect(settledClaim.provider).toBe('moolre');

        // A treasury witness is a witness claim, attributed to its opening.
        const witnessClaim = byKey.get(key(WITNESS_REF));
        expect(witnessClaim).toBeDefined();
        expect(witnessClaim.purpose).toBe('TREASURY_WITNESS');
        expect(witnessClaim.claimedByRef).toBe(`${tag}-opening-1`);

        // The two non-settled observations are NOT claimed. This is the whole
        // point: an observation is not an economic use.
        expect(byKey.has(key(PENDING_REF))).toBe(false);
        expect(byKey.has(key(EVENT_ONLY_REF))).toBe(false);

        // Exactly the two settled observations are claimed for this tag: the
        // reference-less witness invented no key, so it is absent rather than
        // present under a guessed reference.
        // The collision key is now present as a QUARANTINE row (see the
        // collision test): present, but owned by neither path.
        expect([...byKey.keys()].sort()).toEqual([key(SETTLED_REF), key(WITNESS_REF), key(COLLIDE_REF)].sort());
        expect(byKey.get(key(COLLIDE_REF)).purpose).toBe('QUARANTINE');
        const invented = await prisma.providerObservationClaim.count({
            where: { claimedByRef: `${tag}-opening-2` },
        });
        expect(invented).toBe(0);
        // And the installer says so out loud, instead of dropping it silently.
        expect(res.stdout).toMatch(/skipped\(deposits=\d+,witnesses=[1-9]\d*,nonMoolreProvider=\d+\)/);
    }, 60000);

    test('the backfilled key is byte-identical to the key the runtime claims with', () => {
        // If these diverge, a backfilled claim protects nothing: the live path
        // would look up a different key and consume the same payment again.
        const runtime = canonicalObservationIdentity({ provider: 'moolre', reference: SETTLED_REF });
        expect(runtime.observationKey).toBe(key(SETTLED_REF));

        const witnessKey = canonicalObservationIdentity({ provider: 'moolre', reference: WITNESS_REF });
        expect(witnessKey.observationKey).toBe(key(WITNESS_REF));
    });

    // ── the collision ─────────────────────────────────────────────────────────

    test('a historical cross-path collision is quarantined so NEITHER path can consume it again', async () => {
        const res = runInstaller();
        expect(res.code).toBe(0);

        // Reporting alone was not enough: with no row for the key, whichever
        // path ran next would claim it and the second economic use would
        // proceed. The collision is therefore quarantined — a claim row that
        // names no legitimate owner.
        const rows = await claimsFor([COLLIDE_REF]);
        expect(rows).toHaveLength(1);
        expect(rows[0].purpose).toBe('QUARANTINE');
        expect(rows[0].claimedByRef).toBeNull();

        // And the operator is told, with both sides named, on stderr.
        expect(res.stderr).toMatch(/COLLISION/i);
        expect(res.stderr).toContain(key(COLLIDE_REF));
        expect(res.stderr).toContain(collideTxId);
        expect(res.stderr).toContain(`${tag}-opening-3`);
        expect(res.stderr).toMatch(/operator review/i);
    }, 60000);

    test('the quarantined observation is refused by BOTH economic paths at runtime', async () => {
        const { claimProviderObservation, CLAIM_PURPOSE } = require('../src/services/providerObservationClaimService');
        // A fresh installer run first, exactly as the release chain does it.
        expect(runInstaller().code).toBe(0);

        const purposes = [CLAIM_PURPOSE.CUSTOMER_DEPOSIT, CLAIM_PURPOSE.TREASURY_WITNESS];
        for (const purpose of purposes) {
            await expect(
                prisma.$transaction((tx) => claimProviderObservation(tx, {
                    provider: 'moolre',
                    reference: COLLIDE_REF,
                    purpose,
                    claimedByRef: `${purpose}-after-quarantine`,
                })),
            ).rejects.toMatchObject({ code: 'OBSERVATION_QUARANTINED' });
        }

        // Still exactly one row, still ownerless: a retry neither resolves it
        // nor picks a winner.
        const rows = await claimsFor([COLLIDE_REF]);
        expect(rows).toHaveLength(1);
        expect(rows[0].claimedByRef).toBeNull();
    }, 60000);

    test('unrelated providers are not classified as Moolre observations', async () => {
        const foreignRef = ref('paystack');
        const unmarkedRef = ref('unmarked');
        await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_FIAT', status: 'COMPLETED',
                amountUsdc: '5.00000000', amountGhs: '60.00', txHash: `${tag}-paystack-tx`,
                metadata: { provider: 'paystack', settlementExternalRef: foreignRef },
            },
        });
        await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_FIAT', status: 'COMPLETED',
                amountUsdc: '6.00000000', amountGhs: '72.00', txHash: `${tag}-unmarked-tx`,
                metadata: { settlementExternalRef: unmarkedRef },
            },
        });
        // ...and a witness recorded by a different provider.
        const foreignWitnessRef = ref('mtnwitness');
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-foreign`,
                provider: 'MTN',
                fundingType: 'COLLECTION',
                witnessKind: 'payment_status_lookup',
                walletAccount: '0244000001',
                currency: 'GHS',
                netPesewas: 6000n,
                grossPesewas: 6000n,
                providerState: 'settled',
                endpoint: '/payment/status',
                requestParams: { id: foreignWitnessRef },
                rawResponseDigest: 'digest-foreign',
                rawResponse: JSON.stringify({ status: 1, data: { transactionid: foreignWitnessRef } }),
                fetchedAt: new Date(),
            },
        });

        const res = runInstaller();
        expect(res.code).toBe(0);

        // A settlement reference is not a Moolre observation merely because a
        // metadata field carries it, and the same holds for a witness recorded
        // by another provider.
        const rows = await claimsFor([foreignRef, unmarkedRef, foreignWitnessRef]);
        expect(rows).toHaveLength(0);
        // And the installer reports what it declined to classify.
        expect(res.stdout).toMatch(/nonMoolreProvider=[1-9]/);
    }, 60000);

    test('re-running the installer neither duplicates nor re-quarantines', async () => {
        const first = runInstaller();
        const second = runInstaller();
        expect(first.code).toBe(0);
        expect(second.code).toBe(0);
        expect(Number(/quarantined=(\d+)/.exec(second.stdout)?.[1])).toBe(0);
        const rows = await claimsFor([COLLIDE_REF]);
        expect(rows).toHaveLength(1);
    }, 60000);

    // ── idempotency    }, 60000);

    // ── idempotency ───────────────────────────────────────────────────────────

    test('re-running the installer is a no-op that reports zero new claims', async () => {
        const first = runInstaller();
        expect(first.code).toBe(0);
        const countAfterFirst = await prisma.providerObservationClaim.count();

        const second = runInstaller();
        expect(second.code).toBe(0);
        const report = reported(second.stdout);
        expect(report.depositClaims).toBe(0);
        expect(report.witnessClaims).toBe(0);

        const countAfterSecond = await prisma.providerObservationClaim.count();
        expect(countAfterSecond).toBe(countAfterFirst);
    }, 60000);

    // ── failure is loud, and leaves nothing half-written ───────────────────────

    test('a failing insert makes the run fail non-zero and leaves no partial claims', async () => {
        const freshRef = ref('after-failure');
        const tx = await prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'COMPLETED',
                amountUsdc: '1.00000000',
                amountGhs: '12.00',
                txHash: `${tag}-after-failure`,
                metadata: { provider: 'moolre', settlementExternalRef: freshRef },
            },
        });

        // Deterministically deny writes at the claim table itself, which is a
        // failure AFTER candidate selection and after the DDL step.
        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "${tag}_deny_claim"() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'claim table locked for test'; END;
            $$ LANGUAGE plpgsql;
        `);
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER "${tag}_deny_claim" BEFORE INSERT ON "ProviderObservationClaim"
            FOR EACH ROW EXECUTE FUNCTION "${tag}_deny_claim"();
        `);

        try {
            const res = runInstaller();
            expect(res.code).not.toBe(0);
            expect(res.stderr).toMatch(/FAILED/);

            // Nothing from this run landed, including the candidate it had
            // already selected.
            const rows = await claimsFor([freshRef]);
            expect(rows).toHaveLength(0);
        } finally {
            await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${tag}_deny_claim" ON "ProviderObservationClaim";`);
            await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${tag}_deny_claim"();`);
            await prisma.transactionHistory.deleteMany({ where: { txHash: `${tag}-after-failure` } });
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(freshRef) } });
        }
    }, 60000);

    test('an unreachable database fails loudly instead of reporting a clean install', () => {
        const res = runInstaller([], 'postgresql://postgres:postgres@127.0.0.1:1/nonexistent');
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/FAILED/);
        expect(reported(res.stdout).installed).toBe(false);
    }, 60000);

    // ── dry run ───────────────────────────────────────────────────────────────

    test('--dry-run selects the same candidates but writes nothing', async () => {
        const dryRef = ref('dry');
        await prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status: 'COMPLETED',
                amountUsdc: '2.00000000',
                amountGhs: '24.00',
                txHash: `${tag}-dry`,
                metadata: { provider: 'moolre', settlementExternalRef: dryRef },
            },
        });

        const res = runInstaller(['--dry-run']);
        expect(res.code).toBe(0);
        const rows = await claimsFor([dryRef]);
        expect(rows).toHaveLength(0);

        // The same reference IS claimed by a real run, so the dry run was a
        // genuine preview rather than a selection bug.
        expect(runInstaller().code).toBe(0);
        const after = await claimsFor([dryRef]);
        expect(after).toHaveLength(1);
        expect(after[0].purpose).toBe('CUSTOMER_DEPOSIT');

        await prisma.transactionHistory.deleteMany({ where: { txHash: `${tag}-dry` } });
    }, 60000);
});
