// __tests__/notification-dismissal.test.js
// =============================================================================
// Notification soft dismissal (marketplace personalisation, Backend E) —
// real PostgreSQL tests over the mounted route stack with canonical JWTs.
//
// Required cases:
//   - owner-scoped dismissal (another user's notification -> 403)
//   - unknown notification ID -> honest 404
//   - repeated dismissal idempotent (flag stays true, no error)
//   - read/dismiss concurrency converges (either order, same end state)
//   - dismissed items hidden from list AND unread count (consistency)
//   - isRead and isDismissed are independent, explicit states
//   - socket event emitted on the user's room (badge sync; no reappear)
//   - the record is PRESERVED (soft), actionPayload untouched
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[notification-dismissal.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('Notification dismissal (Backend E)', () => {
    let prisma;
    const seq = { n: 0 };
    const uniq = () => `nd_${Date.now()}_${++seq.n}`;
    const seeded = { users: [], notifications: [] };

    let app, request, io;
    let aliceToken, bobToken, aliceId;
    let nUnread, nRead, nForeign;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        const express = require('express');
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        const { prisma: sharedPrisma } = require('../src/config/baseServices');
        app = express();
        app.use(express.json());
        app.set('prisma', sharedPrisma);
        // Recording socket stub: the contract requires the event to fire
        // on the user's room; no real socket server needed.
        const emitted = [];
        io = {
            to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
            _emitted: emitted,
        };
        app.set('socketio', io);
        app.use('/api', require('../middleware/responseHelpers'));
        app.use('/api', require('../src/middleware/prismaInjector'));
        app.use('/api/notifications', require('../routes/notificationRoutes'));
        request = require('supertest');

        const { signAccessToken } = require('../services/authTokenService');
        async function makeUser(name) {
            const username = `${name}_${uniq()}`;
            const u = await prisma.user.create({
                data: {
                    username,
                    email: `${username}@azaman.test`,
                    password: await bcrypt.hash('Str0ng!Pass#2026', 10),
                    availableBalance: 0, escrowLockedBalance: 0,
                    disputeEscrowBalance: 0, azamanId: `AZM-${uniq()}`,
                },
            });
            seeded.users.push(u.id);
            return { id: u.id, token: signAccessToken(u) };
        }
        const alice = await makeUser('alice');
        aliceId = alice.id; aliceToken = alice.token;
        bobToken = (await makeUser('bob')).token;

        async function seedNotif(userId, { isRead = false, category = 'MONEY', payload } = {}) {
            const n = await prisma.notification.create({
                data: {
                    userId,
                    title: `Test ${uniq()}`,
                    body: 'Dismissal contract test',
                    category,
                    isRead,
                    actionPayload: payload || { route: '/wallet', txId: `tx_${uniq()}` },
                },
            });
            seeded.notifications.push(n.id);
            return n;
        }
        nUnread = await seedNotif(aliceId, { isRead: false });
        nRead = await seedNotif(aliceId, { isRead: true });
        nForeign = await seedNotif(seeded.users[1]); // bob's own
    });

    afterAll(async () => {
        await prisma.notification.deleteMany({ where: { id: { in: seeded.notifications } } });
        for (const uid of seeded.users.slice().reverse()) {
            await prisma.user.delete({ where: { id: uid } }).catch(() => {});
        }
        await prisma.$disconnect();
        const { prisma: shared } = require('../src/config/baseServices');
        await shared.$disconnect().catch(() => {});
    });

    const asAlice = (r) => r.set('Authorization', `Bearer ${aliceToken}`);

    test('unknown notification ID -> honest 404', async () => {
        const res = await asAlice(request(app).delete('/api/notifications/no-such-id'));
        expect(res.statusCode).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('dismissing another user notification -> 403, row untouched', async () => {
        const res = await asAlice(request(app).delete(`/api/notifications/${nForeign.id}`));
        expect(res.statusCode).toBe(403);
        const row = await prisma.notification.findUnique({ where: { id: nForeign.id } });
        expect(row.isDismissed).toBe(false);
    });

    test('dismiss hides from list and unread count, flags states explicitly', async () => {
        const before = await asAlice(request(app).get('/api/notifications/unread-count'));
        const beforeCount = before.body.count;
        expect(beforeCount).toBeGreaterThanOrEqual(1); // nUnread present

        const res = await asAlice(request(app).delete(`/api/notifications/${nUnread.id}`));
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.notification.isDismissed).toBe(true);
        expect(res.body.notification.isRead).toBe(false); // independent, explicit

        const list = await asAlice(request(app).get('/api/notifications'));
        const ids = list.body.notifications.map(n => n.id);
        expect(ids).not.toContain(nUnread.id);
        expect(ids).toContain(nRead.id);

        const after = await asAlice(request(app).get('/api/notifications/unread-count'));
        expect(after.body.count).toBe(beforeCount - 1); // consistent
    });

    test('repeated dismissal is idempotent (soft, one record)', async () => {
        const again = await asAlice(request(app).delete(`/api/notifications/${nUnread.id}`));
        expect(again.statusCode).toBe(200);
        expect(again.body.notification.isDismissed).toBe(true);
        const rows = await prisma.notification.findMany({ where: { id: nUnread.id } });
        expect(rows).toHaveLength(1);
    });

    test('read/dismiss concurrency converges (either order, same end state)', async () => {
        const mk = (title) => prisma.notification.create({
            data: {
                userId: aliceId, title, body: 'x', category: 'GENERAL',
                actionPayload: { route: '/wallet' },
            },
        });
        // dismiss-then-read
        const a = await mk('C1'); seeded.notifications.push(a.id);
        await asAlice(request(app).delete(`/api/notifications/${a.id}`));
        const r1 = await asAlice(request(app).patch(`/api/notifications/${a.id}/read`));
        expect(r1.statusCode).toBe(200); // orthogonal states: read works post-dismiss
        const rowA = await prisma.notification.findUnique({ where: { id: a.id } });
        expect(rowA).toMatchObject({ isDismissed: true, isRead: true });

        // read-then-dismiss
        const b = await mk('C2'); seeded.notifications.push(b.id);
        await asAlice(request(app).patch(`/api/notifications/${b.id}/read`));
        await asAlice(request(app).delete(`/api/notifications/${b.id}`));
        const rowB = await prisma.notification.findUnique({ where: { id: b.id } });
        expect(rowB).toMatchObject({ isDismissed: true, isRead: true });
    });

    test('socket event fires on the user room for multi-device sync', async () => {
        io._emitted.length = 0;
        const res = await asAlice(request(app).delete(`/api/notifications/${nRead.id}`));
        expect(res.statusCode).toBe(200);
        const evt = io._emitted.find(e => e.event === 'notifications_updated' &&
            e.payload.type === 'DISMISSED' && e.payload.notificationId === nRead.id);
        expect(evt).toBeTruthy();
        expect(evt.room).toBe(`user_${aliceId}`);
    });

    test('dismissal never deletes the record or mutates the payload', async () => {
        const payloadBefore = JSON.stringify(nUnread.actionPayload);
        await asAlice(request(app).delete(`/api/notifications/${nUnread.id}`));
        const row = await prisma.notification.findUnique({ where: { id: nUnread.id } });
        expect(row).not.toBeNull();                        // record PRESERVED
        expect(JSON.stringify(row.actionPayload)).toBe(payloadBefore);
        expect(row.title).toBe(nUnread.title);
        expect(row.dismissedAt).toBeTruthy();
        expect(row.category).toBe(nUnread.category);       // taxonomy untouched
    });

    test('markAllAsRead and list/count stay consistent with dismissed rows', async () => {
        const fresh = await prisma.notification.create({
            data: {
                userId: aliceId, title: 'Fresh', body: 'x', category: 'SOCIAL',
                actionPayload: { route: '/home' },
            },
        });
        seeded.notifications.push(fresh.id);
        const mar = await asAlice(request(app).patch('/api/notifications/read-all'));
        expect(mar.statusCode).toBe(200);
        const cnt = await asAlice(request(app).get('/api/notifications/unread-count'));
        expect(cnt.body.count).toBe(0);
        const list = await asAlice(request(app).get('/api/notifications'));
        const ids = list.body.notifications.map(n => n.id);
        expect(ids).not.toContain(nUnread.id);
        expect(ids).not.toContain(nRead.id);
        expect(ids).toContain(fresh.id); // fresh, non-dismissed items remain
    });

    test('unreadOnly listing still hides dismissed items', async () => {
        const unread = await prisma.notification.create({
            data: {
                userId: aliceId, title: 'U2', body: 'x', category: 'GENERAL',
                isRead: false, actionPayload: { route: '/home' },
            },
        });
        seeded.notifications.push(unread.id);
        await asAlice(request(app).delete(`/api/notifications/${unread.id}`));
        const list = await asAlice(request(app).get('/api/notifications?unreadOnly=true'));
        const ids = list.body.notifications.map(n => n.id);
        expect(ids).not.toContain(unread.id); // dismissed unread never reappears
    });
});
