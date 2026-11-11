// __tests__/business-export-route.test.js
// =============================================================================
// Route-level proof for GET /api/business-os/export.
//
// The helper tests prove buildZipStream writes a correct archive. They do NOT
// prove the route still hands it the right six documents, sets the response
// headers, or streams a real HTTP response. This mounts the actual router.
// =============================================================================

jest.mock('../src/config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// The router mounts protect + protectActive globally. Authentication itself is
// proven in the auth suites; here it is satisfied so the export route runs.
jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { if (!req.user) req.user = { id: 1 }; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (_req, _res, next) => next(),
}));

// Permission enforcement is not what this file proves; it is covered elsewhere.
jest.mock('../middleware/requirePermission', () => ({
    requirePermission: () => (req, _res, next) => next(),
    resolveBusinessContext: async () => ({ businessProfileId: 'biz-1' }),
}));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');

const router = require('../routes/businessOSRoutes');

const ROWS = {
    businessOrder: [{ id: 'o1', total: 10, createdAt: new Date(), customer: 'A, B' }],
    businessInvoice: [{ id: 'i1', amount: 5, createdAt: new Date() }],
    businessReview: [{ id: 'r1', rating: 5, createdAt: new Date() }],
    businessEmployee: [{ id: 'e1', name: 'Kofi', createdAt: new Date() }],
    businessProduct: [{ id: 'p1', name: 'Yam', price: 2, createdAt: new Date() }],
};

function buildApp() {
    const prisma = {};
    for (const model of Object.keys(ROWS)) {
        prisma[model] = { findMany: jest.fn(async () => ROWS[model]) };
    }
    const app = express();
    app.set('prisma', prisma);
    app.use((req, _res, next) => {
        req.user = { id: 1 };
        req.businessProfileId = 'biz-1';
        req.businessProfile = { name: 'Acme & Co' };
        next();
    });
    app.use('/api/business-os', router);
    return { app, prisma };
}

/** Collect the binary body, then read the zip entries back out of it. */
function readZip(buffer) {
    const file = path.join(os.tmpdir(), `export-route-${process.pid}-${Date.now()}.zip`);
    fs.writeFileSync(file, buffer);
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const entries = [];
            zip.on('entry', (entry) => {
                const chunks = [];
                zip.openReadStream(entry, (e, stream) => {
                    if (e) return reject(e);
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => {
                        entries.push({ name: entry.fileName, body: Buffer.concat(chunks).toString('utf8') });
                        zip.readEntry();
                    });
                });
            });
            zip.on('end', () => { fs.unlinkSync(file); resolve(entries); });
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

describe('GET /api/business-os/export (real route)', () => {
    test('streams a zip with the six documents and their contents', async () => {
        const { app } = buildApp();
        const res = await request(app)
            .get('/api/business-os/export')
            .buffer(true)
            .parse((r, cb) => {
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', () => cb(null, Buffer.concat(chunks)));
            });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/zip');
        expect(res.headers['content-disposition']).toMatch(/Acme___Co_export_\d{4}-\d{2}-\d{2}\.zip/);

        const entries = await readZip(res.body);
        expect(entries.map((e) => e.name)).toEqual([
            'orders.csv', 'invoices.csv', 'reviews.csv',
            'employees.csv', 'products.csv', 'manifest.json',
        ]);

        const orders = entries.find((e) => e.name === 'orders.csv').body;
        expect(orders.split('\n')[0]).toContain('id');
        expect(orders).toContain('"A, B"'); // CSV quoting preserved

        const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').body);
        expect(manifest.businessId).toBe('biz-1');
        expect(manifest.businessName).toBe('Acme & Co');
        expect(manifest.counts).toEqual({ orders: 1, invoices: 1, reviews: 1, employees: 1, products: 1 });
    });

    test('a failing data read does not leave the client with a success', async () => {
        const { app, prisma } = buildApp();
        prisma.businessOrder.findMany.mockRejectedValueOnce(new Error('db down'));
        const res = await request(app).get('/api/business-os/export');
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.headers['content-type']).not.toBe('application/zip');
    });
});
