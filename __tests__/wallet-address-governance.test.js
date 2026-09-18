// __tests__/wallet-address-governance.test.js
// =============================================================================
// Financial architecture §P.1 — WalletAddress authority + address governance.
//
// Two layers:
//  - real-PostgreSQL proofs (run where TEST_DATABASE_URL is set — CI provides
//    it) covering migration/backfill, DB-enforced uniqueness, allocation
//    idempotency + race convergence, retirement, ownership lookup authority,
//    mirror synchronization, native-USDC identity, and asset-identity
//    rejection;
//  - controller-level proofs (no DB) that the Tatum webhook verification gate
//    is fail-closed in production and that non-production test behavior is
//    not weakened;
//  - §P.1 closure-hardening proofs (real PostgreSQL, full webhook path):
//    body.userId is not an ownership authority, RETIRED addresses resolve to
//    no active owner (and the legacy mirror cannot resurrect them), unknown
//    addresses credit nobody, USDC.E is rejected before mutation, and native
//    Polygon USDC remains the accepted canonical identity.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[wallet-address-governance] TEST_DATABASE_URL not set — skipping DB proofs.');

const {
    NATIVE_USDC,
    USDC_E,
    isCanonicalDepositAsset,
    getActiveDepositAddress,
    resolveOwner,
    lookupWalletAddressHistory,
    allocateDepositAddress,
    retireDepositAddress,
} = require('../services/walletAddressService');
const { installWalletAddressOverlay } = require('../infra/install-wallet-address-overlay');
const { seedUser } = require('./helpers/factories');

// Deterministic mock TatumService — allocation must never depend on it for
// identity, only for derivation of the address string.
function mockTatumService({ counter = false } = {}) {
    let n = 0;
    return {
        providerMode: 'MOCK',
        deriveDepositAddress: async (userId) => {
            n += 1;
            const suffix = counter
                ? String(n).padStart(4, '0') + String(userId).padStart(4, '0')
                : String(userId).padStart(8, '0');
            return {
                address: ('0x' + suffix + 'a'.repeat(32 - suffix.length)).toLowerCase(),
                derivationIndex: userId,
                source: 'MOCK',
            };
        },
        subscribeAddress: async () => ({ subscriptionId: null, source: 'MOCK' }),
        verifyWebhookSignature: () => true,
    };
}


describeOrSkip('WalletAddress authority + governance (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.TATUM_WEBHOOK_SECRET = process.env.TATUM_WEBHOOK_SECRET || 'test_tatum_webhook_secret';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        // Established suite-cleanup pattern (cf. shift-scheduling-integrity):
        // truncate the registry and the seeded users (CASCADE clears their
        // TransactionHistory ledger rows and all other FK references).
        // The webhook proofs also touch the SystemMasterCrypto / SystemHotWallet
        // singletons (deposit credits) — truncate those too so this suite never
        // leaks absolute-balance state into other real-PG suites.
        // The deposit webhook emits its journal entry fire-and-forget (outside
        // the response path), so an in-flight journal write can hold row locks
        // when this TRUNCATE lands and PostgreSQL raises 40P01. Retry once —
        // the journal write has committed (or aborted) long before the retry.
        for (let attempt = 0; ; attempt++) {
            try {
                await prisma.$executeRawUnsafe('TRUNCATE TABLE "WalletAddress", "User", "SystemMasterCrypto", "SystemHotWallet", "JournalEntry", "LedgerTransaction", "LedgerAccount", "CustodyMovement", "CustodyAccount", "CustodyEvidence" RESTART IDENTITY CASCADE');
                break;
            } catch (err) {
                if (attempt < 2 && /deadlock/i.test(String(err && err.message))) {
                    await new Promise(r => setTimeout(r, 250));
                    continue;
                }
                throw err;
            }
        }
    }, 15000);

    // ── 1 + 2. Migration/overlay backfill preserves addresses exactly, idempotently ──
    it('backfills WalletAddress rows from existing User.tatumPolygonAddress values, preserving the address exactly, and is idempotent', async () => {
        const user = await seedUser(prisma);
        const legacy = '0xabc0000000000000000000000000000000000f11'.toLowerCase();
        await prisma.user.update({
            where: { id: user.id },
            data: { tatumPolygonAddress: legacy },
        });

        const first = await installWalletAddressOverlay(prisma);
        expect(first.failed).toBe(0);

        const rows = await prisma.walletAddress.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].address).toBe(legacy);            // preserved EXACTLY
        expect(rows[0].network).toBe('POLYGON');
        expect(rows[0].asset).toBe('USDC');
        expect(rows[0].contractAddress).toBe(NATIVE_USDC.contractAddress);
        expect(rows[0].derivationIndex).toBe(user.id);   // deterministic rule: index = user.id
        expect(rows[0].status).toBe('ACTIVE');
        expect(rows[0].subscriptionId).toBeNull();       // never invented

        // The legacy mirror column still exists and is untouched.
        const still = await prisma.user.findUnique({ where: { id: user.id }, select: { tatumPolygonAddress: true } });
        expect(still.tatumPolygonAddress).toBe(legacy);

        // Re-running the installer must not duplicate rows or mutate anything.
        await installWalletAddressOverlay(prisma);
        const again = await prisma.walletAddress.findMany({ where: { userId: user.id } });
        expect(again).toHaveLength(1);
        expect(again[0].address).toBe(legacy);
    });

    // ── 3. Active-address lookup returns the WalletAddress authority ──
    it('getActiveDepositAddress returns the authoritative row (and null when none exists)', async () => {
        const user = await seedUser(prisma);
        expect(await getActiveDepositAddress(prisma, user.id)).toBeNull();

        const row = await prisma.walletAddress.create({
            data: {
                userId: user.id,
                network: NATIVE_USDC.network,
                asset: NATIVE_USDC.asset,
                contractAddress: NATIVE_USDC.contractAddress,
                address: '0x00000000000000000000000000000000000000aa'.toLowerCase(),
                derivationIndex: user.id,
                status: 'ACTIVE',
            },
        });
        const found = await getActiveDepositAddress(prisma, user.id);
        expect(found).not.toBeNull();
        expect(found.id).toBe(row.id);
    });

    // ── 4 + 10. New allocation creates exactly one address and syncs the mirror ──
    it('allocateDepositAddress creates exactly one ACTIVE address, syncs the legacy mirror, and is idempotent', async () => {
        const user = await seedUser(prisma);
        const tatum = mockTatumService();

        const first = await allocateDepositAddress(prisma, tatum, user.id);
        expect(first.isNew).toBe(true);
        expect(first.status).toBe('ACTIVE');
        expect(first.contractAddress).toBe(NATIVE_USDC.contractAddress);
        expect(first.derivationIndex).toBe(user.id);

        const mirror = await prisma.user.findUnique({ where: { id: user.id }, select: { tatumPolygonAddress: true } });
        expect(mirror.tatumPolygonAddress).toBe(first.address);   // mirror synchronized

        const second = await allocateDepositAddress(prisma, tatum, user.id);
        expect(second.isNew).toBe(false);
        expect(second.id).toBe(first.id);

        const count = await prisma.walletAddress.count({ where: { userId: user.id } });
        expect(count).toBe(1);                                    // exactly one address
    });

    // ── 5. Concurrent allocation converges to ONE ACTIVE row ──
    it('racing concurrent allocations for the same user converge on one ACTIVE WalletAddress', async () => {
        const user = await seedUser(prisma);
        const tatum = mockTatumService();

        const results = await Promise.all(
            Array.from({ length: 8 }, () => allocateDepositAddress(prisma, tatum, user.id))
        );

        const addresses = new Set(results.map((r) => r.address));
        expect(addresses.size).toBe(1);                     // all converged on the same address

        const rows = await prisma.walletAddress.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('ACTIVE');

        const mirror = await prisma.user.findUnique({ where: { id: user.id }, select: { tatumPolygonAddress: true } });
        expect(mirror.tatumPolygonAddress).toBe(rows[0].address);
    });

    // ── 6. Retired addresses are never reassigned; RETIRED is terminal ──
    it('a retired address stays retired, is never reassigned, and re-allocation produces a new address', async () => {
        const user = await seedUser(prisma);
        const tatum = mockTatumService({ counter: true });

        const first = await allocateDepositAddress(prisma, tatum, user.id);
        await retireDepositAddress(prisma, first.id);

        const retired = await prisma.walletAddress.findUnique({ where: { id: first.id } });
        expect(retired.status).toBe('RETIRED');

        // Double-retire is rejected — RETIRED is terminal.
        await expect(retireDepositAddress(prisma, first.id)).rejects.toMatchObject({ code: 'WALLET_ADDRESS_NOT_ACTIVE' });

        // A fresh allocation must NOT reactivate or reuse the retired address.
        const second = await allocateDepositAddress(prisma, tatum, user.id);
        expect(second.id).not.toBe(first.id);
        expect(second.address).not.toBe(first.address);
        expect(second.status).toBe('ACTIVE');

        const rows = await prisma.walletAddress.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(rows).toHaveLength(2);
        expect(rows[0].status).toBe('RETIRED');             // history preserved

        // The mirror follows the new ACTIVE address.
        const mirror = await prisma.user.findUnique({ where: { id: user.id }, select: { tatumPolygonAddress: true } });
        expect(mirror.tatumPolygonAddress).toBe(second.address);
    });

    // ── 7 + 8. Canonical address uniqueness is DB-enforced; no cross-user reassignment ──
    it('a canonical (address, network) is globally unique — a second owner is rejected by the database', async () => {
        const [userA, userB] = [await seedUser(prisma), await seedUser(prisma)];
        const shared = '0x1111111111111111111111111111111111111111';

        await prisma.walletAddress.create({
            data: {
                userId: userA.id,
                network: NATIVE_USDC.network,
                asset: NATIVE_USDC.asset,
                contractAddress: NATIVE_USDC.contractAddress,
                address: shared,
                derivationIndex: userA.id,
            },
        });

        await expect(prisma.walletAddress.create({
            data: {
                userId: userB.id,
                network: NATIVE_USDC.network,
                asset: NATIVE_USDC.asset,
                contractAddress: NATIVE_USDC.contractAddress,
                address: shared,
                derivationIndex: userB.id,
            },
        })).rejects.toMatchObject({ code: 'P2002' });

        // And via the allocator: user B cannot be handed user A's address.
        const tatumB = mockTatumService();
        tatumB.deriveDepositAddress = async () => ({
            address: shared, derivationIndex: userB.id, source: 'MOCK',
        });
        await expect(allocateDepositAddress(prisma, tatumB, userB.id))
            .rejects.toMatchObject({ code: 'ADDRESS_COLLISION' });
        const bRows = await prisma.walletAddress.findMany({ where: { userId: userB.id } });
        expect(bRows).toHaveLength(0);
    });

    // ── 9. Webhook ownership lookup uses the WalletAddress authority ──
    it('resolveOwner resolves via WalletAddress first and keeps the deterministic legacy-mirror fallback', async () => {
        const [rowUser, mirrorUser] = [await seedUser(prisma), await seedUser(prisma)];

        const rowAddr = '0x2222222222222222222222222222222222222222'.toLowerCase();
        await prisma.walletAddress.create({
            data: {
                userId: rowUser.id,
                network: NATIVE_USDC.network,
                asset: NATIVE_USDC.asset,
                contractAddress: NATIVE_USDC.contractAddress,
                address: rowAddr,
                derivationIndex: rowUser.id,
            },
        });

        const viaRegistry = await resolveOwner(prisma, { address: rowAddr });
        expect(viaRegistry.source).toBe('WALLET_ADDRESS');
        expect(viaRegistry.userId).toBe(rowUser.id);
        expect(viaRegistry.walletAddress.id).toBeDefined();

        // Uppercase input still resolves (addresses are normalized).
        const viaUpper = await resolveOwner(prisma, { address: rowAddr.toUpperCase() });
        expect(viaUpper.userId).toBe(rowUser.id);

        // Legacy mirror fallback: a user with ONLY the old column set.
        const mirrorAddr = '0x3333333333333333333333333333333333333333'.toLowerCase();
        await prisma.user.update({ where: { id: mirrorUser.id }, data: { tatumPolygonAddress: mirrorAddr } });
        const viaLegacy = await resolveOwner(prisma, { address: mirrorAddr });
        expect(viaLegacy.source).toBe('LEGACY_MIRROR');
        expect(viaLegacy.userId).toBe(mirrorUser.id);

        // Unknown address resolves to nothing.
        expect(await resolveOwner(prisma, { address: '0x4444444444444444444444444444444444444444' })).toBeNull();
    });

    // ── 11. Native Polygon USDC identity is preserved ──
    it('the canonical identity is native Polygon USDC and bridged USDC.e is explicitly distinct', async () => {
        expect(isCanonicalDepositAsset(NATIVE_USDC)).toBe(true);
        expect(isCanonicalDepositAsset(USDC_E)).toBe(false);
        expect(USDC_E.contractAddress).not.toBe(NATIVE_USDC.contractAddress);
        // Exact official contracts — these identities cannot drift again.
        expect(NATIVE_USDC.contractAddress).toBe('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
        expect(USDC_E.contractAddress).toBe('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
        expect(NATIVE_USDC.decimals).toBe(6);

        const user = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), user.id);
        expect(allocated.network).toBe('POLYGON');
        expect(allocated.asset).toBe('USDC');
        expect(allocated.contractAddress).toBe(NATIVE_USDC.contractAddress);
    });

    // ── 12. Unsupported asset identity cannot become the canonical deposit address ──
    it('allocating a non-canonical asset identity (USDC.e / wrong contract) is rejected with no row created', async () => {
        const user = await seedUser(prisma);

        await expect(
            allocateDepositAddress(prisma, mockTatumService(), user.id, { identity: USDC_E })
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET_IDENTITY' });

        await expect(
            // Native-labeled identity pointing at the (real) bridged USDC.e
            // contract is still a contract-level mismatch and rejected.
            allocateDepositAddress(prisma, mockTatumService(), user.id, {
                identity: { network: 'POLYGON', asset: 'USDC', contractAddress: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' },
            })
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET_IDENTITY' });

        const rows = await prisma.walletAddress.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(0);
    });

    // ── 14. RETIRED addresses are not active financial owners (registry state wins) ──
    it('resolveOwner returns NO active owner for a RETIRED address, and the legacy mirror cannot resurrect it', async () => {
        const user = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), user.id);
        await retireDepositAddress(prisma, allocated.id);

        // Not an active financial owner anymore.
        expect(await resolveOwner(prisma, { address: allocated.address })).toBeNull();

        // The legacy mirror still holds the retired address, but a registry
        // row exists for it — registry state wins, the mirror is NEVER consulted.
        const mirror = await prisma.user.findUnique({
            where:  { id: user.id },
            select: { tatumPolygonAddress: true },
        });
        expect(mirror.tatumPolygonAddress).toBe(allocated.address);
        expect(await resolveOwner(prisma, { address: allocated.address })).toBeNull();

        // History/audit does NOT lose the row.
        const history = await lookupWalletAddressHistory(prisma, { address: allocated.address });
        expect(history).not.toBeNull();
        expect(history.id).toBe(allocated.id);
        expect(history.status).toBe('RETIRED');
    });

    // ── 15-18. Webhook ownership authority: the registry decides, never the payload ──
    const depositController = require('../controllers/depositController');
    const webhookReq = ({ body }) => ({
        body,
        headers: {}, // non-production: unsigned test webhooks remain admissible
        rawBody: JSON.stringify(body),
        app: { get: (key) => ({ prisma, tatumService: null, socketio: null, emitBalanceUpdate: null }[key]) },
    });
    const webhookRes = () => {
        const res = { statusCode: 0, body: null };
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    };
    const callWebhook = async (body) => {
        const res = webhookRes();
        await depositController.tatumCryptoWebhook(webhookReq({ body }), res);
        return res;
    };
    const balanceOf = async (id) => Number((await prisma.user.findUnique({
        where: { id }, select: { availableBalance: true },
    })).availableBalance);
    const ledgerCount = (txHash) => prisma.transactionHistory.count({ where: { txHash } });

    it('webhook body.userId CANNOT override registry ownership — the address owner is credited, never the payload user', async () => {
        const [userA, userB] = [await seedUser(prisma), await seedUser(prisma)];
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-override-attempt-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: 7.5,
            asset: 'USDC', userId: userB.id, // attacker-chosen userId
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.userId).toBe(userA.id);      // credited user is A
        expect(await balanceOf(userA.id)).toBeCloseTo(1007.5);
        expect(await balanceOf(userB.id)).toBeCloseTo(1000); // B untouched
        const ledger = await ledgerCount(txHash);
        expect(ledger).toBe(1);
        const row = await prisma.transactionHistory.findUnique({ where: { txHash } });
        expect(row.userId).toBe(userA.id);
    });

    it('a webhook for an address owned by NOBODY credits no one — even with an arbitrary userId supplied', async () => {
        const userA = await seedUser(prisma);
        const txHash = '0xwebhook-unknown-addr-1';

        const res = await callWebhook({
            address: '0x5555555555555555555555555555555555555555',
            txId: txHash, amount: 9.9, asset: 'USDC', userId: userA.id,
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.data.unmatched).toBe(true);
        expect(await ledgerCount(txHash)).toBe(0);         // no ledger row
        expect(await balanceOf(userA.id)).toBeCloseTo(1000); // no credit
    });

    it('USDC.E is rejected before any financial mutation — no ledger row, no balance change', async () => {
        const [userA, userB] = [await seedUser(prisma), await seedUser(prisma)];
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-usdce-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: 5,
            asset: 'USDC.E', userId: userB.id,
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.data.ignored).toBe(true);
        expect(await ledgerCount(txHash)).toBe(0);          // never reached the ledger
        expect(await balanceOf(userA.id)).toBeCloseTo(1000); // no mutation at all
        expect(await balanceOf(userB.id)).toBeCloseTo(1000);
    });

    it('native Polygon USDC (asset = USDC) remains the accepted canonical deposit identity', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-native-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: 3.25, asset: 'USDC',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(await balanceOf(userA.id)).toBeCloseTo(1003.25);
        expect(await ledgerCount(txHash)).toBe(1);
    });

    // ── 19-21. Webhook → §P.3 custody candidate: exact money + one journal truth ──
    const candidateOf = (txHash) => prisma.custodyMovement.findUnique({
        where: { idempotencyKey: `deposit:POLYGON:${String(txHash).toLowerCase()}` },
    });
    const journalRowsFor = async (txHash) => {
        // journalIntegration.recordDeposit is fire-and-forget — poll briefly.
        for (let i = 0; i < 40; i++) {
            const rows = await prisma.journalEntry.findMany({ where: { reference: txHash } });
            if (rows.length > 0) return rows;
            await new Promise((r) => setTimeout(r, 25));
        }
        return prisma.journalEntry.findMany({ where: { reference: txHash } });
    };

    it('the custody candidate stays EXACT for a quantity beyond JS safe-integer precision (raw string → BigInt)', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-exact-big-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash,
            // raw STRING. Base units = 9007199254740993 — one unit past the
            // 2^53 safe-integer boundary, where any float→integer conversion
            // is unreliable. The legacy ledger column (Decimal(20,8)) still
            // holds the dollar amount, so the credit path itself must pass.
            amount: '9007199254.740993',
            asset: 'USDC',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const candidate = await candidateOf(txHash);
        expect(candidate).not.toBe(null);
        // EXACT base units — never the float-corrupted Number(x.toFixed(6)) path.
        expect(candidate.amountBaseUnits).toBe(9007199254740993n);
        expect(candidate.status).toBe('CANDIDATE'); // webhook records, never verifies
        // The metadata decimal string is derived FROM the base units — exact.
        expect(candidate.metadata.creditedAmountDecimalString).toBe('9007199254.740993');
    });

    it('one deposit lifecycle has EXACTLY ONE journal representation — no custody duplicate', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-journal-single-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: 42.5, asset: 'USDC',
        });
        expect(res.statusCode).toBe(200);

        // §P.4: the ONE economic representation is the AUTHORITATIVE ledger
        // posting, committed synchronously INSIDE the settlement transaction
        // (the fire-and-forget journalIntegration shadow helper is retired on
        // this path). Balanced pair: D clearing:custody:unverified:usdc /
        // C user:{id}:liability. Wave-2 semantics: the webhook is an
        // observation source — it records PROVISIONAL custody only, which is
        // NOT a PoR reserve asset. Independent Tatum transaction evidence
        // (verifyDepositMovement) is the sole path that reclassifies into the
        // authoritative custody:deposit:usdc asset; the webhook alone can
        // NEVER touch it.
        const rows = await prisma.journalEntry.findMany({
            where: { reference: txHash, ledgerTransactionId: { not: null } },
        });
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.entryType === 'CUSTODY_DEPOSIT')).toBe(true);
        const debit = rows.find((r) => r.account === 'clearing:custody:unverified:usdc');
        const credit = rows.find((r) => r.account === `user:${userA.id}:liability`);
        expect(debit).toBeDefined();
        expect(credit).toBeDefined();
        expect(debit.debit.toString()).toBe('42.5');
        expect(credit.credit.toString()).toBe('42.5');
        // The authoritative custody asset is untouched by the webhook credit.
        expect(
            (await prisma.journalEntry.aggregate({
                where: { account: 'custody:deposit:usdc' },
                _sum: { debit: true, credit: true },
            }))._sum.debit ?? 0
        ).toBe(0);
        // EXACTLY ONE authoritative posting per deposit lifecycle (idempotent
        // ledger transaction — replay of the same webhook cannot duplicate it).
        expect(await prisma.ledgerTransaction.count({
            where: { idempotencyKey: `ledger:deposit:crypto:${txHash}` },
        })).toBe(1);
        // NO second, legacy shadow representation for the same lifecycle.
        expect(await prisma.journalEntry.count({
            where: { reference: txHash, ledgerTransactionId: null },
        })).toBe(0);
        // ZERO custody journal rows: §P.3 verification deliberately posts none.
        expect(await prisma.journalEntry.count({ where: { relatedEntity: 'custodyMovement' } })).toBe(0);
        // And the candidate exists alongside — custody truth, journal truth.
        expect(await candidateOf(txHash)).not.toBe(null);
    });

    it('over-precision amount REJECTS the webhook — ZERO completed financial mutation, no orphaned credit', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-inexact-amount-1';
        const depositRowsBefore = await prisma.transactionHistory.count({
            where: { userId: userA.id, type: 'DEPOSIT_CRYPTO' },
        });

        // 1.0000005 parses to a positive float (the legacy path would credit
        // it via toFixed(6) rounding) but is NOT exactly representable in
        // 6-decimal USDC base units. §P.3 fail closed: the webhook is
        // REJECTED BEFORE any financial mutation — no balance credit, no
        // TransactionHistory row, no journal entry, no custody movement. A
        // completed credit that custody accounting cannot represent would be
        // an orphaned financial claim; it must not exist.
        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: '1.0000005', asset: 'USDC',
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('EXACT_CUSTODY_QUANTITY_UNREPRESENTABLE');
        expect(await balanceOf(userA.id)).toBeCloseTo(1000);   // NO credit
        expect(await ledgerCount(txHash)).toBe(0);             // NO completed DEPOSIT_CRYPTO row for this webhook
        // And ZERO new DEPOSIT_CRYPTO rows were created — a rejected webhook
        // can never leave an orphaned completed credit behind.
        expect(await prisma.transactionHistory.count({
            where: { userId: userA.id, type: 'DEPOSIT_CRYPTO' },
        })).toBe(depositRowsBefore);
        expect(await candidateOf(txHash)).toBe(null);          // NO custody candidate
        await new Promise((r) => setTimeout(r, 150));          // let any stray fire-and-forget settle
        expect(await prisma.journalEntry.count({ where: { reference: txHash } })).toBe(0); // NO journal credit
    });

    it('scientific-notation amount REJECTS the webhook — zero mutation, even though the value is numerically representable', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-scientific-1';

        // '1.5e2' == 150 exactly, but scientific notation is NOT an exact
        // decimal-string quantity: it admits float re-interpretation and is
        // rejected on shape, fail closed.
        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: '1.5e2', asset: 'USDC',
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('EXACT_CUSTODY_QUANTITY_UNREPRESENTABLE');
        expect(await balanceOf(userA.id)).toBeCloseTo(1000);
        expect(await ledgerCount(txHash)).toBe(0);
        expect(await candidateOf(txHash)).toBe(null);
        expect(await prisma.journalEntry.count({ where: { reference: txHash } })).toBe(0);
    });

    it('malformed amount REJECTS the webhook before any financial mutation', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-malformed-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: '12.3.4', asset: 'USDC',
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('EXACT_CUSTODY_QUANTITY_UNREPRESENTABLE');
        expect(await balanceOf(userA.id)).toBeCloseTo(1000);
        expect(await ledgerCount(txHash)).toBe(0);
        expect(await candidateOf(txHash)).toBe(null);
    });

    it('an owner resolved ONLY through the legacy mirror (no §P.1 registry row) is REJECTED — no credit outside the custody boundary', async () => {
        const userA = await seedUser(prisma);
        // Legacy mirror ONLY: the address is on the User row but has NO
        // WalletAddress registry row — resolveOwner answers via
        // LEGACY_MIRROR with walletAddress: null. A completed crypto credit
        // here could not be represented by custody accounting (no custody
        // identity), so §P.3 fails closed.
        await prisma.user.update({
            where: { id: userA.id },
            data:  { tatumPolygonAddress: '0xlegacymirror000000000000000000000000001' },
        });
        const txHash = '0xwebhook-legacy-mirror-1';

        const res = await callWebhook({
            address: '0xlegacymirror000000000000000000000000001', txId: txHash, amount: 25, asset: 'USDC',
        });

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('CUSTODY_IDENTITY_UNRESOLVABLE');
        expect(await balanceOf(userA.id)).toBeCloseTo(1000);
        expect(await ledgerCount(txHash)).toBe(0);
        expect(await candidateOf(txHash)).toBe(null);
    });

    it('an EXACT valid raw string completes the credit AND records the exact custody candidate', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-exact-valid-1';

        const res = await callWebhook({
            address: allocated.address, txId: txHash, amount: '0.123456', asset: 'USDC',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(await balanceOf(userA.id)).toBeCloseTo(1000.123456);
        const row = await prisma.transactionHistory.findUnique({ where: { txHash } });
        expect(row.status).toBe('COMPLETED');
        expect(row.type).toBe('DEPOSIT_CRYPTO');
        const candidate = await candidateOf(txHash);
        expect(candidate).not.toBe(null);
        expect(candidate.amountBaseUnits).toBe(123456n);       // EXACT base units
        expect(candidate.metadata.creditedAmountDecimalString).toBe('0.123456');
    });

    it('a REPEATED webhook remains idempotent — one credit, one ledger row, one candidate', async () => {
        const userA = await seedUser(prisma);
        const allocated = await allocateDepositAddress(prisma, mockTatumService(), userA.id);
        const txHash = '0xwebhook-repeat-1';
        const body = { address: allocated.address, txId: txHash, amount: '12.5', asset: 'USDC' };

        const first = await callWebhook(body);
        expect(first.statusCode).toBe(200);
        expect(first.body.success).toBe(true);

        const second = await callWebhook(body);
        expect(second.statusCode).toBe(200);
        expect(second.body.data.alreadyProcessed).toBe(true);

        expect(await balanceOf(userA.id)).toBeCloseTo(1012.5); // credited ONCE
        expect(await ledgerCount(txHash)).toBe(1);              // ONE ledger row
        const candidates = await prisma.custodyMovement.count({
            where: { idempotencyKey: `deposit:POLYGON:${txHash}` },
        });
        expect(candidates).toBe(1);                            // ONE custody candidate
    });
});

// ── 13. Tatum webhook verification is fail-closed (no DB) ─────────────────────
describe('Tatum webhook verification gate (fail-closed in production)', () => {
    const depositController = require('../controllers/depositController');
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.TATUM_WEBHOOK_SECRET;

    beforeAll(() => {
        process.env.TATUM_WEBHOOK_SECRET = originalSecret || 'test_tatum_webhook_secret';
    });
    afterAll(() => {
        if (originalSecret === undefined) delete process.env.TATUM_WEBHOOK_SECRET;
        else process.env.TATUM_WEBHOOK_SECRET = originalSecret;
    });

    const makeReq = ({ body, signature, tatumService, prisma }) => ({
        body,
        headers: signature ? { 'x-payload-hash': signature } : {},
        rawBody: body ? JSON.stringify(body) : '',
        app: { get: (key) => ({ prisma, tatumService, socketio: null, emitBalanceUpdate: null }[key]) },
    });
    const makeRes = () => {
        const res = { statusCode: 0, body: null };
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    };
    const finPrisma = () => ({
        transactionHistory: { findUnique: jest.fn(), create: jest.fn() },
        user: { findFirst: jest.fn(), findUnique: jest.fn() },
        walletAddress: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    afterEach(() => { process.env.NODE_ENV = originalEnv; });

    it('production + unbound verifier + present signature header is REJECTED (previously passed unverified) and never reaches the ledger', async () => {
        process.env.NODE_ENV = 'production';
        const prisma = finPrisma();
        const req = makeReq({
            body: { address: '0x9999999999999999999999999999999999999999', txId: '0xtx1', amount: 5 },
            signature: 'deadbeef',
            tatumService: null,
            prisma,
        });
        const res = makeRes();
        await depositController.tatumCryptoWebhook(req, res);
        expect(res.statusCode).toBe(503);
        expect(prisma.transactionHistory.findUnique).not.toHaveBeenCalled();
        expect(prisma.transactionHistory.create).not.toHaveBeenCalled();
    });

    it('production + verifier + missing signature is rejected with 401 and no ledger access', async () => {
        process.env.NODE_ENV = 'production';
        const prisma = finPrisma();
        const tatum = { verifyWebhookSignature: jest.fn(() => true) };
        const req = makeReq({
            body: { address: '0x9999999999999999999999999999999999999999', txId: '0xtx2', amount: 5 },
            signature: null,
            tatumService: tatum,
            prisma,
        });
        const res = makeRes();
        await depositController.tatumCryptoWebhook(req, res);
        expect(res.statusCode).toBe(401);
        expect(prisma.transactionHistory.findUnique).not.toHaveBeenCalled();
    });

    it('production + invalid signature is rejected with 401 and no ledger access', async () => {
        process.env.NODE_ENV = 'production';
        const prisma = finPrisma();
        const tatum = { verifyWebhookSignature: jest.fn(() => false) };
        const req = makeReq({
            body: { address: '0x9999999999999999999999999999999999999999', txId: '0xtx3', amount: 5 },
            signature: 'baadf00d',
            tatumService: tatum,
            prisma,
        });
        const res = makeRes();
        await depositController.tatumCryptoWebhook(req, res);
        expect(res.statusCode).toBe(401);
        expect(tatum.verifyWebhookSignature).toHaveBeenCalled();
        expect(prisma.transactionHistory.findUnique).not.toHaveBeenCalled();
    });

    it('non-production without a signature still proceeds to the ledger path (test behavior not weakened)', async () => {
        process.env.NODE_ENV = 'test';
        const prisma = finPrisma();
        prisma.transactionHistory.findUnique.mockResolvedValue(null);
        prisma.transactionHistory.create.mockResolvedValue({ id: 'tx' });
        prisma.user.findFirst.mockResolvedValue(null);  // no owner — 200 unmatched
        prisma.user.findUnique.mockResolvedValue(null);
        const req = makeReq({
            body: { address: '0x9999999999999999999999999999999999999999', txId: '0xtx4', amount: 5 },
            signature: null,
            tatumService: null,
            prisma,
        });
        const res = makeRes();
        await depositController.tatumCryptoWebhook(req, res);
        expect(res.statusCode).toBe(200);
        expect(prisma.user.findFirst).toHaveBeenCalled();   // ownership resolution attempted — flow proceeded
    });
});
