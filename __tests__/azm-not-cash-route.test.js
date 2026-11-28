// __tests__/azm-not-cash-route.test.js
// =============================================================================
// AZM points are loyalty value, not cash: POST /api/azm-convert refuses 409
// AZM_NOT_CASH before any state is read or written. The read-only history and
// rate endpoints stay mounted.
// =============================================================================
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = { id: 1, role: 'USER' }; next(); },
}));

const routes = require('../routes/azmConversionRoutes');

test('conversion is refused with nothing touched', async () => {
    const app = express();
    app.use(express.json());
    const touched = [];
    app.set('prisma', new Proxy({}, { get: (_t, p) => { touched.push(String(p)); throw new Error('prisma must not be touched'); } }));
    app.use('/api/azm-convert', routes);

    const res = await request(app).post('/api/azm-convert').send({ azmAmount: 1000 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'AZM_NOT_CASH' });
    expect(touched).toEqual([]);
});

test('the conversion route no longer reaches the crediting controller', () => {
    const controller = require('../controllers/azmConversionController');
    const post = routes.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
    const handlers = post.route.stack.map((s) => s.handle);
    expect(handlers).not.toContain(controller.convertAzmToUsdc);
    expect(handlers).toContain(routes.refuseAzmCashConversion);
});

test('history and rate stay readable', () => {
    const paths = routes.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/history', '/rate']));
});
