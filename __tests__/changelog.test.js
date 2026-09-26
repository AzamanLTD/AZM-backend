// __tests__/changelog.test.js
// Changelog controller tests — mock Prisma (no DB required)

const ctrl = require('../controllers/changelogController');

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
    };
}

function mockReq(overrides = {}) {
    return {
        user: { id: 1 },
        query: {},
        params: {},
        body: {},
        app: { get: () => mockPrisma },
        ...overrides,
    };
}

const mockPrisma = {
    changelog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    changelogView: { count: jest.fn(), upsert: jest.fn(), createMany: jest.fn() },
};

describe('Changelog Controller', () => {
    beforeEach(() => jest.clearAllMocks());

    // ── listChangelog ────────────────────────────────────────────────────
    test('listChangelog returns entries with seen flag', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([
            { id: 1, version: 'v1.0', title: 'Launch', body: 'We launched!', category: 'feature', severity: 'info', imageUrl: null, publishedAt: new Date(), views: [] },
            { id: 2, version: 'v1.1', title: 'Fix', body: 'Bug fix', category: 'fix', severity: 'info', imageUrl: null, publishedAt: new Date(), views: [{ id: 5 }] },
        ]);

        const res = mockRes();
        await ctrl.listChangelog(mockReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].seen).toBe(false);
        expect(res.body.data[1].seen).toBe(true);
    });

    test('listChangelog respects limit/offset', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([]);
        const res = mockRes();
        await ctrl.listChangelog(mockReq({ query: { limit: '5', offset: '10' } }), res);

        expect(res.statusCode).toBe(200);
        expect(mockPrisma.changelog.findMany.mock.calls[0][0].take).toBe(5);
        expect(mockPrisma.changelog.findMany.mock.calls[0][0].skip).toBe(10);
    });

    test('listChangelog caps limit at 100', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([]);
        await ctrl.listChangelog(mockReq({ query: { limit: '999' } }), mockRes());
        expect(mockPrisma.changelog.findMany.mock.calls[0][0].take).toBe(100);
    });

    // ── unreadCount ─────────────────────────────────────────────────────
    test('unreadCount returns total - seen', async () => {
        mockPrisma.changelog.count.mockResolvedValue(10);
        mockPrisma.changelogView.count.mockResolvedValue(3);

        const res = mockRes();
        await ctrl.unreadCount(mockReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data.unread).toBe(7);
    });

    test('unreadCount never goes negative', async () => {
        mockPrisma.changelog.count.mockResolvedValue(2);
        mockPrisma.changelogView.count.mockResolvedValue(5);

        const res = mockRes();
        await ctrl.unreadCount(mockReq(), res);

        expect(res.body.data.unread).toBe(0);
    });

    // ── dismissEntry ────────────────────────────────────────────────────
    test('dismissEntry upserts a view record', async () => {
        mockPrisma.changelogView.upsert.mockResolvedValue({ id: 1 });

        const res = mockRes();
        await ctrl.dismissEntry(mockReq({ params: { id: '3' } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockPrisma.changelogView.upsert).toHaveBeenCalledWith({
            where: { changelogId_userId: { changelogId: 3, userId: 1 } },
            create: { changelogId: 3, userId: 1 },
            update: {},
        });
    });

    test('dismissEntry returns 404 for non-existent entry (P2003)', async () => {
        mockPrisma.changelogView.upsert.mockRejectedValue({ code: 'P2003' });

        const res = mockRes();
        await ctrl.dismissEntry(mockReq({ params: { id: '999' } }), res);

        expect(res.statusCode).toBe(404);
    });

    test('dismissEntry returns 400 for invalid id', async () => {
        const res = mockRes();
        await ctrl.dismissEntry(mockReq({ params: { id: 'abc' } }), res);
        expect(res.statusCode).toBe(400);
    });

    // ── dismissAll ──────────────────────────────────────────────────────
    test('dismissAll creates views for all entries', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
        mockPrisma.changelogView.createMany.mockResolvedValue({ count: 3 });

        const res = mockRes();
        await ctrl.dismissAll(mockReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain('3');
        expect(mockPrisma.changelogView.createMany).toHaveBeenCalledWith({
            data: [
                { changelogId: 1, userId: 1 },
                { changelogId: 2, userId: 1 },
                { changelogId: 3, userId: 1 },
            ],
            skipDuplicates: true,
        });
    });

    test('dismissAll returns success when no entries exist', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([]);

        const res = mockRes();
        await ctrl.dismissAll(mockReq(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.message).toContain('No entries');
    });

    // ── adminCreate ─────────────────────────────────────────────────────
    test('adminCreate creates entry with valid data', async () => {
        mockPrisma.changelog.create.mockResolvedValue({ id: 1, version: 'v2.0', title: 'New', body: 'Body' });

        const res = mockRes();
        await ctrl.adminCreate(mockReq({ body: { version: 'v2.0', title: 'New', body: 'Body' } }), res);

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.version).toBe('v2.0');
    });

    test('adminCreate rejects missing required fields', async () => {
        const res = mockRes();
        await ctrl.adminCreate(mockReq({ body: { version: 'v2.0' } }), res);
        expect(res.statusCode).toBe(400);
    });

    test('adminCreate rejects invalid category', async () => {
        const res = mockRes();
        await ctrl.adminCreate(mockReq({ body: { version: 'v2.0', title: 'T', body: 'B', category: 'INVALID' } }), res);
        expect(res.statusCode).toBe(400);
    });

    test('adminCreate rejects invalid severity', async () => {
        const res = mockRes();
        await ctrl.adminCreate(mockReq({ body: { version: 'v2.0', title: 'T', body: 'B', severity: 'INVALID' } }), res);
        expect(res.statusCode).toBe(400);
    });

    test('adminCreate defaults category and severity', async () => {
        mockPrisma.changelog.create.mockResolvedValue({ id: 1 });

        await ctrl.adminCreate(mockReq({ body: { version: 'v1', title: 'T', body: 'B' } }), mockRes());

        expect(mockPrisma.changelog.create.mock.calls[0][0].data.category).toBe('feature');
        expect(mockPrisma.changelog.create.mock.calls[0][0].data.severity).toBe('info');
    });

    // ── adminUpdate ─────────────────────────────────────────────────────
    test('adminUpdate updates entry', async () => {
        mockPrisma.changelog.update.mockResolvedValue({ id: 1, title: 'Updated' });

        const res = mockRes();
        await ctrl.adminUpdate(mockReq({ params: { id: '1' }, body: { title: 'Updated' } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data.title).toBe('Updated');
    });

    test('adminUpdate returns 404 for not-found (P2025)', async () => {
        mockPrisma.changelog.update.mockRejectedValue({ code: 'P2025' });

        const res = mockRes();
        await ctrl.adminUpdate(mockReq({ params: { id: '999' }, body: { title: 'X' } }), res);

        expect(res.statusCode).toBe(404);
    });

    // ── adminDelete ─────────────────────────────────────────────────────
    test('adminDelete deletes entry', async () => {
        mockPrisma.changelog.delete.mockResolvedValue({ id: 1 });

        const res = mockRes();
        await ctrl.adminDelete(mockReq({ params: { id: '1' } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('adminDelete returns 404 for not-found (P2025)', async () => {
        mockPrisma.changelog.delete.mockRejectedValue({ code: 'P2025' });

        const res = mockRes();
        await ctrl.adminDelete(mockReq({ params: { id: '999' } }), res);

        expect(res.statusCode).toBe(404);
    });

    // ── adminList ───────────────────────────────────────────────────────
    test('adminList returns paginated entries', async () => {
        mockPrisma.changelog.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        mockPrisma.changelog.count.mockResolvedValue(5);

        const res = mockRes();
        await ctrl.adminList(mockReq({ query: { limit: '2', offset: '0' } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.pagination.total).toBe(5);
        expect(res.body.pagination.hasMore).toBe(true);
    });

    // ── error handling ─────────────────────────────────────────────────
    test('listChangelog handles DB error', async () => {
        mockPrisma.changelog.findMany.mockRejectedValue(new Error('DB down'));

        const res = mockRes();
        await ctrl.listChangelog(mockReq(), res);

        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
    });

    test('adminCreate handles DB error', async () => {
        mockPrisma.changelog.create.mockRejectedValue(new Error('DB down'));

        const res = mockRes();
        await ctrl.adminCreate(mockReq({ body: { version: 'v1', title: 'T', body: 'B' } }), res);

        expect(res.statusCode).toBe(500);
    });
});
