'use strict';

// =============================================================================
// STANDALONE PAYMENT REQUESTS — LINK share-token AT-REST security regression.
//
// DB-backed (disposable PostgreSQL). Proves the review-mandated persistence
// contract for LINK share tokens after the security repair:
//
//   L1. The create response's share URL carries the raw token ONLY inside an
//       AES-256-GCM envelope (encu1.…, services/crypto/shareToken.js, keyed
//       by ENCRYPTION_KEY via the audited fieldCipher service). The raw
//       token appears in NO unencrypted durable column: every string field
//       of the PaymentRequest row AND of the §r42 FinancialOperation claim
//       (including responseBody, the permanently persisted replay truth)
//       is scanned for it, and the claim's stored shareUrl is the envelope.
//   L2. A committed replay (same user + endpoint + Idempotency-Key + payload)
//       returns the ORIGINAL canonical share URL with matching status code
//       and byte-identical body, creates no second row, and sends no extra
//       notification — the §r42 exactly-once contract is untouched by the
//       encryption repair.
//   L3. Replay is crypto-independent: the persisted replay bytes are pure
//       ciphertext, so the stored response replays identically even with
//       the key removed (no reconstruction, no plaintext at rest, ever).
//   L4. Fail-closed on missing/corrupt key material, in EVERY environment:
//       without a usable ENCRYPTION_KEY, LINK create refuses 503 BEFORE the
//       idempotency claim (no claim residue, no request row) and public
//       link resolution refuses 503 (never a fake 404); a tampered envelope
//       fails AEAD authentication and is indistinguishable from an unknown
//       token (404, no oracle). No malformed link is ever served and no
//       second request is silently created.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('payment-requests — LINK token at-rest security', () => {
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
        requester = await seedUser(prisma, { username: `pra_a_${uniq}`, email: `pra_a_${uniq}@test.com`, azamanId: `AZM-PRA-${uniq}-a` });
        recipient = await seedUser(prisma, { username: `pra_b_${uniq}`, email: `pra_b_${uniq}@test.com`, azamanId: `AZM-PRA-${uniq}-b` });
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

    const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

    // ── L1: raw token in no unencrypted durable column ───────────────────
    test('L1: response share URL is an AEAD envelope; raw token absent from every unencrypted persisted field', async () => {
        const res = await postCreate(tokenFor(requester),
            { amount: '15.50', currency: 'GHS', requestMode: 'LINK' }, 'pr-at-rest-l1');
        expect(res.status).toBe(201);

        const shareUrl = res.body.data.request.shareUrl;
        expect(shareUrl.startsWith('https://app.azaman.test/request/encu1.')).toBe(true);
        const urlToken = shareUrl.split('/request/')[1];

        // Unwrap with the SAME key the server used → the raw token.
        const { unwrapShareToken, wrapShareToken } = require('../services/crypto/shareToken');
        const rawToken = unwrapShareToken(urlToken);
        expect(rawToken).toBeTruthy();
        expect(rawToken.length).toBeGreaterThanOrEqual(32);
        expect(rawToken).not.toContain('encu1.');

        // (a) PaymentRequest row: every string column scanned for the raw
        // token (and for the whole plaintext URL); tokenHash is sha256(raw).
        const row = await prisma.paymentRequest.findUnique({
            where: { tokenHash: sha256(rawToken) },
        });
        expect(row).toBeTruthy();
        expect(row.requesterId).toBe(requester.id);
        for (const [col, value] of Object.entries(row)) {
            if (typeof value === 'string') {
                expect(`${col}: ${value}`).not.toContain(rawToken);
            }
        }
        expect(row.tokenHash).toBe(sha256(rawToken));
        expect(row.tokenHash).not.toBe(rawToken);

        // (b) FinancialOperation claim (the permanent replay truth): every
        // string field scanned for the raw token; responseBody holds the
        // ORIGINAL wire bytes whose shareUrl is the ENVELOPE, not plaintext.
        const claim = await prisma.financialOperation.findFirst({
            where: { endpoint: EP_CREATE, key: 'pr-at-rest-l1', userId: requester.id },
        });
        expect(claim).toBeTruthy();
        for (const [col, value] of Object.entries(claim)) {
            if (typeof value === 'string') {
                expect(`${col}: ${value}`).not.toContain(rawToken);
            }
        }
        const stored = JSON.parse(claim.responseBody);
        expect(stored.success).toBe(true);
        expect(stored.data.request.shareUrl).toBe(shareUrl);
        expect(claim.responseBody).toContain('encu1.');

        // (c) The envelope in the URL is genuinely AEAD-authenticated ciphertext:
        // re-wrapping the raw token with the key does NOT reproduce it (fresh
        // IV), and the stored envelope decrypts to exactly the raw token.
        expect(wrapShareToken(rawToken)).not.toBe(urlToken);
        expect(unwrapShareToken(shareUrl.split('/request/')[1])).toBe(rawToken);
    });

    // ── L2: replay returns the canonical link, exactly once ──────────────
    test('L2: same-key replay returns the original canonical share URL, byte-identical, one row, no extra notification', async () => {
        const body = { amount: '20.00', currency: 'GHS', requestMode: 'LINK' };
        const key = 'pr-at-rest-l2';
        const first = await postCreate(tokenFor(requester), body, key);
        expect(first.status).toBe(201);
        const shareUrl = first.body.data.request.shareUrl;

        const notifBefore = await prisma.notification.count({ where: { userId: { in: [requester.id, recipient.id] } } });
        const rowsBefore = await prisma.paymentRequest.count({ where: { requesterId: requester.id } });

        const replay = await postCreate(tokenFor(requester), body, key);
        expect(replay.status).toBe(201);                       // matching status
        expect(replay.text).toBe(first.text);                 // byte-identical body
        expect(replay.body.data.request.shareUrl).toBe(shareUrl); // canonical link

        expect(await prisma.paymentRequest.count({ where: { requesterId: requester.id } })).toBe(rowsBefore);
        expect(await prisma.notification.count({ where: { userId: { in: [requester.id, recipient.id] } } })).toBe(notifBefore);
    });

    // ── L3: replay is crypto-independent (stored bytes are ciphertext) ────
    test('L3: committed replay replays identically even with the share-token key removed — no plaintext at rest is needed', async () => {
        const body = { amount: '30.25', currency: 'GHS', requestMode: 'LINK' };
        const key = 'pr-at-rest-l3';
        const first = await postCreate(tokenFor(requester), body, key);
        expect(first.status).toBe(201);

        const savedKey = process.env.ENCRYPTION_KEY;
        delete process.env.ENCRYPTION_KEY;
        try {
            // Replay path: byte-identical, same status — because the stored
            // truth is ciphertext, reconstruction (or a key) is never needed.
            const replay = await postCreate(tokenFor(requester), body, key);
            expect(replay.status).toBe(201);
            expect(replay.text).toBe(first.text);
            expect(replay.body.data.request.shareUrl).toBe(first.body.data.request.shareUrl);
        } finally {
            process.env.ENCRYPTION_KEY = savedKey;
        }
    });

    // ── L4: fail-closed on missing key / corrupt envelope ────────────────
    test('L4: missing key → 503 pre-claim (no row, no claim residue, no second request); tampered envelope → 404', async () => {
        const savedKey = process.env.ENCRYPTION_KEY;

        // Phase 0 — with the key present, a live link exists for the
        // public-resolution refusal below.
        const live = await postCreate(tokenFor(requester),
            { amount: '6.00', currency: 'GHS', requestMode: 'LINK' }, 'pr-at-rest-l4-live');
        expect(live.status).toBe(201);
        const liveUrlToken = live.body.data.request.shareUrl.split('/request/')[1];

        delete process.env.ENCRYPTION_KEY;
        try {
            const rowsBefore = await prisma.paymentRequest.count({ where: { requesterId: requester.id } });
            const body = { amount: '5.00', currency: 'GHS', requestMode: 'LINK' };
            const refused = await postCreate(tokenFor(requester), body, 'pr-at-rest-l4');
            expect(refused.status).toBe(503);
            expect(refused.body.code).toBe('LINK_SHARE_CRYPTO_UNCONFIGURED');

            // Nothing was created — no row, no claim residue for the key.
            expect(await prisma.paymentRequest.count({ where: { requesterId: requester.id } })).toBe(rowsBefore);
            expect(await prisma.financialOperation.count({
                where: { endpoint: EP_CREATE, key: 'pr-at-rest-l4' },
            })).toBe(0);

            // Public resolution with the key removed is refused honestly —
            // a config failure never masquerades as "link not found".
            const publicRefused = await request(app).get(`/api/payment-requests/public/${liveUrlToken}`);
            expect(publicRefused.status).toBe(503);
            expect(publicRefused.body.code).toBe('LINK_SHARE_CRYPTO_UNCONFIGURED');
        } finally {
            process.env.ENCRYPTION_KEY = savedKey;
        }

        // With the key restored: the pre-existing link resolves, and a
        // TAMPERED envelope fails AEAD authentication as an unknown token.
        const link = await postCreate(tokenFor(requester),
            { amount: '7.75', currency: 'GHS', requestMode: 'LINK' }, 'pr-at-rest-l4-ok');
        expect(link.status).toBe(201);
        const urlToken = link.body.data.request.shareUrl.split('/request/')[1];
        const ok = await request(app).get(`/api/payment-requests/public/${urlToken}`);
        expect(ok.status).toBe(200);

        const tampered = `${urlToken.slice(0, -3)}YYY`;
        const wrong = await request(app).get(`/api/payment-requests/public/${tampered}`);
        expect(wrong.status).toBe(404);
        expect(wrong.body.code).toBe('PAYMENT_REQUEST_NOT_FOUND');
        expect(wrong.body.message).not.toContain(urlToken);
    });
});
