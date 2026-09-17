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
//    not weakened.
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
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        // Established suite-cleanup pattern (cf. shift-scheduling-integrity):
        // truncate the registry and the seeded users (CASCADE clears their
        // TransactionHistory ledger rows and all other FK references).
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "WalletAddress", "User" RESTART IDENTITY CASCADE');
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
        expect(NATIVE_USDC.contractAddress).toBe('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
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
            allocateDepositAddress(prisma, mockTatumService(), user.id, {
                identity: { network: 'POLYGON', asset: 'USDC', contractAddress: '0x2791b9717a737ca894d692502e875a1a8eab1cfa' },
            })
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET_IDENTITY' });

        const rows = await prisma.walletAddress.findMany({ where: { userId: user.id } });
        expect(rows).toHaveLength(0);
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
