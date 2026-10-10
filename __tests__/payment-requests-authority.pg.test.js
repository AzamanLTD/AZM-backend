'use strict';

// =============================================================================
// STANDALONE PAYMENT REQUESTS — authority proofs (real PostgreSQL).
//
// Proves the request-resource lifecycle contracts on the REAL middleware +
// REAL controllers over real HTTP, in the financial-durability lane
// (production commit mode):
//
//   PR1. Concurrent duplicate create (same Idempotency-Key, same payload):
//        exactly ONE PaymentRequest row is created; the loser is refused
//        (409 IN_PROGRESS) or replays the committed result — never a second
//        row, never a second notification.
//   PR2. Committed replay is byte-identical: same key + same payload returns
//        the stored wire bytes; the economic mutation happens exactly once.
//   PR3. Divergent payload under the same key: deterministic 409
//        IDEMPOTENCY_PAYLOAD_CONFLICT before any economics; one row.
//   PR4. Concurrent cancel-vs-decline (requester cancels while recipient
//        declines): exactly ONE terminal transition wins (single-winner
//        conditional update); the final status is exactly one of
//        CANCELLED/DECLINED, never both, never PENDING; the loser reports
//        the committed state honestly.
//   PR5. Concurrent double-cancel (and double-decline): one 200, one 409;
//        resolvedAt is set once.
//   PR6. Server-enforced expiry: an expired request cannot be cancelled or
//        declined (409 PAYMENT_REQUEST_EXPIRED); the public link returns 410;
//        lists project EXPIRED — never left to the UI.
//   PR7. Token privacy: the raw LINK token appears in NO PaymentRequest
//        column (only its sha256 hash is stored); a wrong token 404s; the
//        share URL is minted from the validated PUBLIC_APP_URL origin only.
//   PR8. Authorization isolation: a stranger can neither cancel nor decline;
//        the requester cannot decline their own request; the recipient
//        cannot cancel; LINK requests cannot be declined by anyone.
//   PR9. No chat contamination: no PeerTransfer row and no DirectMessage is
//        ever created by the standalone path.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('payment-requests — authority (PostgreSQL)', () => {
    let prisma;
    let app;
    let requester, recipient, stranger;
    const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET);

    const EP = {
        create: 'POST /api/payment-requests',
        cancel: 'POST /api/payment-requests/:id/cancel',
        decline: 'POST /api/payment-requests/:id/decline',
    };
    const userFilter = () => ({ OR: [{ requesterId: { in: [requester.id, recipient.id, stranger.id] } }, { recipientId: { in: [requester.id, recipient.id, stranger.id] } }] });
    // Sweeps BEFORE seeding can only clear claims (no ids yet); after
    // seeding, both claims and rows.
    const sweep = () => Promise.all([
        prisma.financialOperation.deleteMany({ where: { endpoint: { in: Object.values(EP) } } }).catch(() => {}),
        requester ? prisma.paymentRequest.deleteMany({ where: userFilter() }).catch(() => {}) : Promise.resolve(),
    ]);

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        // Server-issued share URLs require a validated canonical origin.
        process.env.PUBLIC_APP_URL = 'https://app.azaman.test';
        prisma = new PrismaClient();
        await sweep();
        const { seedUser, seedFriendship } = require('./helpers/factories');
        // Unique-per-run ids: the disposable test DB is shared across local
        // re-runs, and fixed usernames would collide with the previous run.
        const run = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        requester = await seedUser(prisma, { username: `prq_a_${run}`, email: `prq_a_${run}@test.com` });
        recipient = await seedUser(prisma, { username: `prq_b_${run}`, email: `prq_b_${run}@test.com` });
        stranger = await seedUser(prisma, { username: `prq_c_${run}`, email: `prq_c_${run}@test.com` });
        await seedFriendship(prisma, requester.id, recipient.id, 'ACCEPTED');
        app = require('../server');
    }, 60000);

    afterEach(async () => { await sweep(); });

    afterAll(async () => {
        await sweep();
        await prisma.$disconnect();
    });

    const postCreate = (token, body, key) =>
        request(app).post('/api/payment-requests')
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key)
            .send(body);
    const postAction = (path, token, key) =>
        request(app).post(path)
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key)
            .send({});

    // ── PR1 + PR2: exactly-once create, byte-identical replay ──────────────
    test('PR1/PR2: concurrent duplicate create → one row; replay is byte-identical and never re-notifies', async () => {
        const body = { amount: '25.50', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) };
        const key = 'pr-auth-create-1';

        const [a, b] = await Promise.allSettled([
            postCreate(tokenFor(requester), body, key),
            postCreate(tokenFor(requester), body, key),
        ]);
        const resA = a.value; const resB = b.value;
        const ok = [resA, resB].filter(r => r.statusCode === 201);
        expect(ok.length).toBe(1);
        const refused = [resA, resB].filter(r => r.statusCode !== 201);
        expect(refused.map(r => r.statusCode)).toEqual([409]);
        expect(refused[0].body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

        const rows = await prisma.paymentRequest.findMany({ where: { requesterId: requester.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].amountExact).toBe('25.50');
        expect(rows[0].status).toBe('PENDING');

        // Exactly one notification for the recipient (DIRECT notify-once).
        const notes = await prisma.notification.findMany({ where: { userId: recipient.id, category: 'MONEY' } });
        expect(notes).toHaveLength(1);

        // Committed replay: byte-identical wire bytes, still one row + one note.
        const replay = await postCreate(tokenFor(requester), body, key);
        expect(replay.status).toBe(201);
        expect(replay.text).toBe(ok[0].text);
        expect(await prisma.paymentRequest.count({ where: { requesterId: requester.id } })).toBe(1);
        expect(await prisma.notification.count({ where: { userId: recipient.id, category: 'MONEY' } })).toBe(1);
    });

    // ── PR3: divergent payload under the same key ───────────────────────────
    test('PR3: same key + materially different payload → 409 IDEMPOTENCY_PAYLOAD_CONFLICT, one row', async () => {
        const t = tokenFor(requester);
        const first = await postCreate(t, { amount: '10.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-diverge');
        expect(first.status).toBe(201);

        const second = await postCreate(t, { amount: '99.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-diverge');
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');

        const rows = await prisma.paymentRequest.findMany({ where: { requesterId: requester.id, amountExact: { in: ['10.00', '99.00'] } } });
        expect(rows).toHaveLength(1);
        expect(rows[0].amountExact).toBe('10.00');
    });

    // ── PR4: concurrent cancel-vs-decline → exactly one terminal winner ─────
    test('PR4: concurrent cancel-vs-decline → single terminal winner, honest loser', async () => {
        const created = await postCreate(tokenFor(requester), { amount: '15.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-race');
        expect(created.status).toBe(201);
        const id = created.body.data.request.id;

        const [cancelRes, declineRes] = await Promise.allSettled([
            postAction(`/api/payment-requests/${id}/cancel`, tokenFor(requester), 'pr-auth-cancel-race'),
            postAction(`/api/payment-requests/${id}/decline`, tokenFor(recipient), 'pr-auth-decline-race'),
        ]);
        const codes = [cancelRes.value.statusCode, declineRes.value.statusCode].sort();
        expect(codes).toEqual([200, 409]);

        const row = await prisma.paymentRequest.findUnique({ where: { id } });
        expect(['CANCELLED', 'DECLINED']).toContain(row.status);
        expect(row.status).not.toBe('PENDING');
        expect(row.resolvedAt).not.toBeNull();

        // The loser reports the COMMITTED state honestly — never a guess.
        const loser = cancelRes.value.statusCode === 200 ? declineRes.value : cancelRes.value;
        expect(loser.body.code).toBe('PAYMENT_REQUEST_ALREADY_RESOLVED');
        expect(loser.body.message).toContain(row.status);

        // Replay of the winning action replays its committed result; the row
        // never transitions twice.
        const winner = cancelRes.value.statusCode === 200 ? cancelRes.value : declineRes.value;
        const winnerIsCancel = cancelRes.value.statusCode === 200;
        const replay = await postAction(
            `/api/payment-requests/${id}/${winnerIsCancel ? 'cancel' : 'decline'}`,
            winnerIsCancel ? tokenFor(requester) : tokenFor(recipient),
            winnerIsCancel ? 'pr-auth-cancel-race' : 'pr-auth-decline-race',
        );
        expect(replay.status).toBe(200);
        expect(replay.text).toBe(winner.text);
        expect((await prisma.paymentRequest.findUnique({ where: { id } })).status).toBe(row.status);
    });

    // ── PR5: concurrent double-cancel / double-decline ──────────────────────
    test('PR5: concurrent double-cancel → one 200, one 409, resolvedAt set once', async () => {
        const created = await postCreate(tokenFor(requester), { amount: '5.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-dbl-1');
        const id = created.body.data.request.id;
        const t = tokenFor(requester);

        const [a, b] = await Promise.allSettled([
            postAction(`/api/payment-requests/${id}/cancel`, t, 'pr-auth-dbl-cancel-a'),
            postAction(`/api/payment-requests/${id}/cancel`, t, 'pr-auth-dbl-cancel-b'),
        ]);
        const codes = [a.value.statusCode, b.value.statusCode].sort();
        expect(codes).toEqual([200, 409]);

        const row = await prisma.paymentRequest.findUnique({ where: { id } });
        expect(row.status).toBe('CANCELLED');
        expect(row.resolvedAt).not.toBeNull();

        // Same proof for decline.
        const created2 = await postCreate(t, { amount: '6.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-dbl-2');
        const id2 = created2.body.data.request.id;
        const [c, d] = await Promise.allSettled([
            postAction(`/api/payment-requests/${id2}/decline`, tokenFor(recipient), 'pr-auth-dbl-dec-a'),
            postAction(`/api/payment-requests/${id2}/decline`, tokenFor(recipient), 'pr-auth-dbl-dec-b'),
        ]);
        expect([c.value.statusCode, d.value.statusCode].sort()).toEqual([200, 409]);
        expect((await prisma.paymentRequest.findUnique({ where: { id: id2 } })).status).toBe('DECLINED');
    });

    // ── PR6: server-enforced expiry ─────────────────────────────────────────
    test('PR6: expired request: transitions refuse, public link 410, list projects EXPIRED', async () => {
        const created = await postCreate(tokenFor(requester), { amount: '7.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-exp-1');
        const id = created.body.data.request.id;

        // Move the clock boundary directly (no API path can create an expired
        // row — the server owns expiry): simulate time passing.
        await prisma.paymentRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });

        const cancelRes = await postAction(`/api/payment-requests/${id}/cancel`, tokenFor(requester), 'pr-auth-exp-cancel');
        expect(cancelRes.status).toBe(409);
        expect(cancelRes.body.code).toBe('PAYMENT_REQUEST_EXPIRED');

        const declineRes = await postAction(`/api/payment-requests/${id}/decline`, tokenFor(recipient), 'pr-auth-exp-decline');
        expect(declineRes.status).toBe(409);
        expect(declineRes.body.code).toBe('PAYMENT_REQUEST_EXPIRED');

        const listRes = await request(app).get('/api/payment-requests?direction=OUTGOING')
            .set('Authorization', `Bearer ${tokenFor(requester)}`);
        const mine = listRes.body.data.requests.find(r => r.id === id);
        expect(mine).toBeDefined();
        expect(mine.status).toBe('EXPIRED');

        // LINK variant: the public endpoint must be dead for expired links.
        const link = await postCreate(tokenFor(requester), { amount: '3.00', currency: 'GHS', requestMode: 'LINK' }, 'pr-auth-exp-2');
        const token = link.body.data.request.shareUrl.split('/request/')[1];
        await prisma.paymentRequest.update({
            where: { tokenHash: require('crypto').createHash('sha256').update(token, 'utf8').digest('hex') },
            data: { expiresAt: new Date(Date.now() - 1000) },
        });
        const pub = await request(app).get(`/api/payment-requests/public/${token}`);
        expect(pub.status).toBe(410);
        expect(pub.body.code).toBe('PAYMENT_REQUEST_EXPIRED');
    });

    // ── PR7: token privacy + validated-origin share URL ─────────────────────
    test('PR7: raw token stored nowhere; only its sha256 hash; wrong token 404s; canonical origin only', async () => {
        const link = await postCreate(tokenFor(requester), { amount: '12.50', currency: 'GHS', requestMode: 'LINK' }, 'pr-auth-token');
        expect(link.status).toBe(201);
        const shareUrl = link.body.data.request.shareUrl;
        expect(shareUrl.startsWith('https://app.azaman.test/request/')).toBe(true);

        const token = shareUrl.split('/request/')[1];
        expect(token.length).toBeGreaterThanOrEqual(32);

        // Prove NO PaymentRequest column contains the raw token.
        const rows = await prisma.$queryRaw`SELECT * FROM "PaymentRequest" WHERE "requesterId" = ${requester.id} AND "mode" = 'LINK'`;
        expect(rows).toHaveLength(1);
        for (const [col, value] of Object.entries(rows[0])) {
            if (typeof value === 'string') {
                expect(value).not.toContain(token);
            }
        }
        const hash = require('crypto').createHash('sha256').update(token, 'utf8').digest('hex');
        expect(rows[0].tokenHash).toBe(hash);
        expect(rows[0].tokenHash).not.toBe(token);

        // Correct token resolves; wrong token does not.
        const ok = await request(app).get(`/api/payment-requests/public/${token}`);
        expect(ok.status).toBe(200);
        expect(ok.body.data.request.amount).toBe('12.50');
        const wrong = await request(app).get(`/api/payment-requests/public/${token.slice(0, -1)}X`);
        expect(wrong.status).toBe(404);
        expect(wrong.body.code).toBe('PAYMENT_REQUEST_NOT_FOUND');
    });

    // ── PR8: authorization isolation ────────────────────────────────────────
    test('PR8: stranger/recipient/requester authorization matrix', async () => {
        const created = await postCreate(tokenFor(requester), { amount: '8.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-iso');
        const id = created.body.data.request.id;

        expect((await postAction(`/api/payment-requests/${id}/cancel`, tokenFor(stranger), 'pr-iso-1')).status).toBe(403);
        expect((await postAction(`/api/payment-requests/${id}/decline`, tokenFor(stranger), 'pr-iso-2')).status).toBe(403);
        expect((await postAction(`/api/payment-requests/${id}/cancel`, tokenFor(recipient), 'pr-iso-3')).status).toBe(403);
        expect((await postAction(`/api/payment-requests/${id}/decline`, tokenFor(requester), 'pr-iso-4')).status).toBe(403);

        // LINK requests: no recipient exists to decline — everyone is refused.
        const link = await postCreate(tokenFor(requester), { amount: '9.00', currency: 'GHS', requestMode: 'LINK' }, 'pr-auth-iso-2');
        const linkId = link.body.data.request.id;
        expect((await postAction(`/api/payment-requests/${linkId}/decline`, tokenFor(recipient), 'pr-iso-5')).status).toBe(403);
        expect((await postAction(`/api/payment-requests/${linkId}/decline`, tokenFor(stranger), 'pr-iso-6')).status).toBe(403);

        // List isolation: the stranger sees nothing in either direction.
        for (const direction of ['INCOMING', 'OUTGOING']) {
            const res = await request(app).get(`/api/payment-requests?direction=${direction}`)
                .set('Authorization', `Bearer ${tokenFor(stranger)}`);
            expect(res.body.data.requests).toHaveLength(0);
        }
    });

    // ── PR9: no chat contamination ─────────────────────────────────────────
    test('PR9: the standalone path never creates PeerTransfer or DirectMessage rows', async () => {
        const ptBefore = await prisma.peerTransfer.count();
        const dmBefore = await prisma.directMessage.count();

        const created = await postCreate(tokenFor(requester), { amount: '4.00', currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) }, 'pr-auth-chat');
        const id = created.body.data.request.id;
        await postAction(`/api/payment-requests/${id}/cancel`, tokenFor(requester), 'pr-auth-chat-cancel');
        await postCreate(tokenFor(requester), { amount: '2.00', currency: 'GHS', requestMode: 'LINK' }, 'pr-auth-chat-2');

        expect(await prisma.peerTransfer.count()).toBe(ptBefore);
        expect(await prisma.directMessage.count()).toBe(dmBefore);
    });
});
