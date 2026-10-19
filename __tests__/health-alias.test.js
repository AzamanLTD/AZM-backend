// =============================================================================
// /api/health alias (DB-free)
// =============================================================================
// The mobile client's ApiClient pins baseUrl to `${host}/api`, so every
// endpoint string it sends is resolved relative to /api. Splash and the
// version gate probe `/health` through that client, which resolved to
// /api/health — a path the server never registered, so both probes 404'd
// on every cold start even when the service was perfectly healthy.
//
// This suite locks the contract without a database: mountHealthRoutes is
// given a recording app, and we assert the SAME handler object serves both
// GET /health and GET /api/health (one source of truth — the alias can
// never drift from the root probe).
// =============================================================================

const { mountHealthRoutes } = require('../src/routes/health');

function recordingApp() {
  const registrations = [];
  return {
    registrations,
    get(path, handler) { registrations.push({ method: 'get', path, handler }); },
    post() {},
    use() {},
    set() {},
  };
}

function fakeDeps() {
  return {
    prisma: {
      $queryRaw: async () => [1],
      globalSettings: { findUnique: async () => null },
      smartEscrow: { count: async () => 0 },
    },
    workerStatus: { web: 'up' },
    redisStatusRef: () => 'up',
    APP_VERSION: 'test-version',
    IS_PRODUCTION: false,
  };
}

describe('GET /api/health alias', () => {
  test('registers GET /health', () => {
    const app = recordingApp();
    mountHealthRoutes(app, fakeDeps());
    expect(app.registrations.some((r) => r.method === 'get' && r.path === '/health')).toBe(true);
  });

  test('registers GET /api/health for API-base clients', () => {
    const app = recordingApp();
    mountHealthRoutes(app, fakeDeps());
    expect(app.registrations.some((r) => r.method === 'get' && r.path === '/api/health')).toBe(true);
  });

  test('both paths serve the SAME handler (alias cannot drift from the root probe)', () => {
    const app = recordingApp();
    mountHealthRoutes(app, fakeDeps());
    const root = app.registrations.find((r) => r.path === '/health');
    const alias = app.registrations.find((r) => r.path === '/api/health');
    expect(root).toBeDefined();
    expect(alias).toBeDefined();
    expect(alias.handler).toBe(root.handler);
  });

  test('the shared handler is an async function with the (req, res) probe signature', () => {
    const app = recordingApp();
    mountHealthRoutes(app, fakeDeps());
    const alias = app.registrations.find((r) => r.path === '/api/health');
    expect(typeof alias.handler).toBe('function');
    expect(alias.handler.constructor.name).toBe('AsyncFunction');
    expect(alias.handler.length).toBe(2);
  });
});
