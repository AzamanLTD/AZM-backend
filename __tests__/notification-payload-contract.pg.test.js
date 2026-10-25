// __tests__/notification-payload-contract.pg.test.js
// =============================================================================
// Priority E — notification category / actionPayload CONTRACT audit suite.
//
// Pins the documented contract (docs/notification-payload-contract.md):
//   A. Every NotificationCategory enum value survives the service's
//      normalization (STOREFRONT was previously dropped to GENERAL);
//      unknown categories fail safe to GENERAL.
//   B. The four repaired producers persist schema-valid notifications:
//      1. counterProposeReservation  — was a PrismaClientValidationError on
//         nonexistent `type`/`metadata` columns + invalid `MARKETPLACE`
//         category, thrown AFTER the reservation update committed (500 on a
//         request that actually succeeded; no notification ever persisted).
//      2. acceptCounterProposal      — same invalid create, same failure.
//      3. businessReviewService     — same invalid create, silently
//         swallowed: the business NEVER received review notifications.
//      4. payoutBatchWorker         — passed `message` where the service
//         signature expects `body`, so the required column was undefined and
//         the create always failed into a `.catch(() => {})`: the user was
//         never told their withdrawal went to manual review.
//   C. Emitted payloads for the repaired producers match the canonical
//      `{ route, action, ...ids }` deep-link shape and carry the documented
//      target identifiers.
//   D. Static invariant: no producer in the tree passes a non-enum category
//      literal or nonexistent Notification columns ever again.
//
// DB-backed suites run only when TEST_DATABASE_URL is set (CI provides a
// disposable PostgreSQL instance); the normalization and static-invariant
// suites always run.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { seedUser, seedBusiness } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[notification-payload-contract.test] TEST_DATABASE_URL not set — DB suites skipped.');

// The Prisma NotificationCategory enum, mirrored exactly.
const ENUM_CATEGORIES = [
    'GENERAL', 'SECURITY_ACCOUNT', 'VENDOR_PRIORITY', 'ADMIN_SYSTEM', 'MONEY',
    'SOCIAL', 'CHAT', 'SYSTEM', 'VAULT', 'SUSU', 'SMART_ROUTE', 'AUCTION', 'STOREFRONT',
];

// ── A. Category normalization (unit, always runs) ─────────────────────────
describe('NotificationService category normalization', () => {
    const makeService = () => {
        const NotificationService = require('../services/notificationService');
        const created = [];
        const prisma = {
            notification: {
                create: async ({ data }) => { created.push(data); return { id: `n${created.length}`, ...data }; },
                findFirst: async () => null,
            },
            user: { findUnique: async () => ({ fcmToken: null }) },
        };
        const svc = new NotificationService(prisma, null);
        return { svc, created };
    };

    test.each(ENUM_CATEGORIES)('preserves enum category %s at the persistence boundary', async (category) => {
        const { svc, created } = makeService();
        await svc.sendNotification({ userId: 1, title: 't', body: 'b', category, actionPayload: { route: '/', action: 'OPEN_HOME' } });
        expect(created).toHaveLength(1);
        expect(created[0].category).toBe(category);
    });

    test('unknown categories fail safe to GENERAL (legacy/typo tolerance)', async () => {
        const { svc, created } = makeService();
        await svc.sendNotification({ userId: 1, title: 't', body: 'b', category: 'TRADE', actionPayload: {} });
        await svc.sendNotification({ userId: 1, title: 't', body: 'b', category: 'MARKET', actionPayload: {} });
        await svc.sendNotification({ userId: 1, title: 't', body: 'b', category: 'MARKETPLACE', actionPayload: {} });
        expect(created.map((d) => d.category)).toEqual(['GENERAL', 'GENERAL', 'GENERAL']);
    });

    test('missing actionPayload deep-links safely to home', async () => {
        const { svc, created } = makeService();
        await svc.sendNotification({ userId: 1, title: 't', body: 'b', category: 'GENERAL' });
        expect(created[0].actionPayload).toEqual({ route: '/', action: 'OPEN_HOME' });
    });
});

// ── D. Static producer invariants (unit, always runs) ─────────────────────
describe('Notification producer static invariants', () => {
    const ROOT = path.join(__dirname, '..');

    const walk = (dir, acc = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')
                || entry.name === '__tests__' || entry.name === 'test' || entry.name === 'test-support' || entry.name === 'tests') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, acc);
            else if (entry.name.endsWith('.js')) acc.push(full);
        }
        return acc;
    };

    let sources;
    beforeAll(() => { sources = walk(ROOT); });

    test('no producer writes nonexistent Notification columns (`type`/`metadata` at column level)', () => {
        const offenders = [];
        for (const file of sources) {
            const src = fs.readFileSync(file, 'utf8');
            // notification.create({...data: {...}}) blocks that pass a
            // top-level `type:` or `metadata:` key — the Notification model
            // has neither column (the transit-reminder remediation, #270,
            // established the actionPayload convention; this gate keeps
            // the rest honest).
            const re = /notification\.create\(\s*\{\s*data:\s*\{([\s\S]{0,900}?)\n\s*\}\s*\n?\s*\}\s*\)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                const block = m[1];
                const topLevel = block.split('actionPayload')[0]; // keys BEFORE actionPayload are top-level columns
                if (/^\s*(type|metadata)\s*:/m.test(topLevel)) offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('no producer passes a non-enum category literal to a notification write', () => {
        // Scoped to NOTIFICATION writes only: notification.create({ data: { category } })
        // and sendNotification({ category }). Other models (BusinessLedgerEntry,
        // etc.) own their own category strings and are out of scope here.
        const offenders = [];
        const enumSet = new Set(ENUM_CATEGORIES);
        const blockRe = /(?:notification\.create\(\s*\{\s*data:\s*\{|sendNotification\(\s*\{)([\s\S]{0,1200}?)\n\s*\}\s*\)?/g;
        const catRe = /category:\s*['"]([A-Z_]+)['"]/;
        for (const file of sources) {
            const src = fs.readFileSync(file, 'utf8');
            let m;
            while ((m = blockRe.exec(src)) !== null) {
                const cat = catRe.exec(m[1]);
                if (cat && !enumSet.has(cat[1])) offenders.push(`${file}: category '${cat[1]}'`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('sendNotification callers pass `body` (the service signature), never `message`', () => {
        const offenders = [];
        for (const file of sources) {
            const src = fs.readFileSync(file, 'utf8');
            const re = /sendNotification\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                const block = m[1];
                if (/^\s*message\s*:/m.test(block) && !/^\s*body\s*:/m.test(block)) {
                    offenders.push(`${file}: uses \`message\` instead of \`body\``);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

// ── B + C. Repaired producers against a real PostgreSQL (CI parity) ────────
describeOrSkip('Notification payload contract — repaired producers (DB)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "Notification", "Reservation", "BusinessReview", "BusinessProfile", "BusinessProduct", "BusinessFollower", "BusinessInvoice", "Withdrawal", "TransactionHistory", "User" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const seedReservationContext = async () => {
        const { biz, owner } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);
        const reservation = await prisma.reservation.create({
            data: {
                reservationRef: `RES-CT-${Date.now()}`,
                businessProfileId: biz.id,
                customerId: customer.id,
                status: 'PENDING',
                startDatetime: new Date(Date.now() + 24 * 60 * 60 * 1000),
                endDatetime: new Date(Date.now() + 25 * 60 * 60 * 1000),
                amountUsdc: 100,
            },
        });
        return { biz, owner, customer, reservation };
    };

    // Minimal express-style req/res driver (r42 precedent).
    const drive = (handler, { user, params, body, app }) => new Promise((resolve) => {
        const req = {
            params: params || {}, body: body || {}, user,
            prisma, app, get: (k) => app.get(k),
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
        };
        Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
    });

    test('counterProposeReservation: 200, reservation updated, schema-valid notification with the counter-proposal identity', async () => {
        const { biz, customer, reservation } = await seedReservationContext();
        const emitted = [];
        const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };
        app.set('io', { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });

        const { counterProposeReservation } = require('../controllers/reservationController');
        const proposedStart = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const out = await drive(counterProposeReservation, {
            user: { id: biz.userId },
            params: { reservationId: reservation.id },
            body: { proposedStartDatetime: proposedStart, message: 'Evening slot instead?' },
            app,
        });

        // The OLD payload 500'd after the update committed. Now: 200.
        expect(out.status).toBe(200);
        expect(out.body.success).toBe(true);

        const updated = await prisma.reservation.findUnique({ where: { id: reservation.id } });
        expect(updated.proposedStartDatetime).toEqual(new Date(proposedStart));
        expect(updated.counterProposeMessage).toBe('Evening slot instead?');

        // Notification persisted with the REAL schema shape.
        const notifs = await prisma.notification.findMany({ where: { userId: customer.id } });
        expect(notifs).toHaveLength(1);
        const n = notifs[0];
        expect(n.category).toBe('GENERAL');
        expect(n.title).toContain('proposed an alternative time');
        expect(n.actionPayload).toMatchObject({
            action: 'COUNTER_PROPOSAL',
            type: 'COUNTER_PROPOSAL',
            reservationId: reservation.id,
        });
        // Real-time push still reaches the customer's room.
        expect(emitted).toHaveLength(1);
        expect(emitted[0].room).toBe(`user_${customer.id}`);
        expect(emitted[0].event).toBe('counter_proposal');
    });

    test('acceptCounterProposal: 200, reservation accepted, schema-valid notification to the business owner', async () => {
        const { biz, customer, reservation } = await seedReservationContext();
        await prisma.reservation.update({
            where: { id: reservation.id },
            data: {
                proposedStartDatetime: new Date(Date.now() + 48 * 60 * 60 * 1000),
                proposedEndDatetime: new Date(Date.now() + 49 * 60 * 60 * 1000),
            },
        });
        const app = { settings: {}, get(k) { return this.settings[k]; }, set(k, v) { this.settings[k] = v; } };

        const { acceptCounterProposal } = require('../controllers/reservationController');
        const out = await drive(acceptCounterProposal, {
            user: { id: customer.id },
            params: { reservationId: reservation.id },
            app,
        });

        expect(out.status).toBe(200);
        const updated = await prisma.reservation.findUnique({ where: { id: reservation.id } });
        expect(updated.proposedStartDatetime).toBeNull();

        const notifs = await prisma.notification.findMany({ where: { userId: biz.userId } });
        expect(notifs).toHaveLength(1);
        expect(notifs[0].category).toBe('GENERAL');
        expect(notifs[0].body).toContain('accepted your proposed alternative');
        expect(notifs[0].actionPayload).toMatchObject({
            action: 'COUNTER_PROPOSAL_ACCEPTED',
            type: 'COUNTER_PROPOSAL_ACCEPTED',
            reservationId: reservation.id,
        });
    });

    test('createReview: the business owner now receives a schema-valid review notification', async () => {
        const { biz, owner } = await seedBusiness(prisma);
        const customer = await seedUser(prisma);

        // PAID invoice path — the real write path a customer review rides on.
        const invoice = await prisma.businessInvoice.create({
            data: {
                businessProfileId: biz.id, customerId: customer.id,
                invoiceRef: `INV-CT-${Date.now()}`,
                status: 'PAID', subtotalUsdc: 20, billTotalUsdc: 20, paidAt: new Date(),
            },
        });
        const { createReview } = require('../services/businessReviewService');
        const review = await createReview(prisma, {
            businessProfileId: biz.id, reviewerId: customer.id,
            rating: 4, comment: 'Solid', sourceType: 'INVOICE', invoiceId: invoice.id,
        });
        expect(review).toBeTruthy();

        const notifs = await prisma.notification.findMany({ where: { userId: owner.id } });
        expect(notifs).toHaveLength(1);
        const n = notifs[0];
        expect(n.category).toBe('GENERAL');
        expect(n.body).toContain('4★');
        expect(n.actionPayload).toMatchObject({
            action: 'REVIEW_RECEIVED',
            type: 'REVIEW_RECEIVED',
            businessProfileId: biz.id,
            rating: 4,
        });
        expect(n.actionPayload.reviewId).toBe(review.id);
    });

    test('payoutBatchWorker._flagForManualReview: the user is actually notified their withdrawal is under review', async () => {
        const user = await seedUser(prisma);
        const withdrawal = await prisma.withdrawal.create({
            data: { userId: user.id, amount: 50, status: 'PROCESSING', payoutMethod: 'BINANCE_ID' },
        });

        const NotificationService = require('../services/notificationService');
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const worker = new PayoutBatchWorker(prisma, null, null, new NotificationService(prisma, null));

        const flagged = await worker._flagForManualReview(withdrawal, 'DISPATCH_IDENTITY_UNKNOWN', { referenceId: 'test-ref' });
        expect(flagged).toBe(true);

        const after = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(after.status).toBe('NEEDS_MANUAL_REVIEW');

        const notifs = await prisma.notification.findMany({ where: { userId: user.id } });
        expect(notifs).toHaveLength(1);
        const n = notifs[0];
        expect(n.title).toBe('Withdrawal Under Review');
        expect(n.body).toContain('reviewed by our team');
        expect(n.category).toBe('GENERAL');
        expect(n.actionPayload).toMatchObject({
            action: 'WITHDRAWAL_STATUS',
            type: 'WITHDRAWAL_REVIEW',
            withdrawalId: String(withdrawal.id),
            status: 'NEEDS_MANUAL_REVIEW',
        });
    });
});
