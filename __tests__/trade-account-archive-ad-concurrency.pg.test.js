// __tests__/trade-account-archive-ad-concurrency.pg.test.js
// =============================================================================
// ARCHIVE ↔ AD-CREATE LIFECYCLE INVARIANT (review follow-up 2026-10-20).
//
// INVARIANT under test: an ACTIVE Ad can never reference an archived
// TradeAccount, no matter how the two requests interleave.
//
// Protocol being proven (controllers/tradeAccountController.deleteTradeAccount
// + controllers/adController.createAd + adController.toggleAdStatus): the
// account-touching handlers run their
// check-and-write phases inside ONE transaction whose FIRST statement is a
// SELECT ... FOR UPDATE on the same TradeAccount row. Postgres serializes the
// pair on that row lock:
//   - If the ad-creator wins, its ACTIVE Ad is committed before the archiver
//     re-reads the account; the archiver's active-ad count sees it and
//     refuses (400 "active ad(s) reference this account").
//   - If the archiver wins, archivedAt is committed before the ad-creator
//     re-reads the account; createAd rejects (400 "archived").
// Either way the final committed state satisfies the invariant.
//
// Real PostgreSQL only — this is a concurrency proof, mocks cannot show it.
// The disposable CI/local Postgres is exactly the environment for it.
//
// Also covers the plain lifecycle (no concurrency): an archived account —
// even one still owned by the caller and admin-approved — can never be
// attached to a new ad.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const adController = require('../controllers/adController');
const tradeAccountController = require('../controllers/tradeAccountController');
const queueController = require('../controllers/queueController');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('Trade-account archive ↔ ad-create lifecycle (real PostgreSQL)', () => {
    let prisma;
    const seededUsers = [];
    const seededAccounts = [];
    const seededAds = [];
    let seq;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        // Self-cleanup (children first — Ad vendors RESTRICT the user delete).
        if (prisma) {
            await prisma.ad.deleteMany({ where: { vendorId: { in: seededUsers } } });
            await prisma.tradeAccount.deleteMany({ where: { id: { in: seededAccounts } } });
            await prisma.user.deleteMany({ where: { id: { in: seededUsers } } });
            await prisma.$disconnect();
        }
    });

    const makeRes = () => {
        const res = {
            statusCode: null,
            body: null,
            // The §r42 claim-disposition flags (res.locals.financialClaimRelease)
            // are read by the idempotency MIDDLEWARE in production; the queue
            // handler sets them unconditionally, so every mocked response needs
            // a locals object.
            locals: {},
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
        };
        return res;
    };

    const handlerEnv = (userId) => ({
        app: {
            get: (key) => {
                if (key === 'prisma') return prisma;
                return undefined; // socketio absent on purpose
            },
        },
        user: { id: userId },
    });

    async function seedVendorAndAccount() {
        seq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        const user = await prisma.user.create({
            data: {
                username: `user_taac-${seq}`,
                email: `user_taac-${seq}@t.test`,
                password: 'x',
                vendorUnallocatedBalance: 1000000, // clears the collateral gate
            },
        });
        seededUsers.push(user.id);
        const account = await prisma.tradeAccount.create({
            data: {
                id: `ta-${seq}`,
                userId: user.id,
                methodType: 'ZELLE',
                accountDetails: {},
                verificationScreenshot: 'taac-test.png',
                adminVerificationStatus: 'APPROVED',
            },
        });
        seededAccounts.push(account.id);
        return { user, account };
    }

    const createAdReq = (userId, accountId) => ({
        ...handlerEnv(userId),
        body: {
            type: 'SELL',
            crypto: 'USDC',
            pricePerUSD: 1.0,
            minLimit: 10,
            maxLimit: 100,
            terms: 'taac test',
            tradeAccountId: accountId,
        },
        params: {},
    });

    const archiveReq = (userId, accountId) => ({
        ...handlerEnv(userId),
        params: { id: accountId },
        body: {},
    });

    const activeAdsOn = (accountId) =>
        prisma.ad.count({ where: { tradeAccountId: accountId, status: 'ACTIVE' } });

    test('lifecycle: an archived account can never be attached to a new ad', async () => {
        const { user, account } = await seedVendorAndAccount();

        // 1. Happy path: an APPROVED, non-archived account attaches fine.
        let res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(await activeAdsOn(account.id)).toBe(1);
        const firstAdId = res.body.ad.id;
        seededAds.push(firstAdId);

        // 2. Archive is refused while an ACTIVE ad references the account.
        res = makeRes();
        await tradeAccountController.deleteTradeAccount(archiveReq(user.id, account.id), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('active ad');

        // 3. Deactivate the ad (as deactivateAd would), then archive succeeds.
        await prisma.ad.update({ where: { id: firstAdId }, data: { status: 'INACTIVE' } });
        res = makeRes();
        await tradeAccountController.deleteTradeAccount(archiveReq(user.id, account.id), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const stored = await prisma.tradeAccount.findUnique({ where: { id: account.id } });
        expect(stored.archivedAt).not.toBeNull();
        expect(stored.archiveReason).toBe('USER_DELETED');

        // 4. THE GAP UNDER REVIEW: a stale/direct createAd against the now
        //    archived account (still owned, still APPROVED) must be rejected
        //    server-side, and no ad may be created.
        res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('archived');
        expect(await activeAdsOn(account.id)).toBe(0);
        const totalAds = await prisma.ad.count({ where: { tradeAccountId: account.id } });
        expect(totalAds).toBe(1); // only the original (now INACTIVE) ad
    });

    const toggleReq = (userId, adId) => ({
        ...handlerEnv(userId),
        params: { id: String(adId) },
        body: {},
    });

    test('lifecycle: an OFFLINE ad cannot be reactivated after its trade account is archived', async () => {
        const { user, account } = await seedVendorAndAccount();

        // Ad created and ACTIVE against the account.
        let res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        expect(res.statusCode).toBe(201);
        const adId = res.body.ad.id;
        seededAds.push(adId);

        // Deactivate via the toggle (legitimate deactivation path).
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ad.status).toBe('OFFLINE');

        // Archive now succeeds (no ACTIVE ads reference the account).
        res = makeRes();
        await tradeAccountController.deleteTradeAccount(archiveReq(user.id, account.id), res);
        expect(res.statusCode).toBe(200);
        const stored = await prisma.tradeAccount.findUnique({ where: { id: account.id } });
        expect(stored.archivedAt).not.toBeNull();

        // THE GAP UNDER REVIEW: reactivating the OFFLINE ad against the
        // archived account must be rejected server-side.
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('archived');

        // Committed-state invariant: no ACTIVE ad references an archived account.
        const ad = await prisma.ad.findUnique({ where: { id: adId } });
        expect(ad.status).toBe('OFFLINE');
        expect(await activeAdsOn(account.id)).toBe(0);

        // Deactivation of an ACTIVE ad remains allowed even after archive
        // (it only ever reduces the archiver's count).
        await prisma.ad.update({ where: { id: adId }, data: { status: 'ACTIVE' } });
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ad.status).toBe('OFFLINE');
        expect(await activeAdsOn(account.id)).toBe(0);
    });

    test('lifecycle: an ARCHIVED ad is terminal — the toggle path never resurrects it', async () => {
        const { user, account } = await seedVendorAndAccount();

        let res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        expect(res.statusCode).toBe(201);
        const adId = res.body.ad.id;
        seededAds.push(adId);

        // Deactivate, then soft-archive the ad via the archiveAd contract.
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        res = makeRes();
        await adController.archiveAd(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);

        // Toggle attempts on the terminally archived ad are refused.
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Archived ads cannot be reactivated');
        const ad = await prisma.ad.findUnique({ where: { id: adId } });
        expect(ad.status).toBe('ARCHIVED');
    });

    const archiveAdReq = (userId, adId) => ({
        ...handlerEnv(userId),
        params: { id: String(adId) },
        body: {},
    });

    test('queue policy: WAITING TradeQueue buyers block ad archival; cancelled entries do not', async () => {
        const { user, account } = await seedVendorAndAccount();

        let res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        expect(res.statusCode).toBe(201);
        const adId = res.body.ad.id;
        seededAds.push(adId);

        // Deactivate so the ad is archivable by status.
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);

        // A WAITING queue entry blocks the archive (queue policy, named
        // as exactly that — NOT a claim about in-progress trades).
        const queueEntry = await prisma.tradeQueue.create({
            data: { buyerId: user.id, adId, status: 'WAITING' },
        });
        res = makeRes();
        await adController.archiveAd(archiveAdReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain("waiting in this ad's trade queue");
        expect((await prisma.ad.findUnique({ where: { id: adId } })).status).toBe('OFFLINE');

        // A cancelled entry frees the archive.
        await prisma.tradeQueue.update({ where: { id: queueEntry.id }, data: { status: 'CANCELLED' } });
        res = makeRes();
        await adController.archiveAd(archiveAdReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        const stored = await prisma.ad.findUnique({ where: { id: adId } });
        expect(stored.status).toBe('ARCHIVED');
        expect(stored.archivedAt).not.toBeNull();
    });

    test('race: simultaneous toggle-reactivation vs archiveAd — ARCHIVED is terminal under concurrency (account-linked ads)', async () => {
        const ITERATIONS = 12;
        const outcomes = { archiveWon: 0, toggleWon: 0 };
        const biases = ['simultaneous', 'archive-first', 'toggle-first'];
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const { user, account } = await seedVendorAndAccount();
            const bias = biases[i % biases.length];

            // Seed an OFFLINE, account-linked ad — both writers flip it.
            let res = makeRes();
            await adController.createAd(createAdReq(user.id, account.id), res);
            const adId = res.body.ad.id;
            seededAds.push(adId);
            res = makeRes();
            await adController.toggleAdStatus(toggleReq(user.id, adId), res);
            expect(res.body.ad.status).toBe('OFFLINE');

            const archiveRes = makeRes();
            const toggleRes = makeRes();
            const runArchive = () => adController.archiveAd(archiveAdReq(user.id, adId), archiveRes);
            const runToggle = () => adController.toggleAdStatus(toggleReq(user.id, adId), toggleRes);
            await Promise.all([
                bias === 'toggle-first' ? delay(25).then(runArchive) : runArchive(),
                bias === 'archive-first' ? delay(25).then(runToggle) : runToggle(),
            ]);

            // Committed state after both transactions settled.
            const stored = await prisma.ad.findUnique({ where: { id: adId } });
            const succeeded = (r) => r.statusCode === 200 || r.statusCode === 201;
            const archiveWon = archiveRes.statusCode === 200;

            if (archiveWon) {
                outcomes.archiveWon += 1;
                // THE TERMINAL INVARIANT: a completed archive can never be
                // followed by an ACTIVE final state.
                expect(stored.status).toBe('ARCHIVED');
                expect(stored.archivedAt).not.toBeNull();
                expect(toggleRes.statusCode).toBe(400);
                expect(toggleRes.body.message).toContain('Archived ads cannot be reactivated');
            } else {
                outcomes.toggleWon += 1;
                // Toggle won: the ad is ACTIVE and the archive refused.
                expect(toggleRes.statusCode).toBe(200);
                expect(stored.status).toBe('ACTIVE');
                expect(archiveRes.statusCode).toBe(400);
                expect(archiveRes.body.message).toContain('Cannot archive an active ad');
            }
            // Exactly one winner — the pair can never both succeed.
            expect(succeeded(archiveRes) && succeeded(toggleRes)).toBe(false);
        }

        expect(outcomes.archiveWon + outcomes.toggleWon).toBe(ITERATIONS);
        expect(outcomes.archiveWon).toBeGreaterThan(0);
        expect(outcomes.toggleWon).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `toggle-vs-archive race outcomes over ${ITERATIONS} iterations: archive won ${outcomes.archiveWon}, reactivation won ${outcomes.toggleWon}`,
        );
    });

    test('race: toggle-reactivation vs archiveAd on ACCOUNT-UNLINKED ads — the Ad-row lock alone still enforces terminal ARCHIVED', async () => {
        const ITERATIONS = 12;
        const outcomes = { archiveWon: 0, toggleWon: 0 };
        const biases = ['simultaneous', 'archive-first', 'toggle-first'];
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const { user } = await seedVendorAndAccount();
            const bias = biases[i % biases.length];

            // Seed an OFFLINE ad with NO trade account — the Ad-row lock is
            // the only serialization point.
            let res = makeRes();
            await adController.createAd({
                ...handlerEnv(user.id),
                params: {},
                body: {
                    type: 'SELL', crypto: 'USDC', pricePerUSD: 1.0,
                    minLimit: 10, maxLimit: 100,
                    paymentMethod: 'Zelle', terms: 'taac unlinked',
                    // no tradeAccountId
                },
            }, res);
            expect(res.statusCode).toBe(201);
            const adId = res.body.ad.id;
            seededAds.push(adId);
            res = makeRes();
            await adController.toggleAdStatus(toggleReq(user.id, adId), res);
            expect(res.body.ad.status).toBe('OFFLINE');

            const archiveRes = makeRes();
            const toggleRes = makeRes();
            const runArchive = () => adController.archiveAd(archiveAdReq(user.id, adId), archiveRes);
            const runToggle = () => adController.toggleAdStatus(toggleReq(user.id, adId), toggleRes);
            await Promise.all([
                bias === 'toggle-first' ? delay(25).then(runArchive) : runArchive(),
                bias === 'archive-first' ? delay(25).then(runToggle) : runToggle(),
            ]);

            const stored = await prisma.ad.findUnique({ where: { id: adId } });
            if (archiveRes.statusCode === 200) {
                outcomes.archiveWon += 1;
                expect(stored.status).toBe('ARCHIVED');
                expect(toggleRes.statusCode).toBe(400);
            } else {
                outcomes.toggleWon += 1;
                expect(toggleRes.statusCode).toBe(200);
                expect(stored.status).toBe('ACTIVE');
                expect(archiveRes.statusCode).toBe(400);
            }
        }

        expect(outcomes.archiveWon + outcomes.toggleWon).toBe(ITERATIONS);
        expect(outcomes.archiveWon).toBeGreaterThan(0);
        expect(outcomes.toggleWon).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `unlinked toggle-vs-archive outcomes over ${ITERATIONS} iterations: archive won ${outcomes.archiveWon}, reactivation won ${outcomes.toggleWon}`,
        );
    });

    test('race: concurrent ad RE-activation vs account archival never leaves an ACTIVE ad on an archived account', async () => {
        const ITERATIONS = 12;
        const outcomes = { archiveWon: 0, activationWon: 0 };
        const biases = ['simultaneous', 'archive-first', 'activation-first'];
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const { user, account } = await seedVendorAndAccount();

            // Seed an OFFLINE, account-linked ad (the reactivation candidate).
            let res = makeRes();
            await adController.createAd(createAdReq(user.id, account.id), res);
            expect(res.statusCode).toBe(201);
            const adId = res.body.ad.id;
            seededAds.push(adId);
            res = makeRes();
            await adController.toggleAdStatus(toggleReq(user.id, adId), res);
            expect(res.body.ad.status).toBe('OFFLINE');

            const bias = biases[i % biases.length];
            const archiveRes = makeRes();
            const toggleRes = makeRes();
            const runArchive = () => tradeAccountController.deleteTradeAccount(archiveReq(user.id, account.id), archiveRes);
            const runToggle = () => adController.toggleAdStatus(toggleReq(user.id, adId), toggleRes);
            await Promise.all([
                bias === 'activation-first' ? delay(25).then(runArchive) : runArchive(),
                bias === 'archive-first' ? delay(25).then(runToggle) : runToggle(),
            ]);

            const stored = await prisma.tradeAccount.findUnique({ where: { id: account.id } });
            const activeAds = await activeAdsOn(account.id);
            const archived = stored.archivedAt !== null;
            if (archived) outcomes.archiveWon += 1; else outcomes.activationWon += 1;

            // THE INVARIANT, in committed database state.
            expect(archived && activeAds > 0).toBe(false);

            if (archived) {
                expect(toggleRes.statusCode).toBe(400);
                expect(toggleRes.body.message).toContain('archived');
                expect(archiveRes.statusCode).toBe(200);
            } else {
                // Activation won: ad ACTIVE, archive refused on active ads.
                expect(toggleRes.statusCode).toBe(200);
                expect(toggleRes.body.ad.status).toBe('ACTIVE');
                expect(activeAds).toBe(1);
                expect(archiveRes.statusCode).toBe(400);
                expect(archiveRes.body.message).toContain('active ad');
            }
        }

        expect(outcomes.archiveWon + outcomes.activationWon).toBe(ITERATIONS);
        // The biases must have crossed the lock in BOTH orders.
        expect(outcomes.archiveWon).toBeGreaterThan(0);
        expect(outcomes.activationWon).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `reactivation-race outcomes over ${ITERATIONS} iterations: archive won ${outcomes.archiveWon}, activation won ${outcomes.activationWon}`,
        );
    });

    test('race: concurrent archive + ad-create never leaves an ACTIVE ad on an archived account', async () => {
        const ITERATIONS = 12;
        const outcomes = { archiveWon: 0, adWon: 0 };

        // Three interleaving biases so BOTH orders of the pair actually
        // occur: simultaneous, archive a beat earlier, ad a beat earlier.
        const biases = ['simultaneous', 'archive-first', 'ad-first'];
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const { user, account } = await seedVendorAndAccount();
            const bias = biases[i % biases.length];

            // Fire both handlers on the same account, biased per variant.
            // The res objects are captured up front — controller return
            // values are not relied upon.
            const archiveRes = makeRes();
            const adRes = makeRes();
            const runArchive = () => tradeAccountController.deleteTradeAccount(archiveReq(user.id, account.id), archiveRes);
            const runAd = () => adController.createAd(createAdReq(user.id, account.id), adRes);
            await Promise.all([
                bias === 'ad-first' ? delay(25).then(runArchive) : runArchive(),
                bias === 'archive-first' ? delay(25).then(runAd) : runAd(),
            ]);

            // Fresh committed state after both transactions settled.
            const stored = await prisma.tradeAccount.findUnique({ where: { id: account.id } });
            const activeAds = await activeAdsOn(account.id);

            const archived = stored.archivedAt !== null;
            if (archived) outcomes.archiveWon += 1; else outcomes.adWon += 1;

            // THE INVARIANT — either way the interleaving resolved:
            expect(archived && activeAds > 0).toBe(false);

            // The losing side must have been rejected with a truthful error
            // (not a 500, not a silent no-op).
            if (archived) {
                expect(adRes.statusCode).toBe(400);
                expect(adRes.body.message).toContain('archived');
            } else {
                expect(activeAds).toBe(1);
                expect(archiveRes.statusCode).toBe(400);
                expect(archiveRes.body.message).toContain('active ad');
            }

            // Every winning side reports success.
            if (archived) expect(archiveRes.statusCode).toBe(200);
            else expect(adRes.statusCode).toBe(201);
        }

        // Sanity: the loop actually exercised the race (and did not,
        // e.g., silently skip iterations).
        expect(outcomes.archiveWon + outcomes.adWon).toBe(ITERATIONS);
        // The two interleaving biases must BOTH have produced a winner —
        // otherwise the race never actually crossed the lock and the proof
        // would only cover one ordering.
        expect(outcomes.adWon).toBeGreaterThan(0);
        expect(outcomes.archiveWon).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `race outcomes over ${ITERATIONS} iterations: archive won ${outcomes.archiveWon}, ad-creation won ${outcomes.adWon}`,
        );
    });
    // ═══════════════════════════════════════════════════════════════════════
    // FINAL REVIEW (2026-10-20): ARCHIVED terminal across EVERY status
    // writer + queue-admission mutual exclusion
    // ═══════════════════════════════════════════════════════════════════════

    const deactivateReq = toggleReq; // same shape: params.id + auth env

    async function seedArchivedAd(linked) {
        const { user, account } = await seedVendorAndAccount();
        const res = makeRes();
        await adController.createAd(createAdReq(user.id, linked ? account.id : null), res);
        expect(res.statusCode).toBe(201);
        const adId = res.body.ad.id;
        seededAds.push(adId);
        await prisma.ad.update({ where: { id: adId }, data: { status: 'OFFLINE' } });
        const archRes = makeRes();
        await adController.archiveAd(toggleReq(user.id, adId), archRes);
        expect(archRes.statusCode).toBe(200);
        const ad = await prisma.ad.findUnique({ where: { id: adId } });
        expect(ad.status).toBe('ARCHIVED');
        return { user, account, adId };
    }

    async function seedBuyer() {
        seq = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        const buyer = await prisma.user.create({
            data: {
                username: `user_taac-buyer-${seq}`,
                email: `user_taac-buyer-${seq}@t.test`,
                password: 'x',
            },
        });
        seededUsers.push(buyer.id);
        return buyer;
    }

    const joinQueueReq = (buyerId, adId) => ({
        ...handlerEnv(buyerId),
        params: {},
        body: {
            adId: String(adId),
            amountCrypto: '50',
            amountFiat: '50',
            paymentMethod: 'Zelle',
        },
    });

    const waitingEntriesOn = (adId) =>
        prisma.tradeQueue.count({ where: { adId, status: 'WAITING' } });

    test('terminal: ARCHIVED ad cannot be DEACTIVATED back to life (linked + unlinked)', async () => {
        for (const linked of [true, false]) {
            const { user, adId } = await seedArchivedAd(linked);
            const res = makeRes();
            await adController.deactivateAd(deactivateReq(user.id, adId), res);
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('archived');
            const ad = await prisma.ad.findUnique({ where: { id: adId } });
            expect(ad.status).toBe('ARCHIVED'); // terminal marker preserved
        }
    });

    test('terminal: ARCHIVED unlinked ad cannot be TOGGLED back to life', async () => {
        const { user, adId } = await seedArchivedAd(false);
        const res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Archived');
        const ad = await prisma.ad.findUnique({ where: { id: adId } });
        expect(ad.status).toBe('ARCHIVED');
    });

    test('race: archive vs deactivate — a committed archive is NEVER overwritten (linked + unlinked)', async () => {
        const ITERATIONS = 12;
        const BIASES = ['simultaneous', 'archive-first', 'deactivate-first'];
        const outcomes = { archiveWon: 0, deactivateThenArchive: 0 };
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const bias = BIASES[i % BIASES.length];
            const linked = i % 2 === 0;
            const { user, adId } = await (async () => {
                const { user, account } = await seedVendorAndAccount();
                const res = makeRes();
                await adController.createAd(createAdReq(user.id, linked ? account.id : null), res);
                expect(res.statusCode).toBe(201);
                const adId = res.body.ad.id;
                seededAds.push(adId);
                // Park the ad OFFLINE: both writers' valid pre-state.
                await prisma.ad.update({ where: { id: adId }, data: { status: 'OFFLINE' } });
                return { user, adId };
            })();

            const archiveRes = makeRes();
            const deactRes = makeRes();
            const runArchive = () => adController.archiveAd(toggleReq(user.id, adId), archiveRes);
            const runDeact = () => adController.deactivateAd(deactivateReq(user.id, adId), deactRes);

            await Promise.all([
                bias === 'archive-first' ? delay(25).then(runDeact) : runDeact(),
                bias === 'deactivate-first' ? delay(25).then(runArchive) : runArchive(),
            ]);

            // Committed-state invariant: the final status is ARCHIVED in
            // EVERY possible interleaving — either archive won outright, or
            // deactivate committed first (INACTIVE, which is legitimately
            // archivable) and the archive then succeeded. A committed
            // archive can never end up INACTIVE/OFFLINE.
            const ad = await prisma.ad.findUnique({ where: { id: adId } });
            expect(ad.status).toBe('ARCHIVED');
            expect(ad.archivedAt).not.toBeNull();

            if (deactRes.statusCode === 200) {
                // Deactivate won the lock race: archive then re-read
                // INACTIVE under the lock and legitimately archived it.
                expect(archiveRes.statusCode).toBe(200);
                outcomes.deactivateThenArchive++;
            } else {
                // Archive won outright: deactivate re-read ARCHIVED under
                // the lock and was truthfully refused.
                expect(archiveRes.statusCode).toBe(200);
                expect(deactRes.statusCode).toBe(400);
                expect(deactRes.body.message).toContain('archived');
                outcomes.archiveWon++;
            }
        }
        expect(outcomes.archiveWon + outcomes.deactivateThenArchive).toBe(ITERATIONS);
        expect(outcomes.archiveWon).toBeGreaterThan(0);
        expect(outcomes.deactivateThenArchive).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `archive-vs-deactivate race over ${ITERATIONS} iterations: archive outright ${outcomes.archiveWon}, deactivate-then-archive ${outcomes.deactivateThenArchive}`,
        );
    });

    test('queue admission: a WAITING entry can never be created for a non-ACTIVE or archived ad', async () => {
        const { user, account } = await seedVendorAndAccount();
        const buyer = await seedBuyer();
        const res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        const adId = res.body.ad.id;
        seededAds.push(adId);
        // Always-busy: every admission takes the queue path deterministically.
        await prisma.ad.update({ where: { id: adId }, data: { maxConcurrentTrades: 0 } });

        // OFFLINE ad → admission refused truthfully, no entry.
        await prisma.ad.update({ where: { id: adId }, data: { status: 'OFFLINE' } });
        let adm = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), adm);
        expect(adm.statusCode).toBe(400);
        expect(adm.body.message).toContain('not active');
        expect(await waitingEntriesOn(adId)).toBe(0);

        // LEGACY row: archivedAt set but status still ACTIVE → refused too.
        await prisma.ad.update({ where: { id: adId }, data: { status: 'ACTIVE', archivedAt: new Date() } });
        adm = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), adm);
        expect(adm.statusCode).toBe(400);
        expect(await waitingEntriesOn(adId)).toBe(0);

        // Clean legacy marker; ACTIVE ad → admission succeeds (queue path
        // works again after the Int/String type fix).
        await prisma.ad.update({ where: { id: adId }, data: { archivedAt: null } });
        adm = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), adm);
        expect(adm.statusCode).toBe(200);
        expect(adm.body.queued).toBe(true);
        expect(await waitingEntriesOn(adId)).toBe(1);

        // ARCHIVED terminal state → refused again.
        await prisma.ad.update({ where: { id: adId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
        adm = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), adm);
        expect(adm.statusCode).toBe(400);
        expect(await waitingEntriesOn(adId)).toBe(1); // unchanged — no new entry
    });

    test('queue admission: dedup preserved — the same buyer is not double-admitted', async () => {
        const { user, account } = await seedVendorAndAccount();
        const buyer = await seedBuyer();
        const res = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), res);
        const adId = res.body.ad.id;
        seededAds.push(adId);
        await prisma.ad.update({ where: { id: adId }, data: { maxConcurrentTrades: 0 } });

        const first = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), first);
        expect(first.statusCode).toBe(200);
        expect(first.body.queued).toBe(true);

        const second = makeRes();
        await queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), second);
        expect(second.statusCode).toBe(200);
        expect(second.body.queued).toBe(true);
        expect(second.body.message).toContain('already in the queue');
        expect(await waitingEntriesOn(adId)).toBe(1); // exactly one entry
    });

    test('race: queue admission vs deactivate+archive — no WAITING entry survives against an ARCHIVED ad', async () => {
        const ITERATIONS = 12;
        const BIASES = ['simultaneous', 'admission-first', 'archive-first'];
        const outcomes = { admissionWon: 0, deactivateWon: 0 };
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let i = 0; i < ITERATIONS; i++) {
            const bias = BIASES[i % BIASES.length];
            const { user, account } = await seedVendorAndAccount();
            const buyer = await seedBuyer();
            const res = makeRes();
            await adController.createAd(createAdReq(user.id, account.id), res);
            const adId = res.body.ad.id;
            seededAds.push(adId);
            await prisma.ad.update({ where: { id: adId }, data: { maxConcurrentTrades: 0 } });

            const admRes = makeRes();
            const runAdmission = () =>
                queueController.initiateTradeWithQueue(joinQueueReq(buyer.id, adId), admRes);
            // Vendor side: deactivate then attempt archive (the ad ends
            // up either OFFLINE-with-queue-entry or ARCHIVED-clean).
            const vendRes = { deactivate: makeRes(), archive: makeRes() };
            const runVendorPair = async () => {
                await adController.deactivateAd(deactivateReq(user.id, adId), vendRes.deactivate);
                await adController.archiveAd(toggleReq(user.id, adId), vendRes.archive);
            };

            await Promise.all([
                bias === 'admission-first' ? delay(25).then(runVendorPair) : runVendorPair(),
                bias === 'archive-first' ? delay(25).then(runAdmission) : runAdmission(),
            ]);

            const ad = await prisma.ad.findUnique({ where: { id: adId } });
            const waiting = await waitingEntriesOn(adId);

            if (admRes.statusCode === 200 && admRes.body.queued) {
                // Admission committed while the ad was still ACTIVE: the
                // entry exists, deactivate succeeded (INACTIVE does not
                // touch queue entries), and the ARCHIVE was then REFUSED by
                // the queue guard — an ARCHIVED ad never carries a WAITING
                // entry. Both responses truthful.
                outcomes.admissionWon++;
                expect(ad.status).toBe('INACTIVE');
                expect(waiting).toBe(1);
                expect(vendRes.archive.statusCode).toBe(400);
                expect(vendRes.archive.body.message).toContain('waiting');
            } else {
                // Deactivate won the ad lock: admission re-read OFFLINE
                // under the lock and was refused — no entry, archive then
                // completes cleanly.
                outcomes.deactivateWon++;
                expect(admRes.statusCode).toBe(400);
                expect(admRes.body.message).toContain('not active');
                expect(ad.status).toBe('ARCHIVED');
                expect(waiting).toBe(0);
                expect(vendRes.archive.statusCode).toBe(200);
            }
            // Global invariant either way: an ARCHIVED ad has NO WAITING
            // queue entry created against it.
            if (ad.status === 'ARCHIVED') expect(waiting).toBe(0);
        }
        expect(outcomes.admissionWon + outcomes.deactivateWon).toBe(ITERATIONS);
        expect(outcomes.admissionWon).toBeGreaterThan(0);
        expect(outcomes.deactivateWon).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
            `admission-vs-archive race over ${ITERATIONS} iterations: admission won ${outcomes.admissionWon}, deactivate+archive won ${outcomes.deactivateWon}`,
        );
    });
    // ═══════════════════════════════════════════════════════════════════════
    // APPROVAL FOLLOW-UP (2026-10-20): legacy archivedAt marker in toggle +
    // TradeQueue Int-type lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    test('legacy marker: stale-status ad with archivedAt set cannot be toggled (account-linked)', async () => {
        const { user, account } = await seedVendorAndAccount();
        const createRes = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), createRes);
        const adId = createRes.body.ad.id;
        // Deactivate first (legitimate), then simulate a LEGACY inconsistent
        // row: archivedAt stamped but the status never made it to ARCHIVED.
        let res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        const stampedAt = new Date();
        await prisma.ad.update({ where: { id: adId }, data: { archivedAt: stampedAt } });

        // The toggle (in EITHER direction) must be refused on the marker
        // alone — status alone is not a sufficient archive marker.
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Archived');

        // Committed state is UNTOUCHED — both status and marker intact.
        const after = await prisma.ad.findUnique({ where: { id: adId } });
        expect(after.status).toBe('OFFLINE');
        expect(new Date(after.archivedAt).getTime()).toBe(stampedAt.getTime());
    });

    test('legacy marker: stale-status UNLINKED ad with archivedAt set cannot be toggled', async () => {
        const { user } = await seedVendorAndAccount();
        const createRes = makeRes();
        await adController.createAd(createAdReq(user.id, null), createRes);
        const adId = createRes.body.ad.id;
        let res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200); // ACTIVE → OFFLINE, legitimate
        const stampedAt = new Date();
        await prisma.ad.update({ where: { id: adId }, data: { archivedAt: stampedAt } });

        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Archived');

        const after = await prisma.ad.findUnique({ where: { id: adId } });
        expect(after.status).toBe('OFFLINE');
        expect(new Date(after.archivedAt).getTime()).toBe(stampedAt.getTime());

        // Deactivation of a NON-archived ad still works (guard does not
        // over-block): clear the marker, reactivate, deactivate again.
        await prisma.ad.update({ where: { id: adId }, data: { archivedAt: null } });
        res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.ad.status).toBe('ACTIVE');
    });

    test('queue lifecycle (Int columns end-to-end): admit → status → position → leave; foreign buyer refused', async () => {
        const { user, account } = await seedVendorAndAccount();
        const buyer = await seedBuyer();
        const otherBuyer = await seedBuyer();

        // Ad at zero capacity → every admission takes the queue path.
        const createRes = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), createRes);
        const adId = createRes.body.ad.id;
        await prisma.ad.update({ where: { id: adId }, data: { maxConcurrentTrades: 0 } });

        // ── Admission (Int buyerId/adId write path) ──
        const admitRes = makeRes();
        await queueController.initiateTradeWithQueue({
            ...handlerEnv(buyer.id),
            body: { adId: String(adId), amountCrypto: '50', amountFiat: '50', paymentMethod: 'Zelle' },
        }, admitRes);
        expect(admitRes.statusCode).toBe(200);
        expect(admitRes.body.queued).toBe(true);
        const queueId = admitRes.body.queueId;
        expect(typeof queueId).toBe('string'); // UUID identity preserved

        // ── Status read: numeric filters, real position ──
        const statusRes = makeRes();
        await queueController.getQueueStatus({
            ...handlerEnv(buyer.id),
            query: {},
        }, statusRes);
        expect(statusRes.statusCode).toBe(200);
        const mine = statusRes.body.queue.find((e) => e.id === queueId);
        expect(mine).toBeDefined();
        expect(mine.position).toBe(1);

        // Invalid adId query → truthful 400, not a Prisma 500.
        const badRes = makeRes();
        await queueController.getQueueStatus({
            ...handlerEnv(buyer.id),
            query: { adId: 'not-a-number' },
        }, badRes);
        expect(badRes.statusCode).toBe(400);

        // ── Foreign buyer cannot leave someone else's entry ──
        const foreignRes = makeRes();
        await queueController.leaveQueue({
            ...handlerEnv(otherBuyer.id),
            params: { queueId },
        }, foreignRes);
        expect(foreignRes.statusCode).toBe(403);

        // ── Owner leaves their own WAITING entry ──
        const leaveRes = makeRes();
        await queueController.leaveQueue({
            ...handlerEnv(buyer.id),
            params: { queueId },
        }, leaveRes);
        expect(leaveRes.statusCode).toBe(200);

        // Entry is finalized; a second leave loses the conditional race.
        const releaveRes = makeRes();
        await queueController.leaveQueue({
            ...handlerEnv(buyer.id),
            params: { queueId },
        }, releaveRes);
        expect([400, 409]).toContain(releaveRes.statusCode);

        // ── Post-leave state: no WAITING entries, counts consistent ──
        const afterStatus = makeRes();
        await queueController.getQueueStatus({
            ...handlerEnv(buyer.id),
            query: { adId: String(adId) },
        }, afterStatus);
        expect(afterStatus.statusCode).toBe(200);
        expect(afterStatus.body.queue).toHaveLength(0);
        const entry = await prisma.tradeQueue.findUnique({ where: { id: queueId } });
        expect(entry.status).toBe('CANCELLED');
        expect(entry.buyerId).toBe(buyer.id); // Int identity round-trips
    });

    test('queue admission E2E cannot create a WAITING entry against an archived ad', async () => {
        const { user, account } = await seedVendorAndAccount();
        const buyer = await seedBuyer();
        const createRes = makeRes();
        await adController.createAd(createAdReq(user.id, account.id), createRes);
        const adId = createRes.body.ad.id;
        await prisma.ad.update({ where: { id: adId }, data: { maxConcurrentTrades: 0 } });

        // Deactivate + archive the ad first.
        let res = makeRes();
        await adController.toggleAdStatus(toggleReq(user.id, adId), res); // ACTIVE → OFFLINE
        res = makeRes();
        await adController.archiveAd(toggleReq(user.id, adId), res);
        expect(res.statusCode).toBe(200);

        // The optimistic pre-read would see a row; the locked re-check must
        // refuse admission with a truthful 4xx and create NO entry.
        const admitRes = makeRes();
        await queueController.initiateTradeWithQueue({
            ...handlerEnv(buyer.id),
            body: { adId: String(adId), amountCrypto: '50', amountFiat: '50', paymentMethod: 'Zelle' },
        }, admitRes);
        expect(admitRes.statusCode).toBe(400);

        const entries = await prisma.tradeQueue.count({ where: { adId, status: 'WAITING' } });
        expect(entries).toBe(0);
    });
});
