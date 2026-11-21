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
    const { spawnSync, spawn } = require('child_process');
    const { insertClaimOrVerify, PreexistingClaimConflict, readExistingClaims } = require('../infra/install-provider-observation-claim');
    const path = require('path');
    const { canonicalObservationIdentityV2 } = require('../src/services/providerObservationIdentity');
    // The one wallet every fixture event carries, so the backfill and the live
    // claim derive the same identity for the same payment.
    const WALLET = '0244000000';
    const { claimProviderObservation, CLAIM_PURPOSE } = require('../src/services/providerObservationClaimService');

    const REPO = path.join(__dirname, '..');
    const INSTALLER = path.join(REPO, 'infra', 'install-provider-observation-claim.js');

    const tag = `bf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const ref = (n) => `${tag}-${n}`;
    const key = (r, wallet = WALLET) => canonicalObservationIdentityV2({ provider: 'moolre', reference: r, accountNumber: wallet }).observationKey;

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
    // provider-vs-external identity fixtures (part 1)
    const R_SEP_OK = ref('sep-ok');
    const R_SEP_CONTRA = ref('sep-contra');
    const R_SEP_NOPROV = ref('sep-noprov');
    const R_SEP_LEGACY = ref('sep-legacy');
    const R_SEP_META = ref('sep-meta');
    const R_SEP_GENERIC = ref('sep-generic');
    // quarantine-verification fixtures (part 2)
    const R_Q_DEP = ref('q-dep');
    const R_Q_WIT = ref('q-wit');
    const R_Q_OK = ref('q-ok');
    const R_Q_BAD = ref('q-bad');
    // insert-race fixtures (part 3)
    const R_RACE_CONFLICT = ref('race-conflict');
    const R_RACE_OK = ref('race-ok');
    const R_CRYPTO_ROW = ref('crypto-row');
    // identity-disambiguation fixtures
    const R_CONFLICT_OWNER = ref('conflict-owner');
    const R_CONFLICT_PURPOSE = ref('conflict-purpose');
    const R_CONFLICT_MALFORMED = ref('conflict-malformed');
    const identityCases = {};
    const crossIdentity = {};

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

    /** Async installer run, for tests that must interleave with a second connection. */
    function spawnInstaller(extraArgs = []) {
        const child = spawn(process.execPath, [INSTALLER, ...extraArgs], {
            cwd: REPO,
            env: { ...process.env, DATABASE_URL: DB_URL },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const done = new Promise((resolve) => {
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
        return { child, done };
    }

    function runInstallerAsync(extraArgs = []) {
        return spawnInstaller(extraArgs).done;
    }

    /**
     * Wait until some backend is WAITING on the claim table's RELATION lock.
     *
     * It observes an ungranted `relation` lock in pg_locks — the installer
     * blocked inside `CREATE UNIQUE INDEX` — never a row lock: with an
     * already-open writer it is the DDL that waits, not the INSERT. The
     * interleaving is observed, never guessed with a sleep.
     */
    async function waitForRelationLockWait(maxIterations = 240) {
        for (let i = 0; i < maxIterations; i += 1) {
            const rows = await prisma.$queryRawUnsafe(`
                SELECT count(*)::int AS n
                FROM pg_locks l
                JOIN pg_class c ON c.oid = l.relation
                WHERE NOT l.granted AND c.relname = 'ProviderObservationClaim'
            `);
            if (rows[0].n > 0) return true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return false;
    }

    function jsonOf(out) {
        const line = out.split('\n').find((l) => l.includes('[provider-observation-claim-json]'));
        if (!line) throw new Error(`installer printed no JSON report:\n${out}`);
        return JSON.parse(line.slice(line.indexOf('{')).trim());
    }

    const claimsFor = (refs) => prisma.providerObservationClaim.findMany({
        // NOT refs.map(key): map passes the index as the second argument, which
        // would arrive as the wallet.
        where: { observationKey: { in: refs.map((r) => key(r)) } },
        select: { observationKey: true, purpose: true, claimedByRef: true, provider: true, accountKey: true },
    });
    // CASE A — an ownerless QUARANTINE row is a claim like any other: it is what
    // stops one observation being used twice. Split owned claims from quarantine
    // so the historical "no claim" assertions become the stronger "no OWNED
    // claim, exactly one ownerless quarantine".
    const ownedFor = async (refs) => (await claimsFor(refs)).filter((r) => r.purpose !== 'QUARANTINE');
    const quarantineFor = async (refs) => (await claimsFor(refs)).filter((r) => r.purpose === 'QUARANTINE');
    const expectQuarantine = async (refs) => {
        const q = await quarantineFor(refs);
        expect(q).toHaveLength(refs.length);
        for (const row of q) {
            expect(row.purpose).toBe('QUARANTINE');
            expect(row.claimedByRef).toBeNull();
            expect(row.provider).toBe('moolre');
            expect(row.accountKey).toBeNull();
        }
        expect(await ownedFor(refs)).toHaveLength(0);
    };

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
                walletAccount: WALLET,
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

        // The release chain creates "ReconciliationException" (install-payout-
        // reconciliation-infra.js) BEFORE the WP-I claim installer, because a
        // real backfill run now aborts rather than leave unresolved evidence
        // unrecorded. The harness models that ordering instead of letting the
        // installer run against a database production would never present.
        const { execFileSync } = require('child_process');
        execFileSync(process.execPath, ['infra/install-payout-reconciliation-infra.js'], {
            cwd: require('path').resolve(__dirname, '..'),
            env: { ...process.env },
            stdio: 'pipe',
        });

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
                walletAccount: WALLET,
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
                    // The same wallet the assertions derive keys from.
                    walletAccount: WALLET, currency: 'GHS',
                    netPesewas: 12000n, grossPesewas: 12000n, providerState: 'settled',
                    endpoint: '/payment/status', requestParams: { id: R_DUP_WITNESSES },
                    rawResponseDigest: `digest-d${n}`, rawResponse: JSON.stringify({ status: 1 }), fetchedAt: new Date(),
                },
            });
        }

        // 10. An already-existing claim row must not be duplicated or re-owned.
        await settledDeposit(R_PREEXISTING, { txHash: `${tag}-tx-preexist`, providerRef: R_PREEXISTING });
        await moolreEvent(R_PREEXISTING, { txHash: `${tag}-tx-preexist`, providerRef: R_PREEXISTING });

        // 10b. A COMPLETED CRYPTO deposit that happens to carry a settlement
        //      reference and a matching Moolre event. A crypto row can never be a
        //      provider collection of GHS, so it is out of scope whatever its
        //      metadata looks like.
        await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_CRYPTO', status: 'COMPLETED',
                amountUsdc: '10.00000000', amountGhs: '120.00',
                txHash: `${tag}-tx-crypto`, providerRef: R_CRYPTO_ROW,
                metadata: {
                    provider: 'MTN_MOMO', selectedRoute: 'MOOLRE_MOMO_COLLECTION',
                    settlementExternalRef: R_CRYPTO_ROW, settledAmountGhs: '120.00',
                },
            },
        });
        await moolreEvent(R_CRYPTO_ROW, { txHash: `${tag}-tx-crypto`, providerRef: R_CRYPTO_ROW });

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
                    providerRef, dedupKey, amountGhs: '120.00', relatedReference, walletAccount: WALLET, raw: { status: 1 },
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

        // 11b. PROVIDER vs MERCHANT identity. The adapter sends Azaman's external
        //      reference and returns a DIFFERENT provider reference, so these
        //      fixtures use genuinely distinct values (external-A / provider-P).
        const sepDeposit = async (name, { externalRef, txHash, providerRefColumn = null, metadataProviderRef = 'absent', route = 'MOOLRE_MOMO_COLLECTION' } = {}) => {
            const ext = externalRef || ref(name);
            const th = txHash || `${tag}-tx-${name}`;
            const metadata = {
                provider: 'MTN_MOMO',
                network: 'MTN',
                selectedRoute: route,
                settlementCurrency: 'USDC',
                settledAmountGhs: '120.00',
                settledAt: new Date().toISOString(),
            };
            if (externalRef !== null) metadata.settlementExternalRef = ext;
            if (metadataProviderRef !== 'absent') metadata.settlementProviderRef = metadataProviderRef;
            const row = await prisma.transactionHistory.create({
                data: {
                    userId, type: 'DEPOSIT_FIAT', status: 'COMPLETED',
                    amountUsdc: '10.00000000', amountGhs: '120.00',
                    txHash: th, providerRef: providerRefColumn, metadata,
                },
            });
            return { r: ext, txHash: th, id: row.id };
        };
        const sepEvent = (externalRef, { providerRef = null, relatedReference = null, dedupKey = null } = {}) =>
            prisma.fiatProviderEvent.create({
                data: {
                    provider: 'MOOLRE', rail: 'MOMO', direction: 'INBOUND', status: 'SUCCESSFUL',
                    providerRef, dedupKey: dedupKey || `event:moolre-collection:${externalRef}`,
                    amountGhs: '120.00', relatedReference, walletAccount: WALLET, raw: { status: 1 },
                },
            });

        // (i) the shape the adapter actually produces: external-A / provider-P
        const sepOk = await sepDeposit('sep-ok', {
            externalRef: R_SEP_OK, txHash: `${tag}-tx-sep-ok`, providerRefColumn: `${tag}-provider-P`, metadataProviderRef: `${tag}-provider-P`,
        });
        await sepEvent(R_SEP_OK, { providerRef: `${tag}-provider-P`, relatedReference: sepOk.txHash });

        // (ii) event provider reference contradicts the persisted one
        const sepContra = await sepDeposit('sep-contra', {
            externalRef: R_SEP_CONTRA, txHash: `${tag}-tx-sep-contra`, providerRefColumn: `${tag}-provider-C`, metadataProviderRef: `${tag}-provider-C`,
        });
        await sepEvent(R_SEP_CONTRA, { providerRef: `${tag}-provider-Q`, relatedReference: sepContra.txHash });

        // (iii) no persisted provider reference to verify against
        const sepNoProv = await sepDeposit('sep-noprov', {
            externalRef: R_SEP_NOPROV, txHash: `${tag}-tx-sep-noprov`, providerRefColumn: null, metadataProviderRef: 'absent',
        });
        await sepEvent(R_SEP_NOPROV, { providerRef: `${tag}-provider-X`, relatedReference: sepNoProv.txHash });

        // (iv) direct Moolre callback: the provider echoed the merchant reference
        const sepLegacy = await sepDeposit('sep-legacy', {
            externalRef: R_SEP_LEGACY, txHash: `${tag}-tx-sep-legacy`, providerRefColumn: R_SEP_LEGACY, metadataProviderRef: R_SEP_LEGACY,
        });
        await sepEvent(R_SEP_LEGACY, { providerRef: R_SEP_LEGACY, relatedReference: sepLegacy.txHash });

        // (v) generic OTP/Moolre callback: provider identity only in settlement metadata
        const sepMeta = await sepDeposit('sep-meta', {
            externalRef: R_SEP_META, txHash: `${tag}-tx-sep-meta`, providerRefColumn: null, metadataProviderRef: `${tag}-provider-M`,
        });
        await sepEvent(R_SEP_META, { providerRef: `${tag}-provider-M`, relatedReference: sepMeta.txHash });

        // (vi) ordinary generic aggregator deposit on the same MoMo rail
        const sepGeneric = await sepDeposit('sep-generic', {
            externalRef: null, txHash: `${tag}-tx-sep-generic`, providerRefColumn: `${tag}-provider-G`, route: 'GENERIC_FIAT_AGGREGATOR',
        });
        await prisma.fiatProviderEvent.create({
            data: {
                provider: 'GENERIC_FIAT_WEBHOOK', rail: 'MOMO', direction: 'INBOUND', status: 'SUCCESSFUL',
                providerRef: `${tag}-provider-G`, dedupKey: `event:generic:${R_SEP_GENERIC}:SUCCESSFUL`,
                amountGhs: '120.00', relatedReference: sepGeneric.txHash, raw: { status: 1 },
            },
        });
        Object.assign(crossIdentity, { sepOk, sepContra, sepNoProv, sepLegacy, sepMeta, sepGeneric });

        // 11c. Cross-path collisions (deposit AND witness, same reference) whose
        //      pre-existing claim row has to be VERIFIED, not assumed.
        const crossPath = async (r, name) => {
            const d = await settledDeposit(r, { txHash: `${tag}-tx-${name}`, providerRef: `${tag}-provider-${name}` });
            await moolreEvent(r, { txHash: `${tag}-tx-${name}`, providerRef: `${tag}-provider-${name}` });
            await prisma.providerSettlementWitness.create({
                data: {
                    openingDedupKey: `${tag}-opening-${name}`, provider: 'MOOLRE',
                    fundingType: 'COLLECTION', witnessKind: 'payment_status_lookup',
                    walletAccount: '0244000000', currency: 'GHS',
                    netPesewas: 12000n, grossPesewas: 12000n, providerState: 'settled',
                    endpoint: '/payment/status', requestParams: { id: r },
                    rawResponseDigest: `digest-${name}`, rawResponse: JSON.stringify({ status: 1 }), fetchedAt: new Date(),
                },
            });
            return { r, depositId: d.id, openingKey: `${tag}-opening-${name}` };
        };
        Object.assign(crossIdentity, {
            qDep: await crossPath(R_Q_DEP, 'qdep'),
            qWit: await crossPath(R_Q_WIT, 'qwit'),
            qOk: await crossPath(R_Q_OK, 'qok'),
            qBad: await crossPath(R_Q_BAD, 'qbad'),
        });

        // 11d. Insert-race fixtures: one conflicting, one consistent competitor.
        const raceDeposit = async (r, name) => {
            const d = await settledDeposit(r, { txHash: `${tag}-tx-${name}`, providerRef: `${tag}-provider-${name}` });
            await moolreEvent(r, { txHash: `${tag}-tx-${name}`, providerRef: `${tag}-provider-${name}` });
            return { r, depositId: d.id };
        };
        Object.assign(crossIdentity, {
            raceConflict: await raceDeposit(R_RACE_CONFLICT, 'race-conflict'),
            raceOk: await raceDeposit(R_RACE_OK, 'race-ok'),
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
        expect(dryReport.wouldInsertQuarantine + dryReport.alreadyQuarantined).toBe(dryReport.wouldQuarantine);
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
            const live = canonicalObservationIdentityV2({ provider: 'moolre', reference, accountNumber: WALLET }).observationKey;
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: live } });
            expect(row).not.toBeNull();
            expect(row.purpose).toBe('CUSTOMER_DEPOSIT');
        }
    }, 60000);

    test('a COMPLETED crypto deposit is out of scope even with a matching Moolre event', async () => {
        expect(await claimsFor([R_CRYPTO_ROW])).toHaveLength(0);
    });

    test('an ordinary aggregator deposit on the same rail is NOT claimed as Moolre money', async () => {
        const rows = await claimsFor([R_AGGREGATOR]);
        expect(rows).toHaveLength(0);
    }, 60000);

    test('pending deposits and event-only observations are never claimed', async () => {
        const rows = await claimsFor([R_PENDING, R_EVENT_ONLY]);
        expect(rows).toHaveLength(0);
    }, 60000);

    test('unclassifiable history is reported, not claimed: no settlement reference, contradictory references', async () => {
        // No trustworthy canonical reference -> no claim key is invented
        // (Case B). The contradictory row DOES have a reference, so it is
        // quarantined under it (Case A).
        expect(await claimsFor([R_NO_REF_TX])).toHaveLength(0);
        await expectQuarantine([R_CONTRADICTORY]);

        const report = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
        const mine = report.anomalies.filter((a) => [a.observationKey, a.subject, ...(a.owners || [])]
            .some((v) => String(v || '').includes(tag)));
        const kinds = mine.map((a) => a.kind);
        expect(kinds).toContain('MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE');
        expect(kinds).toContain('CONTRADICTORY_PROVIDER_REFERENCE');
        const contradiction = mine.find((a) => a.kind === 'CONTRADICTORY_PROVIDER_REFERENCE');
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
                    provider: 'moolre', accountNumber: WALLET, reference: R_COLLIDE, purpose, claimedByRef: `${purpose}-after-quarantine`,
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
            await expectQuarantine([identityCases.exactContra.r]);
        }, 60000);

        test('a providerRef fallback whose deduplication identity differs is refused', async () => {
            const anomaly = contradictionFor(identityCases.prefFallback.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/dedupKey names/);
            await expectQuarantine([identityCases.prefFallback.r]);
        }, 60000);

        test('a relatedReference fallback whose other populated field contradicts is refused', async () => {
            const anomaly = contradictionFor(identityCases.relFallback.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/dedupKey names/);
            await expectQuarantine([identityCases.relFallback.r]);
        }, 60000);

        test('two events sharing a provider reference are an ambiguity, never a first-match claim', async () => {
            const anomaly = ambiguityFor(identityCases.multiPref.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/2 distinct Moolre events/);
            await expectQuarantine([identityCases.multiPref.r]);
        }, 60000);

        test('two events matching one related reference are an ambiguity', async () => {
            const anomaly = ambiguityFor(identityCases.multiRel.r);
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/2 distinct Moolre events/);
            await expectQuarantine([identityCases.multiRel.r]);
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
            // Case B rows (no trustworthy reference) carry no claim at all;
            // every key-bearing contradictory or ambiguous row is quarantined.
            expect(await ownedFor(all)).toHaveLength(0);
            const quarantined = await quarantineFor(all);
            expect(quarantined.length).toBeGreaterThan(0);
            for (const row of quarantined) {
                expect(row.claimedByRef).toBeNull();
                expect(row.accountKey).toBeNull();
            }
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

    describe('CASE A §4.2 — an owned claim is never overwritten by a quarantine', () => {
        test('a contradictory candidate meeting a CUSTOMER_DEPOSIT claim refuses the whole run', async () => {
            // Seed the stronger state: the observation is already owned by a
            // real deposit claim. A later backfill that now reads the same
            // evidence as contradictory must NOT rewrite that row into a
            // quarantine and must NOT pick a winner.
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_SEP_CONTRA) } });
            try {
                await prisma.providerObservationClaim.create({
                    data: {
                        observationKey: key(R_SEP_CONTRA), purpose: 'CUSTOMER_DEPOSIT',
                        claimedByRef: crossIdentity.sepContra.id, provider: 'moolre', accountKey: null,
                    },
                });
                const res = runInstaller(['--json']);
                // The installer's own pre-existing-claim check is the arbiter:
                // it refuses the whole run and writes nothing, rather than
                // rewriting an owned claim into a quarantine.
                expect(res.code).not.toBe(0);
                expect(String(res.stdout) + String(res.stderr)).toMatch(/PRE-EXISTING CLAIM CONFLICT/);

                const rows = await claimsFor([R_SEP_CONTRA]);
                expect(rows).toHaveLength(1);
                expect(rows[0].purpose).toBe('CUSTOMER_DEPOSIT');
                expect(rows[0].claimedByRef).toBe(crossIdentity.sepContra.id);
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_SEP_CONTRA) } });
            }
        }, 120000);
    });

    describe('the provider reference is a SEPARATE identity from the merchant external reference', () => {
        let report;
        beforeAll(() => {
            const res = runInstaller(['--json']);
            expect(res.code).toBe(0);
            report = jsonOf(res.stdout);
        }, 180000);

        const anomalyFor = (r, kind) => report.anomalies
            .find((a) => a.kind === kind && String(a.observationKey) === key(r));
        const claimFor = async (r) => (await claimsFor([r]))[0];

        test('external-A / provider-P is CLAIMED under the external reference', async () => {
            const row = await claimFor(R_SEP_OK);
            expect(row).toBeDefined();
            expect(row.purpose).toBe('CUSTOMER_DEPOSIT');
            expect(row.claimedByRef).toBe(crossIdentity.sepOk.id);
            // the canonical key is the merchant reference, never the provider's
            expect(row.observationKey).toBe(key(R_SEP_OK));
            expect(row.observationKey).not.toBe(key(`${tag}-provider-P`));
        }, 60000);

        test('a contradicting event provider reference is refused, not claimed', async () => {
            expect(anomalyFor(R_SEP_CONTRA, 'CONTRADICTORY_MOOLRE_EVIDENCE')).toBeDefined();
            expect(anomalyFor(R_SEP_CONTRA, 'CONTRADICTORY_MOOLRE_EVIDENCE').detail)
                .toMatch(/providerRef=.*does not match the deposit's provider reference/);
            // A trustworthy canonical key exists, so the observation is
            // quarantined under it rather than left free for a second use.
            await expectQuarantine([R_SEP_CONTRA]);
        }, 60000);

        test('a populated provider reference with nothing to verify it against is unclassifiable', async () => {
            const anomaly = anomalyFor(R_SEP_NOPROV, 'CONTRADICTORY_MOOLRE_EVIDENCE');
            expect(anomaly).toBeDefined();
            expect(anomaly.detail).toMatch(/cannot be verified \(deposit records no provider reference\)/);
            // The settlement external reference IS a trustworthy canonical key,
            // so unverifiable evidence against it is quarantined, not skipped.
            await expectQuarantine([R_SEP_NOPROV]);
        }, 60000);

        test('a direct Moolre callback that echoed the external reference is still claimed', async () => {
            const row = await claimFor(R_SEP_LEGACY);
            expect(row).toBeDefined();
            expect(row.claimedByRef).toBe(crossIdentity.sepLegacy.id);
        }, 60000);

        test('provider identity recorded only in settlement metadata is enough to verify', async () => {
            const row = await claimFor(R_SEP_META);
            expect(row).toBeDefined();
            expect(row.claimedByRef).toBe(crossIdentity.sepMeta.id);
        }, 60000);

        test('an ordinary generic aggregator deposit on the same rail stays unclaimed', async () => {
            expect(await claimsFor([R_SEP_GENERIC])).toHaveLength(0);
            expect(typeof report.skipped.nonMoolreProvider).toBe('number');
            expect(report.skipped.nonMoolreProvider).toBeGreaterThanOrEqual(1);
        }, 60000);

        test('the two identity families are never compared across kinds', async () => {
            // external-A and provider-P are both present on the same deposit and
            // DIFFER; the claim key was built from the external one and the run
            // reported no contradiction for that deposit.
            expect(key(R_SEP_OK)).not.toBe(key(`${tag}-provider-P`));
            expect(anomalyFor(R_SEP_OK, 'CONTRADICTORY_MOOLRE_EVIDENCE')).toBeUndefined();
            expect(anomalyFor(R_SEP_OK, 'CONTRADICTORY_PROVIDER_REFERENCE')).toBeUndefined();
        }, 60000);
    });

    describe('a quarantine row is verified like any other claim', () => {
        const quarantineRow = (r) => prisma.providerObservationClaim.findUnique({ where: { observationKey: key(r) } });
        const inject = async (r, data) => {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(r) } });
            await prisma.providerObservationClaim.create({
                data: { observationKey: key(r), purpose: 'QUARANTINE', claimedByRef: null, provider: 'moolre', ...data },
            });
        };

        test('a pre-existing CUSTOMER_DEPOSIT on a cross-path collision is a conflict', async () => {
            await inject(R_Q_DEP, { purpose: 'CUSTOMER_DEPOSIT', claimedByRef: crossIdentity.qDep.depositId });
            try {
                const before = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/PRE-EXISTING CLAIM CONFLICT/);
                expect(res.stderr).toMatch(/purpose=CUSTOMER_DEPOSIT/);
                expect(await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } })).toBe(before);
                const row = await quarantineRow(R_Q_DEP);
                expect(row.purpose).toBe('CUSTOMER_DEPOSIT');
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_DEP) } });
            }
        }, 120000);

        test('a pre-existing TREASURY_WITNESS on a cross-path collision is a conflict', async () => {
            await inject(R_Q_WIT, { purpose: 'TREASURY_WITNESS', claimedByRef: crossIdentity.qWit.openingKey });
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/purpose=TREASURY_WITNESS/);
                const row = await quarantineRow(R_Q_WIT);
                expect(row.purpose).toBe('TREASURY_WITNESS');
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_WIT) } });
            }
        }, 120000);

        test('an ownerless quarantine row with a NULL account key is the replay', async () => {
            await inject(R_Q_OK, { accountKey: null });
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(0);
                const report = jsonOf(res.stdout);
                expect(report.alreadyQuarantined).toBeGreaterThanOrEqual(1);
                expect(report.conflicts).toEqual([]);
                expect(await prisma.providerObservationClaim.count({ where: { observationKey: key(R_Q_OK) } })).toBe(1);
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_OK) } });
            }
        }, 120000);

        test('an ownerless quarantine row with a NON-NULL account key is a conflict, not a replay', async () => {
            await inject(R_Q_OK, { accountKey: 'some-account' });
            try {
                const before = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/accountKey=some-account/);
                // never counted as a successful quarantine, and nothing mutated
                const after = await prisma.providerObservationClaim.count({ where: { observationKey: { contains: tag } } });
                expect(after).toBe(before);
                const row = await quarantineRow(R_Q_OK);
                expect(row.accountKey).toBe('some-account');
                // the dry run reports the same conflict and writes nothing
                const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
                expect(dry.conflicts.map((c) => c.observationKey)).toContain(key(R_Q_OK));
                expect(dry.quarantined).toBe(0);
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_OK) } });
            }
        }, 120000);

        test('a quarantine row with the WRONG PROVIDER is a conflict', async () => {
            await inject(R_Q_OK, { provider: 'generic_fiat_webhook' });
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/provider=generic_fiat_webhook/);
                expect((await quarantineRow(R_Q_OK)).provider).toBe('generic_fiat_webhook');
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_OK) } });
            }
        }, 120000);

        test('a quarantine row with the WRONG PURPOSE is a conflict', async () => {
            await inject(R_Q_OK, { purpose: 'TREASURY_WITNESS', claimedByRef: null });
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/purpose=TREASURY_WITNESS/);
                expect((await quarantineRow(R_Q_OK)).purpose).toBe('TREASURY_WITNESS');
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_OK) } });
            }
        }, 120000);

        test('a correct ownerless QUARANTINE row is an idempotent replay', async () => {
            await inject(R_Q_OK, {});
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(0);
                const report = jsonOf(res.stdout);
                expect(report.alreadyQuarantined).toBeGreaterThanOrEqual(1);
                expect(report.conflicts).toEqual([]);
                const rows = await prisma.providerObservationClaim.count({ where: { observationKey: key(R_Q_OK) } });
                expect(rows).toBe(1);
                const row = await quarantineRow(R_Q_OK);
                expect(row.purpose).toBe('QUARANTINE');
                expect(row.claimedByRef).toBeNull();
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_OK) } });
            }
        }, 120000);

        test('a MALFORMED quarantine row (owner present) is a conflict', async () => {
            await inject(R_Q_BAD, { claimedByRef: 'a-owner-on-a-quarantine-row' });
            try {
                const res = runInstaller(['--json']);
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/claimedByRef=a-owner-on-a-quarantine-row/);
                const row = await quarantineRow(R_Q_BAD);
                expect(row.claimedByRef).toBe('a-owner-on-a-quarantine-row');
                // dry run reports the same conflict and writes nothing
                const dry = jsonOf(runInstaller(['--dry-run', '--json']).stdout);
                expect(dry.conflicts.map((c) => c.observationKey)).toContain(key(R_Q_BAD));
                expect(dry.quarantined).toBe(0);
            } finally {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_Q_BAD) } });
            }
        }, 120000);

        test('no existing row is ever counted as a successful quarantine', async () => {
            // With every quarantine key already present and correct, a repeat run
            // must report replays — never new quarantine writes.
            const first = runInstaller(['--json']);
            expect(first.code).toBe(0);
            const second = runInstaller(['--json']);
            expect(second.code).toBe(0);
            const report = jsonOf(second.stdout);
            expect(report.quarantined).toBe(0);
            expect(report.wouldInsertQuarantine).toBe(0);
            expect(report.alreadyQuarantined).toBeGreaterThanOrEqual(3);
        }, 180000);
    });

    describe('a competing claim is verified, never assumed', () => {
        const otherClient = () => new PrismaClient();

        /**
         * The installer's DDL takes a ShareLock on the claim table and holds it
         * until COMMIT. PostgreSQL's ShareLock CONFLICTS with the
         * RowExclusiveLock that every INSERT takes, so while the DDL is held no
         * session can insert into the claim table at all — including a writer that
         * opens afterwards. Consequently the reachable ordering is: a writer is
         * already open when the installer starts, the installer blocks in its
         * DDL, and once that writer commits the installer's read sees the winner
         * and reports a pre-write conflict. Observed via pg_locks, never by
         * sleeping. See the installer header for the operational consequence of
         * holding that lock for the whole backfill.
         */
        test('an ALREADY-OPEN writer that commits mid-run is caught by the pre-write comparison', async () => {
            const other = otherClient();
            await other.$connect();
            try {
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_CONFLICT) } });
                await other.$executeRawUnsafe('BEGIN');
                await other.$executeRawUnsafe(
                    `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                     VALUES (gen_random_uuid()::text,$1,'CUSTOMER_DEPOSIT',$2,'moolre',NULL, now(), now())`,
                    key(R_RACE_CONFLICT), 'some-other-owner');

                const running = runInstallerAsync(['--json']);
                // The installer's DDL is waiting on our uncommitted row.
                expect(await waitForRelationLockWait()).toBe(true);
                await other.$executeRawUnsafe('COMMIT');

                const res = await running;
                expect(res.code).toBe(2);
                expect(res.stderr).toMatch(/PRE-EXISTING CLAIM CONFLICT/);
                const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_RACE_CONFLICT) } });
                expect(row.claimedByRef).toBe('some-other-owner');
                // and every other affect of that refused run is gone
                expect(res.stdout).not.toContain('"depositClaims":1');
            } finally {
                await other.$disconnect();
                await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_CONFLICT) } });
            }
        }, 240000);

        const RACE_TRIGGER = `
            CREATE OR REPLACE FUNCTION azm_race_claim() RETURNS trigger AS $$
            BEGIN
                IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
                IF NEW."observationKey" = TG_ARGV[0] THEN
                    INSERT INTO "ProviderObservationClaim"
                        ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                    VALUES (gen_random_uuid()::text, NEW."observationKey", 'CUSTOMER_DEPOSIT', TG_ARGV[1], 'moolre', NULL, now(), now());
                END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql;
        `;

        const withRaceTrigger = async (targetKey, owner, fn) => {
            await prisma.$executeRawUnsafe(RACE_TRIGGER);
            await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS azm_race_claim_trg ON "ProviderObservationClaim"`);
            await prisma.$executeRawUnsafe(
                `CREATE TRIGGER azm_race_claim_trg BEFORE INSERT ON "ProviderObservationClaim"
                 FOR EACH ROW EXECUTE FUNCTION azm_race_claim('${targetKey}', '${owner}')`);
            try {
                return await fn();
            } finally {
                await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS azm_race_claim_trg ON "ProviderObservationClaim"`);
            }
        };

        /**
         * The second reachable ordering is the true lost race: a competing row is
         * written immediately before the installer's own INSERT, so the insert
         * returns ZERO rows. A BEFORE INSERT trigger places the competitor exactly
         * there — after the installer's read, before its write — with no timing
         * assumption at all.
         */
        test('an insert that returns ZERO rows re-reads the winner and REFUSES a conflicting one', async () => {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_CONFLICT) } });
            const res = await withRaceTrigger(key(R_RACE_CONFLICT), 'trigger-competitor', () => runInstallerAsync(['--json']));

            expect(res.code).toBe(2);
            expect(res.stderr).toMatch(/"duringInsertRace":true/);
            expect(res.stderr).toMatch(/claimedByRef=trigger-competitor/);
            // the refused run is fully rolled back, including the injected competitor
            const row = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_RACE_CONFLICT) } });
            expect(row).toBeNull();
        }, 240000);

        test('an insert that returns ZERO rows accepts a CONSISTENT winner as an idempotent replay', async () => {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_OK) } });
            const res = await withRaceTrigger(key(R_RACE_OK), crossIdentity.raceOk.depositId, () => runInstallerAsync(['--json']));

            expect(res.code).toBe(0);
            const report = jsonOf(res.stdout);
            expect(report.racedReplays).toBeGreaterThanOrEqual(1);
            expect(report.conflicts).toEqual([]);
            expect(typeof report.depositClaims).toBe('number');
            const rows = await prisma.providerObservationClaim.findMany({ where: { observationKey: key(R_RACE_OK) } });
            expect(rows).toHaveLength(1);
            expect(rows[0].claimedByRef).toBe(crossIdentity.raceOk.depositId);
        }, 240000);

        /**
         * The zero-row verification against a SEPARATE PostgreSQL session.
         *
         * Why not a gate inside the installer process: the installer's DDL takes a
         * ShareLock on the claim table and holds it for the whole transaction, and
         * ShareLock CONFLICTS WITH RowExclusiveLock — so while an installer
         * transaction is open no other session can insert at all (attempting it
         * deadlocks). That is a property worth knowing: in the current shape a
         * separate writer can only commit BEFORE the installer's DDL (caught by the
         * pre-write comparison, proven above) or AFTER its commit. The zero-row
         * branch is therefore defence in depth, and it is proven here by driving the
         * real primitive in one transaction while another connection commits the
         * competitor between the read and the insert.
         */
        describe('the zero-row verification against a SEPARATE session', () => {
            const insertRow = (client, observationKey, purpose, owner) => client.$executeRawUnsafe(
                `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                 VALUES (gen_random_uuid()::text,$1,$2,$3,'moolre',NULL, now(), now())`,
                observationKey, purpose, owner);

            test('a CONFLICTING winner committed by another session is reported and rolls back this transaction', async () => {
                const competitor = new PrismaClient();
                await competitor.$connect();
                const sentinel = key(`${tag}-rollback-sentinel`);
                try {
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: { in: [key(R_RACE_CONFLICT), sentinel] } } });

                    let caught = null;
                    await prisma.$transaction(async (tx) => {
                        // 1. this transaction writes an earlier claim and reads the
                        //    existing claim set, exactly as the installer does
                        await insertRow(tx, sentinel, 'QUARANTINE', null);
                        await readExistingClaims(tx);
                        // 2. a SEPARATE connection inserts and COMMITS the competitor
                        await insertRow(competitor, key(R_RACE_CONFLICT), 'CUSTOMER_DEPOSIT', 'separate-session-owner');
                        // 3. this transaction now inserts the same key
                        try {
                            await insertClaimOrVerify(tx, {
                                key: key(R_RACE_CONFLICT),
                                purpose: 'CUSTOMER_DEPOSIT',
                                claimedByRef: crossIdentity.raceConflict.depositId,
                                accountKey: null,
                                kind: 'deposit',
                            });
                        } catch (e) {
                            caught = e;
                            throw e;
                        }
                    }).catch((e) => {
                        expect(e).toBeInstanceOf(PreexistingClaimConflict);
                        expect(e.code).toBe('PREEXISTING_CLAIM_CONFLICT');
                    });

                    expect(caught).not.toBeNull();
                    // 4. ON CONFLICT inserted zero rows, and the follow-up SELECT
                    //    DID see the other session's committed row
                    expect(caught.conflicts[0].duringInsertRace).toBe(true);
                    expect(caught.conflicts[0].existing.claimedByRef).toBe('separate-session-owner');
                    expect(caught.conflicts[0].diffs.join(' ')).toMatch(/claimedByRef=separate-session-owner/);
                    // 5. nothing this transaction wrote survives
                    expect(await prisma.providerObservationClaim.findUnique({ where: { observationKey: sentinel } })).toBeNull();
                    const winner = await prisma.providerObservationClaim.findUnique({ where: { observationKey: key(R_RACE_CONFLICT) } });
                    expect(winner.claimedByRef).toBe('separate-session-owner');
                } finally {
                    await competitor.$disconnect();
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: { in: [key(R_RACE_CONFLICT), sentinel] } } });
                }
            }, 120000);

            test('an EXACT winner committed by another session is accepted as a raced replay', async () => {
                const competitor = new PrismaClient();
                await competitor.$connect();
                try {
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_OK) } });

                    let outcome = null;
                    await prisma.$transaction(async (tx) => {
                        await readExistingClaims(tx);
                        await insertRow(competitor, key(R_RACE_OK), 'CUSTOMER_DEPOSIT', crossIdentity.raceOk.depositId);
                        outcome = await insertClaimOrVerify(tx, {
                            key: key(R_RACE_OK),
                            purpose: 'CUSTOMER_DEPOSIT',
                            claimedByRef: crossIdentity.raceOk.depositId,
                            accountKey: null,
                            kind: 'deposit',
                        });
                    });

                    expect(outcome.outcome).toBe('replay');
                    const rows = await prisma.providerObservationClaim.findMany({ where: { observationKey: key(R_RACE_OK) } });
                    expect(rows).toHaveLength(1);
                    expect(rows[0].claimedByRef).toBe(crossIdentity.raceOk.depositId);
                } finally {
                    await competitor.$disconnect();
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_OK) } });
                }
            }, 120000);

            test('a QUARANTINE row losing the race to a non-null account key is a conflict', async () => {
                const competitor = new PrismaClient();
                await competitor.$connect();
                const quarantineKey = key(`${tag}-race-quarantine`);
                try {
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: quarantineKey } });
                    let caught = null;
                    await prisma.$transaction(async (tx) => {
                        await readExistingClaims(tx);
                        await competitor.$executeRawUnsafe(
                            `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                             VALUES (gen_random_uuid()::text,$1,'QUARANTINE',NULL,'moolre','late-account', now(), now())`,
                            quarantineKey);
                        try {
                            await insertClaimOrVerify(tx, {
                                key: quarantineKey, purpose: 'QUARANTINE', claimedByRef: null, accountKey: null, kind: 'quarantine',
                            });
                        } catch (e) {
                            caught = e;
                            throw e;
                        }
                    }).catch((e) => expect(e).toBeInstanceOf(PreexistingClaimConflict));

                    expect(caught.conflicts[0].duringInsertRace).toBe(true);
                    expect(caught.conflicts[0].diffs.join(' ')).toMatch(/accountKey=late-account/);
                } finally {
                    await competitor.$disconnect();
                    await prisma.providerObservationClaim.deleteMany({ where: { observationKey: quarantineKey } });
                }
            }, 120000);
        });

        test('the unique invariant is still enforced by the database itself', async () => {
            await prisma.providerObservationClaim.deleteMany({ where: { observationKey: key(R_RACE_OK) } });
            await prisma.providerObservationClaim.create({
                data: { observationKey: key(R_RACE_OK), purpose: 'CUSTOMER_DEPOSIT', claimedByRef: crossIdentity.raceOk.depositId, provider: 'moolre' },
            });
            await expect(prisma.providerObservationClaim.create({
                data: { observationKey: key(R_RACE_OK), purpose: 'CUSTOMER_DEPOSIT', claimedByRef: 'second-writer', provider: 'moolre' },
            })).rejects.toThrow();
            expect(await prisma.providerObservationClaim.count({ where: { observationKey: key(R_RACE_OK) } })).toBe(1);
        }, 120000);
    });
});
