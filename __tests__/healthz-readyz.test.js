/**
 * /healthz and /readyz semantics (WP-H §8).
 *
 * Liveness must not depend on any dependency; readiness must be gated by the
 * database and only by Redis when the deployment declares Redis required.
 */
const express = require('express');
const { mountHealthRoutes } = require('../src/routes/health');

function appWith({ dbUp = true, redis = 'connected', env = {} } = {}) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    const app = express();
    mountHealthRoutes(app, {
        prisma: {
            $queryRaw: async () => {
                if (!dbUp) throw new Error('down');
                return [{ ok: 1 }];
            },
            globalSettings: { findUnique: async () => null },
        },
        workerStatus: {},
        redisStatusRef: () => redis,
        APP_VERSION: '1.0.0-test',
        IS_PRODUCTION: false,
    });
    return { app, restore: () => { process.env = saved; } };
}

async function call(app, path) {
    const server = app.listen(0);
    try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, body: await res.json() };
    } finally {
        await new Promise((r) => server.close(r));
    }
}

describe('/healthz and /readyz', () => {
    test('liveness is 200 even when the database is down', async () => {
        const { app, restore } = appWith({ dbUp: false });
        const res = await call(app, '/healthz');
        restore();
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    test('readiness is 200 when the database answers', async () => {
        const { app, restore } = appWith({ dbUp: true });
        const res = await call(app, '/readyz');
        restore();
        expect(res.status).toBe(200);
        expect(res.body.checks.database).toBe('connected');
    });

    test('readiness is 503 when the database is down', async () => {
        const { app, restore } = appWith({ dbUp: false });
        const res = await call(app, '/readyz');
        restore();
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
    });

    test('redis outage is reported but does not gate readiness by default', async () => {
        const { app, restore } = appWith({ redis: 'disconnected' });
        const res = await call(app, '/readyz');
        restore();
        expect(res.status).toBe(200);
        expect(res.body.checks.redis).toBe('disconnected');
    });

    test('a deployment that declares Redis required is gated by it', async () => {
        const { app, restore } = appWith({ redis: 'disconnected', env: { REDIS_REQUIRED: '1' } });
        const res = await call(app, '/readyz');
        restore();
        expect(res.status).toBe(503);
    });
});
