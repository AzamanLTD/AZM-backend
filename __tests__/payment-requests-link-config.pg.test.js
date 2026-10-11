'use strict';

// =============================================================================
// STANDALONE PAYMENT REQUESTS — LINK configuration fail-closed regression.
//
// DB-backed (disposable PostgreSQL). Proves the retry-safety repair
// reviewed by Luis (2026-10-11): the pre-claim guard must validate ALL
// required LINK configuration (share-token key AND canonical origin),
// because a post-claim 5xx refusal retains an IN_PROGRESS claim under
// releaseOn4xx and poisons the same-key retry:
//
//   C1. With a usable ENCRYPTION_KEY but PUBLIC_APP_URL absent, a LINK
//       create refuses 503 PUBLIC_APP_URL_UNCONFIGURED BEFORE the
//       idempotency claim: no PaymentRequest row, NO FinancialOperation
//       claim for the key (not even IN_PROGRESS). After configuration is
//       restored, the SAME key and SAME payload succeeds exactly once
//       (one row, claim COMMITTED) — no poisoned conflict, no duplicate.
//   C2. An INVALID PUBLIC_APP_URL (not a bare origin) fails closed the same
//       way, and the same key then succeeds exactly once after the fix.
//   C3. Replay exemption: a previously committed LINK create replays its
//       ORIGINAL response (byte-identical, matching status) even when
//       PUBLIC_APP_URL later becomes unavailable — missing configuration
//       never blocks a committed replay.
//   C4. DIRECT requests are unaffected by PUBLIC_APP_URL: they need no
//       share URL, so they create and replay normally while LINK is
//       refused.
//
// The at-rest protections (raw token never persisted, envelope in the
// replay bytes) and the §r42 single-claim semantics are covered by
// payment-requests-link-at-rest.test.js and payment-requests-authority.pg.test.js.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('payment-requests — LINK configuration fail-closed (pre-claim)', () => {
    let prisma;
    let app;
    let requester, recipient;
    const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET);
    // §r42 canonicalizes the mount pattern WITH a trailing slash — the
    // stored endpoint string is exactly what the middleware persists.
    const EP_CREATE = 'POST /api/payment-requests/';

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.PUBLIC_APP_URL = 'https://app.azaman.test';
        process.env.ENCRYPTION_KEY = '3f9a2c8e1d4b6a0f7e5c3d2b1a098877665544332211ffeeddccbbaa99887766';
        prisma = new PrismaClient();
        const { seedUser, seedFriendship } = require('./helpers/factories');
        const uniq = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        requester = await seedUser(prisma, { username: `plc_a_${uniq}`, email: `plc_a_${uniq}@test.com`, azamanId: `AZM-PLC-${uniq}-a` });
        recipient = await seedUser(prisma, { username: `plc_b_${uniq}`, email: `plc_b_${uniq}@test.com`, azamanId: `AZM-PLC-${uniq}-b` });
        await seedFriendship(prisma, requester.id, recipient.id, 'ACCEPTED');
        app = require('../server');
    }, 60000);

    afterAll(async () => {
        await prisma.financialOperation.deleteMany({ where: { endpoint: EP_CREATE, userId: requester.id } }).catch(() => {});
        await prisma.paymentRequest.deleteMany({ where: { requesterId: requester.id } }).catch(() => {});
        await prisma.$disconnect();
    });

    const postCreate = (token, body, key) =>
        request(app).post('/api/payment-requests')
            .set('Authorization', `Bearer ${token}`)
            .set('Idempotency-Key', key)
            .send(body);

    const linkBody = (amount) => ({ amount, currency: 'GHS', requestMode: 'LINK' });
    const directBody = (amount) => ({ amount, currency: 'GHS', requestMode: 'DIRECT', recipientUserId: String(recipient.id) });

    /** Durable-state probe: rows for this requester + claims for one key. */
    const stateFor = async (key) => ({
        rows: await prisma.paymentRequest.count({ where: { requesterId: requester.id } }),
        claims: await prisma.financialOperation.findMany({
            where: { endpoint: EP_CREATE, key, userId: requester.id },
            select: { status: true },
        }),
    });

    // ── C1: absent PUBLIC_APP_URL → pre-claim refusal; clean retry ───────
    test('C1: absent PUBLIC_APP_URL → 503 pre-claim (no row, NO claim residue); same key succeeds exactly once after restore', async () => {
        const savedUrl = process.env.PUBLIC_APP_URL;
        const key = 'plc-c1';
        const body = linkBody('12.50');
        delete process.env.PUBLIC_APP_URL;
        try {
            const before = await stateFor(key);
            const refused = await postCreate(tokenFor(requester), body, key);
            expect(refused.status).toBe(503);
            expect(refused.body.code).toBe('PUBLIC_APP_URL_UNCONFIGURED');
            expect(refused.body.success).toBe(false);
            // Nothing was created — and, the point of the repair, the
            // failure left NO idempotency claim in ANY state (a 5xx refusal
            // under releaseOn4xx would otherwise retain IN_PROGRESS and
            // poison the same-key retry).
            const after = await stateFor(key);
            expect(after.rows).toBe(before.rows);
            expect(after.claims).toHaveLength(0);
        } finally {
            process.env.PUBLIC_APP_URL = savedUrl;
        }

        // Configuration restored: the SAME key and SAME payload succeed
        // exactly once — no poisoned in-progress conflict.
        const ok = await postCreate(tokenFor(requester), body, key);
        expect(ok.status).toBe(201);
        expect(ok.body.data.request.shareUrl.startsWith('https://app.azaman.test/request/encu1.')).toBe(true);

        const created = await stateFor(key);
        expect(created.rows).toBe(1);
        expect(created.claims).toHaveLength(1);
        expect(created.claims[0].status).toBe('COMMITTED');

        // Byte-identical replay (the §r42 contract is untouched).
        const replay = await postCreate(tokenFor(requester), body, key);
        expect(replay.status).toBe(201);
        expect(replay.text).toBe(ok.text);

        const settled = await stateFor(key);
        expect(settled.rows).toBe(1); // exactly once — no duplicate row
        expect(settled.claims).toHaveLength(1);
    });

    // ── C2: invalid PUBLIC_APP_URL → same fail-closed contract ──────────
    test('C2: invalid PUBLIC_APP_URL (not a bare origin) → 503 pre-claim, no residue; same key succeeds once after fix', async () => {
        const savedUrl = process.env.PUBLIC_APP_URL;
        const key = 'plc-c2';
        const body = linkBody('8.00');
        process.env.PUBLIC_APP_URL = 'https://app.example.com/landing?x=1'; // path+query: not an origin
        try {
            const before = await stateFor(key);
            const refused = await postCreate(tokenFor(requester), body, key);
            expect(refused.status).toBe(503);
            expect(refused.body.code).toBe('PUBLIC_APP_URL_UNCONFIGURED');

            const after = await stateFor(key);
            expect(after.rows).toBe(before.rows);
            expect(after.claims).toHaveLength(0);
        } finally {
            process.env.PUBLIC_APP_URL = savedUrl;
        }

        const ok = await postCreate(tokenFor(requester), body, key);
        expect(ok.status).toBe(201);
        const created = await stateFor(key);
        expect(created.claims).toHaveLength(1);
        expect(created.claims[0].status).toBe('COMMITTED');
        // Exactly one row for this test's amount (C1's row remains, but no
        // duplicate was minted by the refused-then-retried sequence).
        const mine = await prisma.paymentRequest.count({ where: { requesterId: requester.id, amountExact: '8.00' } });
        expect(mine).toBe(1);
    });

    // ── C3: committed LINK replays even when configuration is gone ───────
    test('C3: committed LINK create replays its original response with PUBLIC_APP_URL unavailable — the replay exemption holds', async () => {
        const key = 'plc-c3';
        const body = linkBody('25.75');
        const first = await postCreate(tokenFor(requester), body, key);
        expect(first.status).toBe(201);
        const shareUrl = first.body.data.request.shareUrl;

        const savedUrl = process.env.PUBLIC_APP_URL;
        delete process.env.PUBLIC_APP_URL;
        try {
            const rowsBefore = await prisma.paymentRequest.count({ where: { requesterId: requester.id } });
            const replay = await postCreate(tokenFor(requester), body, key);
            expect(replay.status).toBe(201);
            expect(replay.text).toBe(first.text); // byte-identical original bytes
            expect(replay.body.data.request.shareUrl).toBe(shareUrl);
            expect(await prisma.paymentRequest.count({ where: { requesterId: requester.id } })).toBe(rowsBefore);
        } finally {
            process.env.PUBLIC_APP_URL = savedUrl;
        }
    });

    // ── C4: DIRECT requests unaffected by PUBLIC_APP_URL ─────────────────
    test('C4: DIRECT create and replay work normally while PUBLIC_APP_URL is absent (LINK-only requirement)', async () => {
        const savedUrl = process.env.PUBLIC_APP_URL;
        const key = 'plc-c4';
        const body = directBody('9.99');
        delete process.env.PUBLIC_APP_URL;
        try {
            const first = await postCreate(tokenFor(requester), body, key);
            expect(first.status).toBe(201);
            expect(first.body.data.request.shareUrl ?? null).toBeNull(); // no link material on DIRECT

            const claim = await prisma.financialOperation.findFirst({
                where: { endpoint: EP_CREATE, key, userId: requester.id },
                select: { status: true },
            });
            expect(claim?.status).toBe('COMMITTED');

            const replay = await postCreate(tokenFor(requester), body, key);
            expect(replay.status).toBe(201);
            expect(replay.text).toBe(first.text);
        } finally {
            process.env.PUBLIC_APP_URL = savedUrl;
        }
    });
});
