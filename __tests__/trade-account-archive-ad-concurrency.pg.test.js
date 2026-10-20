// __tests__/trade-account-archive-ad-concurrency.pg.test.js
// =============================================================================
// ARCHIVE ↔ AD-CREATE LIFECYCLE INVARIANT (review follow-up 2026-10-20).
//
// INVARIANT under test: an ACTIVE Ad can never reference an archived
// TradeAccount, no matter how the two requests interleave.
//
// Protocol being proven (controllers/tradeAccountController.deleteTradeAccount
// + controllers/adController.createAd): both handlers run their
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
});
