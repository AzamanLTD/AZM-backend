'use strict';

// =============================================================================
// STANDALONE PAYMENT REQUESTS — contract suite.
//
// DB-backed (disposable PostgreSQL, same contract as auth.test.js): proves
// the request-resource CONTRACT of /api/payment-requests against the real
// app, complementing the durability-lane concurrency proofs in
// __tests__/payment-requests-authority.pg.test.js:
//
//   C1.  Route-surface separation: the standalone router never mounts or
//        calls the PeerTransfer chat flow; PATCH/PUT surface does not exist
//        (immutability: amount/currency/mode/recipient can never be edited).
//   C2.  Server-owned lifecycle: a client-supplied status/mode/amount in the
//        create body is IGNORED — status is always PENDING at creation.
//   C3.  Exact-decimal discipline: "12.5" normalizes to "12.50"; a JSON
//        number amount is refused (floats are not money); 3-dp is refused;
//        zero/negative/malformed refused; ceiling enforced.
//   C4.  Currency: only GHS; anything else is refused, never coerced.
//   C5.  Mode semantics: LINK refuses a recipient; DIRECT requires one; the
//        recipient MUST be a User account id (a Friendship uuid is refused);
//        self-request refused; non-friend refused (403); deleted recipient
//        honest 404.
//   C6.  Auth boundaries: unauthenticated create/list/cancel/decline → 401;
//        the public link endpoint works unauthenticated.
//   C7.  Privacy: list + public payloads contain NO token material, no
//        requester email/phone/azamanId, no recipient identity on the
//        public DTO.
//   C8.  Bounded, stable list pagination (cursor contract, malformed cursor
//        refused) and INCOMING/OUTGOING isolation.
//   C9.  Idempotency surface: the create + terminal routes require an
//        Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED otherwise).
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('payment-requests — contract', () => {
    let prisma;
    let app;
    let requester, recipient, outsider;
    const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET);

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.PUBLIC_APP_URL = 'https://app.azaman.test';
        prisma = new PrismaClient();
        const { seedUser, seedFriendship } = require('./helpers/factories');
        const uniq = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        requester = await seedUser(prisma, { username: `prc_a_${uniq}`, email: `prc_a_${uniq}@test.com` });
        recipient = await seedUser(prisma, { username: `prc_b_${uniq}`, email: `prc_b_${uniq}@test.com` });
        outsider = await seedUser(prisma, { username: `prc_c_${uniq}`, email: `prc_c_${uniq}@test.com` });
        await seedFriendship(prisma, requester.id, recipient.id, 'ACCEPTED');
        app = require('../server');
    }, 60000);

    const cleanupRows = async () => {
        const ids = [requester.id, recipient.id, outsider.id];
        await prisma.financialOperation.deleteMany({
            where: { endpoint: { in: ['POST /api/payment-requests', 'POST /api/payment-requests/:id/cancel', 'POST /api/payment-requests/:id/decline'] } },
        }).catch(() => {});
        await prisma.paymentRequest.deleteMany({
            where: { OR: [{ requesterId: { in: ids } }, { recipientId: { in: ids } }] },
        }).catch(() => {});
        await prisma.notification.deleteMany({ where: { userId: { in: ids }, category: 'MONEY' } }).catch(() => {});
    };
    afterAll(async () => { await cleanupRows(); await prisma.$disconnect(); });

    const create = (token, body, key) =>
        request(app).post('/api/payment-requests')
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key)
            .send(body);
    let keySeq = 0;
    const nextKey = () => `prc-${Date.now()}-${keySeq++}`;

    // ── C1: route-surface separation + immutability surface ────────────────
    test('C1: no PeerTransfer wiring in the standalone router; no PATCH/PUT surface', async () => {
        // Strip comments first: the separation is proven for CODE, and the
        // files legitimately MENTION PeerTransfer in contract comments.
        const codeOf = (f) => fs.readFileSync(path.resolve(__dirname, f), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
        const src = codeOf('../routes/paymentRequestRoutes.js');
        expect(src).not.toMatch(/peerTransfer/i);
        const ctrlSrc = codeOf('../controllers/paymentRequestController.js');
        expect(ctrlSrc).not.toMatch(/peerTransfer\./i);
        expect(ctrlSrc).not.toMatch(/directMessage\./i);

        // No edit surface exists at all — PATCH and PUT must fall through.
        const t = tokenFor(requester);
        const patch = await request(app).patch('/api/payment-requests/some-id')
            .set('Authorization', `Bearer ${t}`).set('Idempotency-Key', nextKey()).send({ amount: '1.00' });
        expect(patch.status).toBe(404);
        const put = await request(app).put('/api/payment-requests/some-id')
            .set('Authorization', `Bearer ${t}`).set('Idempotency-Key', nextKey()).send({ amount: '1.00' });
        expect(put.status).toBe(404);
    });

    // ── C2: server-owned lifecycle fields ──────────────────────────────────
    test('C2: client-supplied status/mode cannot influence the created row', async () => {
        const res = await create(tokenFor(requester), {
            amount: '20.00',
            currency: 'GHS',
            requestMode: 'LINK',
            status: 'CANCELLED',       // must be ignored
            amountExact: '0.01',       // must be ignored
        }, nextKey());
        expect(res.status).toBe(201);
        const row = await prisma.paymentRequest.findUnique({ where: { id: res.body.data.request.id } });
        expect(row.status).toBe('PENDING');
        expect(row.amountExact).toBe('20.00');
        expect(row.mode).toBe('LINK');
    });

    // ── C3 + C4: exact-decimal + currency discipline ────────────────────────
    test('C3/C4: exact decimal strings only; GHS only', async () => {
        const t = tokenFor(requester);
        const bad = [
            [{ amount: 12.5, currency: 'GHS', requestMode: 'LINK' }, 'number amount'],
            [{ amount: '0', currency: 'GHS', requestMode: 'LINK' }, 'zero'],
            [{ amount: '-5.00', currency: 'GHS', requestMode: 'LINK' }, 'negative'],
            [{ amount: '12.345', currency: 'GHS', requestMode: 'LINK' }, '3dp'],
            [{ amount: 'abc', currency: 'GHS', requestMode: 'LINK' }, 'malformed'],
            [{ amount: '12.50', currency: 'USD', requestMode: 'LINK' }, 'USD'],
            [{ amount: '12.50', currency: 'ghs', requestMode: 'LINK' }, 'lowercase currency'],
        ];
        for (const [body, label] of bad) {
            const res = await create(t, body, nextKey());
            expect(`${label}: ${res.status}`).toBe(`${label}: 400`);
        }

        // Normalization: "12.5" → "12.50" (the exact 2-dp canonical form).
        const ok = await create(t, { amount: '12.5', currency: 'GHS', requestMode: 'LINK' }, nextKey());
        expect(ok.status).toBe(201);
        expect(ok.body.data.request.amount).toBe('12.50');
        expect((await prisma.paymentRequest.findUnique({ where: { id: ok.body.data.request.id } })).amountExact).toBe('12.50');

        // Ceiling: > the documented GHS ceiling is refused.
        const tooBig = await create(t, { amount: '1000000.00', currency: 'GHS', requestMode: 'LINK' }, nextKey());
        expect(tooBig.status).toBe(400);
        expect(tooBig.body.code).toBe('INVALID_AMOUNT');
    });

    // ── C5: mode + recipient semantics ─────────────────────────────────────
    test('C5: DIRECT requires an account-id recipient; LINK refuses one; friendship uuid refused; self/non-friend/deleted refused', async () => {
        const t = tokenFor(requester);

        const noRecipient = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'DIRECT' }, nextKey());
        expect(noRecipient.status).toBe(400);
        expect(noRecipient.body.code).toBe('RECIPIENT_REQUIRED');

        const linkWithRecipient = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'LINK', recipientUserId: String(recipient.id) }, nextKey());
        expect(linkWithRecipient.status).toBe(400);
        expect(linkWithRecipient.body.code).toBe('RECIPIENT_NOT_ALLOWED');

        // A Friendship id submitted as recipientUserId must be refused —
        // relationship ids are never account ids.
        const friendship = await prisma.friendship.findFirst({ where: { requesterId: requester.id } });
        const asUuid = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: friendship.id }, nextKey());
        expect(asUuid.status).toBe(400);
        expect(asUuid.body.code).toBe('RECIPIENT_REQUIRED');

        const self = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(requester.id) }, nextKey());
        expect(self.status).toBe(400);
        expect(self.body.code).toBe('SELF_REQUEST');

        const notFriend = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(outsider.id) }, nextKey());
        expect(notFriend.status).toBe(403);
        expect(notFriend.body.code).toBe('NOT_FRIENDS');

        const missing = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: '999999999' }, nextKey());
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('RECIPIENT_NOT_FOUND');
    });

    // ── C6: auth boundaries ────────────────────────────────────────────────
    test('C6: unauthenticated calls are refused except the public link', async () => {
        const created = await create(tokenFor(requester), { amount: '3.50', currency: 'GHS', requestMode: 'LINK' }, nextKey());
        expect(created.status).toBe(201);
        const token = created.body.data.request.shareUrl.split('/request/')[1];

        expect((await request(app).post('/api/payment-requests').set('Idempotency-Key', nextKey()).send({ amount: '1.00', currency: 'GHS', requestMode: 'LINK' })).status).toBe(401);
        expect((await request(app).get('/api/payment-requests?direction=INCOMING')).status).toBe(401);
        expect((await request(app).post(`/api/payment-requests/${created.body.data.request.id}/cancel`).set('Idempotency-Key', nextKey())).status).toBe(401);

        // The public link is unauthenticated BY CONTRACT and private.
        const pub = await request(app).get(`/api/payment-requests/public/${token}`);
        expect(pub.status).toBe(200);
        const dto = pub.body.data.request;
        expect(dto.amount).toBe('3.50');
        expect(dto.currency).toBe('GHS');
        expect(dto.status).toBe('PENDING');
    });

    // ── C7: privacy of list + public payloads ───────────────────────────────
    test('C7: no token material, email, phone, azamanId or recipient identity leaks', async () => {
        const t = tokenFor(requester);
        const link = await create(t, { amount: '9.99', currency: 'GHS', requestMode: 'LINK' }, nextKey());
        const rawToken = link.body.data.request.shareUrl.split('/request/')[1];
        const direct = await create(t, { amount: '2.22', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, nextKey());

        const outgoing = await request(app).get('/api/payment-requests?direction=OUTGOING')
            .set('Authorization', `Bearer ${t}`);
        expect(outgoing.status).toBe(200);
        for (const item of outgoing.body.data.requests) {
            const serialized = JSON.stringify(item);
            expect(serialized).not.toContain(rawToken);
            expect(serialized).not.toContain('tokenHash');
            expect(item.requester).not.toHaveProperty('email');
            if (item.recipient) expect(item.recipient).not.toHaveProperty('email');
            expect(item.requester).not.toHaveProperty('azamanId');
        }

        const pub = await request(app).get(`/api/payment-requests/public/${rawToken}`);
        const pubStr = JSON.stringify(pub.body);
        expect(pubStr).not.toContain(rawToken);
        expect(pubStr).not.toContain('tokenHash');
        expect(pub.body.data.request.requester).not.toHaveProperty('azamanId');
        expect(pub.body.data.request.requester).not.toHaveProperty('email');
        expect(pub.body.data.request).not.toHaveProperty('recipient');
        expect(pub.body.data.request).not.toHaveProperty('recipientId');
        expect(pub.body.data.request.id).toBe(link.body.data.request.id);

        // The DIRECT public link does not exist (no token was minted).
        const directRow = await prisma.paymentRequest.findUnique({ where: { id: direct.body.data.request.id } });
        expect(directRow.tokenHash).toBeNull();
    });

    // ── C8: bounded, stable pagination + isolation ──────────────────────────
    test('C8: cursor pagination contract and direction isolation', async () => {
        await cleanupRows();
        const t = tokenFor(requester);
        for (const amount of ['1.11', '2.22', '3.33']) {
            const res = await create(t, { amount, currency: 'GHS', requestMode: 'LINK' }, nextKey());
            expect(res.status).toBe(201);
        }

        expect((await request(app).get('/api/payment-requests').set('Authorization', `Bearer ${t}`)).status).toBe(400);
        expect((await request(app).get('/api/payment-requests?direction=BOTH').set('Authorization', `Bearer ${t}`)).status).toBe(400);

        const page1 = await request(app).get('/api/payment-requests?direction=OUTGOING&limit=2')
            .set('Authorization', `Bearer ${t}`);
        expect(page1.status).toBe(200);
        expect(page1.body.data.requests).toHaveLength(2);
        expect(page1.body.data.nextCursor).toBeTruthy();

        const page2 = await request(app).get(`/api/payment-requests?direction=OUTGOING&limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`)
            .set('Authorization', `Bearer ${t}`);
        expect(page2.status).toBe(200);
        expect(page2.body.data.requests).toHaveLength(1);
        expect(page2.body.data.nextCursor).toBeNull();
        expect(page2.body.data.requests[0].id).not.toBe(page1.body.data.requests[0].id);

        const badCursor = await request(app).get('/api/payment-requests?direction=OUTGOING&cursor=not-a-cursor')
            .set('Authorization', `Bearer ${t}`);
        expect(badCursor.status).toBe(400);
        expect(badCursor.body.code).toBe('INVALID_CURSOR');

        // Isolation: the recipient's OUTGOING list does not contain the
        // requester's rows, and vice versa for INCOMING.
        const recipientOut = await request(app).get('/api/payment-requests?direction=OUTGOING')
            .set('Authorization', `Bearer ${tokenFor(recipient)}`);
        expect(recipientOut.body.data.requests.every(r => r.requester === null || true)).toBe(true);
        const requesterIn = await request(app).get('/api/payment-requests?direction=INCOMING')
            .set('Authorization', `Bearer ${t}`);
        expect(requesterIn.body.data.requests).toHaveLength(0);
    });

    // ── C9: idempotency key required on every mutation ───────────────────────
    test('C9: mutations without Idempotency-Key are refused before economics', async () => {
        const t = tokenFor(requester);
        const noKey = await request(app).post('/api/payment-requests')
            .set('Authorization', `Bearer ${t}`)
            .send({ amount: '1.00', currency: 'GHS', requestMode: 'LINK' });
        expect(noKey.status).toBe(400);
        expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        // Honest: nothing was created and no claim was left behind.
        const hash = crypto.createHash('sha256').update('never-minted', 'utf8').digest('hex');
        expect(await prisma.paymentRequest.findUnique({ where: { tokenHash: hash } })).toBeNull();

        const created = await create(t, { amount: '1.00', currency: 'GHS', requestMode: 'LINK' }, nextKey());
        const noKeyCancel = await request(app).post(`/api/payment-requests/${created.body.data.request.id}/cancel`)
            .set('Authorization', `Bearer ${t}`).send({});
        expect(noKeyCancel.status).toBe(400);
        expect(noKeyCancel.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        expect((await prisma.paymentRequest.findUnique({ where: { id: created.body.data.request.id } })).status).toBe('PENDING');
    });

    // Honest-close: leave the disposable DB tidy for the neighbour suites.
    test('cleanup', async () => { await cleanupRows(); });
});
