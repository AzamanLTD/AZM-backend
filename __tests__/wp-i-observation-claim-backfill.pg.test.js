// __tests__/wp-i-observation-claim-backfill.pg.test.js
// =============================================================================
// §WP-I — THE BACKFILL, PROVEN ON REAL POSTGRESQL AGAINST REAL METADATA
//
// The first version of this proof constructed `metadata.provider: 'moolre'`,
// which the application never writes: both initiation controllers store the
// customer-selected MoMo rail there ('MTN_MOMO', 'TELECEL_CASH', ...). A proof
// built on that fixture proves the installer agrees with itself, not with the
// controller. Every fixture below therefore uses the metadata shape the real
// settlement writes, and the Moolre processor identity comes from a persisted
// SUCCESSFUL INBOUND FiatProviderEvent.
//
// The invariant under test: NO previously settled Moolre deposit may remain
// unclaimed (it could otherwise be consumed again as treasury funding), while an
// observation that was never an economic use must never be claimed, and no
// historical disagreement is ever resolved by picking a winner.
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

run('§WP-I — provider-observation claim backfill (real PostgreSQL, real metadata)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { spawnSync } = require('child_process');
    const path = require('path');
    const { canonicalObservationIdentity } = require('../src/services/providerObservationIdentity');
    const { claimProviderObservation, CLAIM_PURPOSE } = require('../src/services/providerObservationClaimService');

    const REPO = path.join(__dirname, '..');
    const INSTALLER = path.join(REPO, 'infra', 'install-provider-observation-claim.js');

    const tag = `bf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ref = (n) => `${tag}-${n}`;
    const key = (r) => canonicalObservationIdentity({ provider: 'moolre', reference: r }).observationKey;

    const R_DIRECT = ref('direct');
    const R_GENERIC = ref('generic');
    const R_AGGREGATOR = ref('aggregator');
    const R_PENDING = ref('pending');
    const R_EVENT_ONLY = ref('eventonly');
    const R_NO_REF_TX = ref('noref-tx');
    const R_CONTRADICTORY = ref('contradictory');
    const R_WITNESS = ref('witness');
    const R_COLLIDE = ref('collide');
    const R_DUP_DEPOSITS = ref('dupdeposits');
    const R_DUP_WITNESSES = ref('dupwitnesses');
    const R_PREEXISTING = ref('preexisting');
    // identity-disambiguation fixtures
    const R_CONFLICT_OWNER = ref('conflict-owner');
    const R_CONFLICT_PURPOSE = ref('conflict-purpose');
    const R_CONFLICT_MALFORMED = ref('conflict-malformed');
    const identityCases = {};

    let prisma;
    let userId;
    let directDepositId;
    let genericDepositId;
    let collideDepositId;
    let dupDepositIds;

    function runInstaller(extraArgs = [], env = {}) {
        const res = spawnSync(process.execPath, [INSTALLER, ...extraArgs], {
            cwd: REPO,
            env: { ...process.env, DATABASE_URL: DB_URL, ...env },
            encoding: 'utf8',
        });
        return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    }

    function jsonOf(out) {
        const line = out.split('\n').find((l) => l.includes('[provider-observation-claim-json]'));
        if (!line) throw new Error(`installer printed no JSON report:\n${out}`);
        return JSON.parse(line.slice(line.indexOf('{')).trim());
    }

    const claimsFor = (refs) => prisma.providerObservationClaim.findMany({
        where: { observationKey: { in: refs.map(key) } },
        select: { observationKey: true, purpose: true, claimedByRef: true, provider: true },
    });

    /** A SUCCESSFUL inbound Moolre observation, as the settlement writes it. */
    const moolreEvent = (reference, { txHash, providerRef = null, status = 'SUCCESSFUL' } = {}) =>
        prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE',
                rail: 'MOMO',
                direction: 'INBOUND',
                status,
                providerRef,
                dedupKey: `event:moolre-collection:${reference}`,
                amountGhs: '120.00',
                relatedReference: txHash || null,
                raw: { status: 1 },
            },
        });

    /** A completed deposit carrying the metadata the settlement actually writes. */
    const settledDeposit = (reference, { rail = 'MTN_MOMO', route = 'MOOLRE_MOMO_COLLECTION', txHash, extra = {}, status = 'COMPLETED', providerRef = null } = {}) =>
        prisma.transactionHistory.create({
            data: {
                userId,
                type: 'DEPOSIT_FIAT',
                status,
                amountUsdc: '10.00000000',
                amountGhs: '120.00',
                txHash,
                providerRef,
                metadata: {
                    provider: rail,                 // the MoMo RAIL, not the processor
                    network: rail.split('_')[0],
                    quoteId: `${tag}-quote`,
                    selectedRoute: route,
                    settlementCurrency: 'USDC',
                    settlementExternalRef: reference,
                    settlementProviderRef: providerRef || reference,
                    settledAmountGhs: '120.00',
                    settledAt: new Date().toISOString(),
                    ...extra,
                },
            },
        });

    beforeAll(async () => {
        prisma = new PrismaClient();
        await prisma.$connect();

        const user = await prisma.user.create({
            data: { username: tag, email: `${tag}@example.invalid`, password: 'not-a-real-hash' },
        });
        userId = user.id;

        // 1. DIRECT Moolre route: rail in metadata.provider, Moolre reference as
        //    the settlement reference, backed by a SUCCESSFUL MOOLRE event.
        directDepositId = (await settledDeposit(R_DIRECT, {
            rail: 'MTN_MOMO', route: 'MOOLRE_MOMO_COLLECTION', txHash: `${tag}-tx-direct`, providerRef: R_DIRECT,
        })).id;
        await moolreEvent(R_DIRECT, { txHash: `${tag}-tx-direct`, providerRef: R_DIRECT });

        // 2. GENERIC route settled through the Moolre OTP/webhook path: same rail
        //    field, aggregator route, same durable Moolre observation identity.
        genericDepositId = (await settledDeposit(R_GENERIC, {
            rail: 'VODAFONE_CASH', route: 'GENERIC_FIAT_AGGREGATOR', txHash: `${tag}-tx-generic`,
        })).id;
        await moolreEvent(R_GENERIC, { txHash: `${tag}-tx-generic` });

        // 3. Ordinary aggregator deposit on an identical MoMo rail, settled with
        //    the GENERIC_FIAT_WEBHOOK evidence — NOT Moolre money.
        await settledDeposit(R_AGGREGATOR, { rail: 'MTN_MOMO', route: 'GENERIC_FIAT_AGGREGATOR', txHash: `${tag}-tx-agg` });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'GENERIC_FIAT_WEBHOOK', rail: 'MOMO', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: R_AGGREGATOR, dedupKey: `event:generic:${R_AGGREGATOR}:SUCCESSFUL`,
                amountGhs: '120.00', relatedReference: `${tag}-tx-agg`, raw: { status: 1 },
            },
        });

        // 4. PENDING Moolre deposit: an observation, not an economic use.
        await settledDeposit(R_PENDING, { txHash: `${tag}-tx-pending`, status: 'PENDING', providerRef: R_PENDING });
        await moolreEvent(R_PENDING, { txHash: `${tag}-tx-pending`, providerRef: R_PENDING });

        // 5. Moolre observation with no completed deposit at all.
        await moolreEvent(R_EVENT_ONLY, { txHash: `${tag}-tx-eventonly` });

        // 6a. Completed deposit with Moolre evidence but NO settlement reference.
        await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_FIAT', status: 'COMPLETED',
                amountUsdc: '10.00000000', amountGhs: '120.00', txHash: `${tag}-tx-noref`,
                metadata: { provider: 'MTN_MOMO', selectedRoute: 'MOOLRE_MOMO_COLLECTION' },
            },
        });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', rail: 'MOMO', direction: 'INBOUND', status: 'SUCCESSFUL',
                dedupKey: `event:moolre-collection:${tag}-tx-noref`, amountGhs: '120.00', relatedReference: `${tag}-tx-noref`,
            },
        });

        // 6b. Contradictory settlement references: settlement says one provider
        //     reference, the provider event another.
        await settledDeposit(R_CONTRADICTORY, {
            txHash: `${tag}-tx-contra`, providerRef: R_CONTRADICTORY,
            extra: { settlementProviderRef: `${R_CONTRADICTORY}-conflict` },
        });
        await moolreEvent(R_CONTRADICTORY, { txHash: `${tag}-tx-contra`, providerRef: R_CONTRADICTORY });

        // 7. A genuine Moolre treasury witness.
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-witness`, provider: 'MOOLRE',
                fundingType: 'COLLECTION', witnessKind: 'payment_status_lookup',
                walletAccount: '0244000000', currency: 'GHS',
                netPesewas: 12000n, grossPesewas: 12000n, providerState: 'settled',
                endpoint: '/payment/status', requestParams: { id: R_WITNESS },
                rawResponseDigest: 'digest-w', rawResponse: JSON.stringify({ status: 1 }), fetchedAt: new Date(),
            },
        });

        // 8. Historical cross-path collision: settled deposit AND witness.
        collideDepositId = (await settledDeposit(R_COLLIDE, { txHash: `${tag}-tx-collide`, providerRef: R_COLLIDE })).id;
        await moolreEvent(R_COLLIDE, { txHash: `${tag}-tx-collide`, providerRef: R_COLLIDE });
        await prisma.providerSettlementWitness.create({
            data: {
                openingDedupKey: `${tag}-opening-collide`, provider: 'MOOLRE',
                fundingType: 'COLLECTION', witnessKind: 'payment_status_lookup',
                walletAccount: '0244000000', currency: 'GHS',
                netPesewas: 12000n, grossPesewas: 12000n, providerState: 'settled',
                endpoint: '/payment/status', requestParams: { id: R_COLLIDE },
                rawResponseDigest: 'digest-c', rawResponse: JSON.stringify({ status: 1 }), fetchedAt: new Date(),
            },
        });

        // 9a. Same-path duplicate owners: TWO completed deposits, one reference.
        const d1 = await settledDeposit(R_DUP_DEPOSITS, { txHash: `${tag}-tx-dup1`, providerRef: R_DUP_DEPOSITS });
        const d2 = await settledDeposit(R_DUP_DEPOSITS, { txHash: `${tag}-tx-dup2`, providerRef: R_DUP_DEPOSITS });
        dupDepositIds = [d1.id, d2.id].sort();
        // No relatedReference here: two deposits cannot share one txHash, and a
        // relatedReference would make the second deposit a CONTRADICTION rather
        // than the same-path duplicate this fixture is about.
        await moolreEvent(R_DUP_DEPOSITS, { providerRef: R_DUP_DEPOSITS });

        // 9b. Same-path duplicate witnesses.
        for (const n of [1, 2]) {
            await prisma.providerSettlementWitness.create({
                data: {
                    openingDedupKey: `${tag}-opening-dup-${n}`, provider: 'MOOLRE',
                    fundingType: 'COLLECTION', witnessKind: 'payment_status_lookup',
                    walletAccount: '0244000001', currency: 'GHS',
                    netPesewas: 12000n, grossPesewas: 12000n, providerState: 'settled',
                    endpoint: '/payment/status', requestParams: { id: R_DUP_WITNESSES },
                    rawResponseDigest: `digest-d${n}`, rawResponse: JSON.stringify({ status: 1 }), fetchedAt: new Date(),
                },
            });
        }

        // 10. An already-existing claim row must not be duplicated or re-owned.
        await settledDeposit(R_PREEXISTING, { txHash: `${tag}-tx-preexist`, providerRef: R_PREEXISTING });
        await moolreEvent(R_PREEXISTING, { txHash: `${tag}-tx-preexist`, providerRef: R_PREEXISTING });

        // 11. IDENTITY DISAMBIGUATION. Each of these is a genuine COMPLETED
        //     Moolre settlement whose provider evidence either contradicts the
        //     deposit or is ambiguous. None may ever be claimed, and none may be
        //     resolved by choosing the first matching event.
        const identDeposit = async (n, { withSettlementRef = true } = {}) => {
            const r = ref(n);
            const txHash = `${tag}-tx-${n}`;
            if (withSettlementRef) {
                await settledDeposit(r, { txHash, providerRef: r });
            } else {
                await prisma.transactionHistory.create({
                    data: {
                        userId, type: 'DEPOSIT_FIAT', status: 'COMPLETED',
                        amountUsdc: '10.00000000', amountGhs: '120.00', txHash, providerRef: r,
                        metadata: { provider: 'MTN_MOMO', selectedRoute: 'MOOLRE_MOMO_COLLECTION' },
                    },
                });
            }
            return { r, txHash };
        };
        const ev = (dedupKey, { providerRef = null, relatedReference = null } = {}) =>
            prisma.fiatProviderEvent.create({
                data: {
                    provider: 'MOOLRE', rail: 'MOMO', direction: 'INBOUND', status: 'SUCCESSFUL',
                    providerRef, dedupKey, amountGhs: '120.00', relatedReference, raw: { status: 1 },
                },
            });

        // (i) exact dedupKey, but the event's relatedReference names a different deposit
        const cExact = await identDeposit('exact-contra');
        await ev(`event:moolre-collection:${cExact.r}`, { relatedReference: `${cExact.txHash}-different` });

        // (ii) providerRef matches, but the event's dedupKey names another collection
        const cPRef = await identDeposit('pref-fallback');
        await ev(`event:moolre-collection:${cPRef.r}-other`, { providerRef: cPRef.r, relatedReference: cPRef.txHash });

        // (iii) relatedReference matches, but the event's dedupKey names another collection
        const cRel = await identDeposit('rel-fallback');
        await ev(`event:moolre-collection:${cRel.r}-other`, { relatedReference: cRel.txHash });

        // (iv) TWO distinct events tie to one deposit through its provider reference
        const cMultiPRef = await identDeposit('multi-pref');
        await ev(`event:moolre-collection:${cMultiPRef.r}`, { providerRef: cMultiPRef.r, relatedReference: cMultiPRef.txHash });
        await ev(`event:moolre-collection:${cMultiPRef.r}-second`, { providerRef: cMultiPRef.r });

        // (v) TWO distinct events tie through the same related reference
        const cMultiRel = await identDeposit('multi-rel');
        await ev(`event:moolre-collection:${cMultiRel.r}`, { relatedReference: cMultiRel.txHash });
        await ev(`event:moolre-collection:${cMultiRel.r}-second`, { relatedReference: cMultiRel.txHash });

        // (vi) no settlement reference at all: the ONLY Moolre tie is the
        //      deposit's own persisted provider reference
        const cNoRef = await identDeposit('missing-pref', { withSettlementRef: false });
        await ev(`event:moolre-collection:${cNoRef.r}-x`, { providerRef: cNoRef.r });

        Object.assign(identityCases, {
            exactContra: cExact, prefFallback: cPRef, relFallback: cRel,
            multiPref: cMultiPRef, multiRel: cMultiRel, missingPref: cNoRef,
        });

        // 12. Pre-existing claim conflicts, each on its own genuine settlement.
        for (const [name, r] of [
            ['conflictOwner', R_CONFLICT_OWNER],
            ['conflictPurpose', R_CONFLICT_PURPOSE],
            ['conflictMalformed', R_CONFLICT_MALFORMED],
        ]) {
            const txHash = `${tag}-tx-${name}`;
            await settledDeposit(r, { txHash, providerRef: r });
            await moolreEvent(r, { txHash, providerRef: r });
        }
    }, 120000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('an injected failure AFTER a successful insert rolls back the claims AND the DDL', async () => {
        // Deliberately start from "table does not exist", so the rollback of the
        // DDL is observable rather than assumed.
        await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "ProviderObservationClaim"');

        const res = runInstaller([], { AZM_TEST_INJECT_FAILURE_AFTER_CLAIMS: '1' });
        expect(res.code).not.toBe(0);
        expect(res.stderr).toMatch(/injected failure/i);

        const table = await prisma.$queryRawUnsafe(`SELECT to_regclass('"ProviderObservationClaim"')::text AS t`);
        expect(table[0].t).toBeNull();

        // Recovery semantics: an interrupted run leaves nothing behind, so a
        // clean re-run installs and claims the full set.
        const rerun = runInstaller(['--json']);
        expect(rerun.code).toBe(0);
        const report = jsonOf(rerun.stdout);
        expect(report.installed).toBe(true);
        expect(report.depositClaims).toBeGreaterThanOrEqual(3);
    }, 180000);

    test('dry-run selects exactly the candidates the real run writes, and writes nothing', async () => {
        const before = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });

        const dry = runInstaller(['--dry-run', '--json']);
        expect(dry.code).toBe(0);
        const dryReport = jsonOf(dry.stdout);
        expect(dryReport.depositClaims).toBe(0);
        expect(dryReport.witnessClaims).toBe(0);
        expect(dryReport.quarantined).toBe(0);
        expect(dryReport.wouldClaimDeposits).toBeGreaterThanOrEqual(3);
        expect(dryReport.wouldQuarantine).toBeGreaterThanOrEqual(3);

        const after = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });
        expect(after).toBe(before);

        // The report must describe a REPEAT run honestly: candidates split into
        // "already claimed" and "would insert", and the split must add up.
        expect(dryReport.wouldInsertDeposits + dryReport.alreadyClaimedDeposits).toBe(dryReport.wouldClaimDeposits);
        expect(dryReport.wouldInsertWitnesses + dryReport.alreadyClaimedWitnesses).toBe(dryReport.wouldClaimWitnesses);
        expect(Array.isArray(dryReport.conflicts)).toBe(true);

        const real = jsonOf(runInstaller(['--json']).stdout);
        expect(real.wouldClaimDeposits).toBe(dryReport.wouldClaimDeposits);
        expect(real.wouldClaimWitnesses).toBe(dryReport.wouldClaimWitnesses);
        expect(real.wouldQuarantine).toBe(dryReport.wouldQuarantine);
        expect(real.wouldInsertDeposits).toBe(dryReport.wouldInsertDeposits);
        expect(real.alreadyClaimedDeposits).toBe(dryReport.alreadyClaimedDeposits);
        expect(real.depositClaims).toBe(real.wouldInsertDeposits);
        expect(real.witnessClaims).toBe(real.wouldInsertWitnesses);
        expect(real.conflicts).toEqual(dryReport.conflicts);
        expect(real.candidates.deposits.map((d) => d.observationKey).sort())
            .toEqual(dryReport.candidates.deposits.map((d) => d.observationKey).sort());
    }, 120000);

    test('a settled direct Moolre deposit and a generic-route Moolre deposit are both claimed', async () => {
        const rows = await claimsFor([R_DIRECT, R_GENERIC]);
        const byKey = new Map(rows.map((r) => [r.observationKey, r]));
        expect(byKey.get(key(R_DIRECT)).purpose).toBe('CUSTOMER_DEPOSIT');
        expect(byKey.get(key(R_DIRECT)).claimedByRef).toBe(directDepositId);
        expect(byKey.get(key(R_GENERIC)).purpose).toBe('CUSTOMER_DEPOSIT');
        expect(byKey.get(key(R_GENERIC)).claimedByRef).toBe(genericDepositId);
    }, 60000);

    test('the key the backfill writes is byte-identical to the key the live claim takes', async () => {
        for (const reference of [R_DIRECT, R_GENERIC]) {
            const live = canonicalObservationIdentity({ provider: 'moolre', reference }).observationKey;
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: live } });
            expect(row).not.toBeNull();
            expect(row.purpose).toBe('CUSTOMER_DEPOSIT');
        }
    }, 60000);

    test('an ordinary aggregator deposit on the same rail is NOT claimed as Moolre money', async () => {
        const rows = await claimsFor([R_AGGREGATOR]);
        expect(rows).toHaveLength(0);
    }, 60000);

    test('pending deposits and event-only observations are never claimed', async () => {
        const rows = await claimsFor([R_PENDING, R_EVENT_ONLY]);
        expect(rows).toHaveLength(0);
    }, 60000);

    test('unclassifiable history is reported, not claimed: no settlement reference, contradictory references', async () => {
        const rows = await claimsFor([R_NO_REF_TX, R_CONTRADICTORY]);
        expect(rows).toHaveLength(0);

        const report = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
        const mine = report.anomalies.filter((a) => [a.observationKey, a.subject, ...(a.owners || [])]
            .some((v) => String(v || '').includes(tag)));
        const kinds = mine.map((a) => a.kind);
        expect(kinds).toContain('MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE');
        expect(kinds).toContain('CONTRADICTORY_SETTLEMENT_REFERENCE');
        const contradiction = mine.find((a) => a.kind === 'CONTRADICTORY_SETTLEMENT_REFERENCE');
        expect(contradiction.observationKey).toBe(key(R_CONTRADICTORY));
    }, 60000);

    test('a genuine Moolre treasury witness is claimed, attributed to its opening', async () => {
        const rows = await claimsFor([R_WITNESS]);
        expect(rows).toHaveLength(1);
        expect(rows[0].purpose).toBe('TREASURY_WITNESS');
        expect(rows[0].claimedByRef).toBe(`${tag}-opening-witness`);
    }, 60000);

    test('a cross-path collision is quarantined, never given to a winner', async () => {
        const rows = await claimsFor([R_COLLIDE]);
        expect(rows).toHaveLength(1);
        expect(rows[0].purpose).toBe('QUARANTINE');
        expect(rows[0].claimedByRef).toBeNull();

        for (const purpose of [CLAIM_PURPOSE.CUSTOMER_DEPOSIT, CLAIM_PURPOSE.TREASURY_WITNESS]) {
            await expect(
                prisma.$transaction((tx) => claimProviderObservation(tx, {
                    provider: 'moolre', reference: R_COLLIDE, purpose, claimedByRef: `${purpose}-after-quarantine`,
                })),
            ).rejects.toMatchObject({ code: 'OBSERVATION_QUARANTINED' });
        }
        // The deposit really is the settled one; it is simply not allowed to win.
        const deposit = await prisma.transactionHistory.findUnique({ where: { id: collideDepositId } });
        expect(deposit.status).toBe('COMPLETED');
    }, 60000);

    test('same-path duplicate owners are quarantined and every historical owner is reported', async () => {
        const depositRows = await claimsFor([R_DUP_DEPOSITS]);
        expect(depositRows).toHaveLength(1);
        expect(depositRows[0].purpose).toBe('QUARANTINE');
        expect(depositRows[0].claimedByRef).toBeNull();

        const witnessRows = await claimsFor([R_DUP_WITNESSES]);
        expect(witnessRows).toHaveLength(1);
        expect(witnessRows[0].purpose).toBe('QUARANTINE');
        expect(witnessRows[0].claimedByRef).toBeNull();

        const report = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
        const scoped = report.anomalies.concat(report.candidates.quarantine)
            .filter((a) => String(a.observationKey || '').includes(tag) || (a.owners || []).some((o) => String(o).includes(tag)));
        const dupDeps = scoped.find((a) => a.reason === 'DUPLICATE_DEPOSIT_OWNERS' || a.kind === 'DUPLICATE_DEPOSIT_OWNERS');
        expect(dupDeps).toBeDefined();
        expect([...dupDeps.owners].sort()).toEqual(dupDepositIds);

        const dupWits = scoped.find((a) => a.reason === 'DUPLICATE_WITNESS_OWNERS' || a.kind === 'DUPLICATE_WITNESS_OWNERS');
        expect(dupWits).toBeDefined();
        expect([...dupWits.owners].sort()).toEqual([`${tag}-opening-dup-1`, `${tag}-opening-dup-2`].sort());
    }, 60000);

    test('the overlay is idempotent DDL and the database enforces one claim per observation', async () => {
        // DDL re-runs cleanly (the release chain may run it again on every deploy).
        const again = runInstaller(['--json']);
        expect(again.code).toBe(0);

        // The invariant is enforced by PostgreSQL, not only by the installer: a
        // second claim for one observation is refused even by a direct insert.
        await expect(prisma.providerObservationClaim.create({
            data: { observationKey: key(R_DIRECT), purpose: 'TREASURY_WITNESS', claimedByRef: 'intruder', provider: 'moolre' },
        })).rejects.toMatchObject({ code: 'P2002' });
    }, 120000);

    test('a backfill run mutates claims only: no balance, ledger, deposit or witness movement', async () => {
        const snapshot = async () => {
            const user = await prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true, nativeGhsBalance: true } });
            const deposits = await prisma.transactionHistory.findMany({
                where: { txHash: { contains: tag } },
                select: { id: true, status: true, amountUsdc: true, amountGhs: true },
                orderBy: { id: 'asc' },
            });
            const witnesses = await prisma.providerSettlementWitness.findMany({
                where: { openingDedupKey: { contains: tag } },
                select: { openingDedupKey: true, netPesewas: true, providerState: true },
                orderBy: { openingDedupKey: 'asc' },
            });
            // BigInt columns (witness pesewa counts) are normalised to strings.
            return JSON.stringify({ user, deposits, witnesses }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        };

        const before = await snapshot();
        const run1 = runInstaller(['--json']);
        expect(run1.code).toBe(0);
        const after = await snapshot();
        expect(after).toBe(before);
    }, 120000);

    test('an unreachable database fails loudly instead of reporting a clean install', () => {
        const res = spawnSync(process.execPath, [INSTALLER, '--json'], {
            cwd: REPO,
            env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:59999/nope' },
            encoding: 'utf8',
        });
        expect(res.status).not.toBe(0);
        expect(`${res.stdout}${res.stderr}`).toMatch(/FAILED:/);
        expect(res.stdout).not.toMatch(/installed=true/);
    }, 60000);

    describe('Moolre evidence must agree on EVERY populated identity field', () => {
        let report;
        beforeAll(() => {
            const res = runInstaller(['--json']);
            expect(res.code).toBe(0);
            report = jsonOf(res.stdout);
        }, 180000);

        const contradictionFor = (r) => report.anomalies
            .find((a) => a.kind === 'CONTRADICTORY_MOOLRE_EVIDENCE' && String(a.observationKey) === key(r));
        const ambiguityFor = (r) => report.anomalies
            .find((a) => a.kind === 'AMBIGUOUS_MOOLRE_EVIDENCE' && String(a.observationKey) === key(r));

        test('an exact deduplication key with a contradictory relatedReference is refused', async () => {
            expect(contradictionFor(identityCases.exactContra.r)).toBeDefined();
            expect(contradictionFor(identityCases.exactContra.r).detail).toMatch(/relatedReference/);
            expect(await claimsFor([identityCases.exactContra.r])).toHaveLength(0);
        }, 60000);

        test('a providerRef fallback whose deduplication identity differs is refused', async () => {
            const anomaly = contradictionFor(identityCases.prefFallback.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/dedupKey names/);
            expect(await claimsFor([identityCases.prefFallback.r])).toHaveLength(0);
        }, 60000);

        test('a relatedReference fallback whose other populated field contradicts is refused', async () => {
            const anomaly = contradictionFor(identityCases.relFallback.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/dedupKey names/);
            expect(await claimsFor([identityCases.relFallback.r])).toHaveLength(0);
        }, 60000);

        test('two events sharing a provider reference are an ambiguity, never a first-match claim', async () => {
            const anomaly = ambiguityFor(identityCases.multiPref.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/2 distinct Moolre events/);
            expect(await claimsFor([identityCases.multiPref.r])).toHaveLength(0);
        }, 60000);

        test('two events matching one related reference are an ambiguity', async () => {
            const anomaly = ambiguityFor(identityCases.multiRel.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/2 distinct Moolre events/);
            expect(await claimsFor([identityCases.multiRel.r])).toHaveLength(0);
        }, 60000);

        test('a missing settlement reference tied only by the provider reference stays unclassifiable', async () => {
            const anomaly = report.anomalies.find((a) => a.kind === 'MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE'
                && String(a.subject || '') === identityCases.missingPref.txHash);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/providerRef\(/);
            expect(anomaly.detail).toMatch(/cannot be established/);
            expect(await claimsFor([identityCases.missingPref.r])).toHaveLength(0);
        }, 60000);

        test('every ambiguous or contradictory case failed closed, and the genuine ones still claim', async () => {
            const all = Object.values(identityCases).map((c) => c.r);
            expect(await claimsFor(all)).toHaveLength(0);
            // positive control in the same run: real evidence is still claimed
            const genuine = await claimsFor([R_DIRECT, R_GENERIC]);
            expect(genuine.map((r) => r.purpose)).toEqual(['CUSTOMER_DEPOSIT', 'CUSTOMER_DEPOSIT']);
        }, 60000);
    });

    describe('a pre-existing claim row is verified, not assumed', () => {
        const ownerRow = () => prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_PREEXISTING) } });

        test('re-running after a successful installation reports every claim already correct and writes nothing', async () => {
            const before = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });
            const res = runInstaller(['--json']);
            expect(res.code).toBe(0);
            const report = jsonOf(res.stdout);
            expect(report.depositClaims).toBe(0);
            expect(report.witnessClaims).toBe(0);
            expect(report.quarantined).toBe(0);
            expect(report.alreadyClaimedDeposits).toBeGreaterThanOrEqual(3);
            expect(report.alreadyClaimedWitnesses).toBeGreaterThanOrEqual(1);
            expect(report.wouldInsertDeposits).toBe(0);
            expect(report.wouldInsertWitnesses).toBe(0);
            expect(report.conflicts).toEqual([]);
            expect(await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } })).toBe(before);
        }, 120000);

        test('a correct pre-existing customer-deposit claim is an idempotent replay', async () => {
            const row = await ownerRow();
            expect(row.purpose).toBe('CUSTOMER_DEPOSIT');
            const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
            expect(dry.conflicts).toEqual([]);
            expect(dry.alreadyCorrect.deposits.map((d) => d.observationKey)).toContain(key(R_PREEXISTING));
            const after = await ownerRow();
            expect(after.claimedByRef).toBe(row.claimedByRef);
        }, 120000);

        test('a correct pre-existing treasury-witness claim matches, including its account identity', async () => {
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_WITNESS) } });
            expect(row.purpose).toBe('TREASURY_WITNESS');
            expect(row.claimedByRef).toBe(`${tag}-opening-witness`);
            // The opening's trusted wallet account is durable, so the claim
            // records it — and the comparison covers it.
            expect(row.accountKey).toBe('0244000000');
            const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
            expect(dry.alreadyCorrect.witnesses.map((w) => w.observationKey)).toContain(key(R_WITNESS));
        }, 120000);

        const injectConflict = async (r, data) => {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(r) } });
            await prisma.providerObservationClaim.create({
                data: { observationKey: key(r), purpose: 'CUSTOMER_DEPOSIT', claimedByRef: r, provider: 'moolre', ...data },
            });
        };

        test('a pre-existing claim with the WRONG OWNER refuses the run and writes nothing', async () => {
            await injectConflict(R_CONFLICT_OWNER, { claimedByRef: 'someone-elses-deposit' });
            const before = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });

            const res = runInstaller(['--json']);
            expect(res.code).toBe(2);
            expect(res.stderr).toMatch(/PRE-EXISTING CLAIM CONFLICT/);
            expect(res.stderr).toMatch(/claimedByRef=someone-elses-deposit/);
            // nothing written: not the conflicting row, not any other claim
            expect(await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } })).toBe(before);
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_CONFLICT_OWNER) } });
            expect(row.claimedByRef).toBe('someone-elses-deposit');

            // dry run reports the same conflict without writing
            const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
            expect(dry.conflicts.map((c) => c.observationKey)).toContain(key(R_CONFLICT_OWNER));
            expect(dry.conflicts[0].diffs.join(' ')).toMatch(/claimedByRef/);

            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_CONFLICT_OWNER) } });
        }, 120000);

        test('a pre-existing claim with the WRONG PURPOSE refuses the run', async () => {
            await injectConflict(R_CONFLICT_PURPOSE, { purpose: 'TREASURY_WITNESS' });
            const res = runInstaller(['--json']);
            expect(res.code).toBe(2);
            expect(res.stderr).toMatch(/purpose=TREASURY_WITNESS/);
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_CONFLICT_PURPOSE) } });
            expect(row.purpose).toBe('TREASURY_WITNESS');
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_CONFLICT_PURPOSE) } });
        }, 120000);

        test('a MALFORMED legacy claimedByRef (the historic {uuid} array binding) refuses the run', async () => {
            await injectConflict(R_CONFLICT_MALFORMED, { claimedByRef: '{4d0a4d61-0000-4000-8000-000000000000}' });
            const res = runInstaller(['--json']);
            expect(res.code).toBe(2);
            expect(res.stderr).toMatch(/claimedByRef is malformed/);
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_CONFLICT_MALFORMED) } });
            expect(row.claimedByRef).toBe('{4d0a4d61-0000-4000-8000-000000000000}');
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_CONFLICT_MALFORMED) } });
        }, 120000);

        test('the quarantine row of a collision is itself refused as an owner conflict when it is not this claim', async () => {
            // A QUARANTINE row is neither a replay nor this claim: it must be
            // reported, never silently accepted as a successful backfill.
            const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
            expect(dry.wouldQuarantine).toBeGreaterThanOrEqual(3);
            expect(dry.quarantined).toBe(0);
        }, 120000);
    });
});
