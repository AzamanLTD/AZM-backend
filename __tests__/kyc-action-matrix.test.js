// __tests__/kyc-action-matrix.test.js
// =============================================================================
// The KYC action matrix is CODE, not configuration.
//
// Product requirement: identity is not demanded at first login, but it is
// required the moment a user starts a money-moving action — funding included,
// not only withdrawal. These tests pin two properties that a config mistake
// could otherwise quietly undo:
//
//   1. The mounted route inventory matches the matrix (each listed route really
//      carries the gate, in the right position).
//   2. `KYC_GATED_ACTIONS` can only ADD actions. Unset, empty or narrowed, the
//      required baseline still holds.
//
// Provider callbacks are exempt by contract: they process in-flight operations
// the user already started, and they carry no user identity to gate.
// =============================================================================

const { gatedActions, REQUIRED_GATED_ACTIONS } = require('../middleware/requireKyc');

/** Read a router's Express layer stack (Express 5 exposes .handle + .route). */
function layersFor(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  return layer ? layer.route.stack.map((s) => s.handle && s.handle.name) : null;
}

function expectGated(router, method, path, label) {
  const names = layersFor(router, method, path);
  expect(names).not.toBeNull();
  expect(names).toContain('kycGate');
  // Refusal must happen BEFORE the idempotency reservation / 2FA ask, so a
  // rejected action never consumes a key or triggers a provider call.
  const gateAt = names.indexOf('kycGate');
  const idempotencyAt = names.findIndex((n) => n === 'idempotency' || n === 'idempotencyMiddleware');
  if (idempotencyAt !== -1) expect(gateAt).toBeLessThan(idempotencyAt);
  expect(label).toBeTruthy();
}

const ORIGINAL_ENV = process.env.KYC_GATED_ACTIONS;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.KYC_GATED_ACTIONS;
  else process.env.KYC_GATED_ACTIONS = ORIGINAL_ENV;
});

describe('the required baseline cannot be configured away', () => {
  test('an unset env still gates every required action', () => {
    delete process.env.KYC_GATED_ACTIONS;
    const set = gatedActions();
    for (const action of REQUIRED_GATED_ACTIONS) expect(set.has(action)).toBe(true);
    expect(REQUIRED_GATED_ACTIONS).toEqual(
      expect.arrayContaining(['withdraw', 'deposit', 'p2p', 'trade', 'susu']),
    );
  });

  test('an empty env does not disable the gate', () => {
    process.env.KYC_GATED_ACTIONS = '';
    const set = gatedActions();
    for (const action of REQUIRED_GATED_ACTIONS) expect(set.has(action)).toBe(true);
  });

  test('a narrowed env keeps the baseline and only adds', () => {
    process.env.KYC_GATED_ACTIONS = 'withdraw,savings';
    const set = gatedActions();
    expect(set.has('withdraw')).toBe(true);
    expect(set.has('savings')).toBe(true);         // added
    expect(set.has('deposit')).toBe(true);          // NOT removed
    expect(set.has('p2p')).toBe(true);
    expect(set.has('trade')).toBe(true);
    expect(set.has('susu')).toBe(true);
  });
});

describe('every money-moving start carries the gate', () => {
  test('withdrawals — both surfaces', () => {
    delete require.cache[require.resolve('../routes/withdrawalRoutes')];
    delete require.cache[require.resolve('../routes/walletRoutes')];
    expectGated(require('../routes/withdrawalRoutes'), 'post', '/fiat', 'fiat withdrawal');
    expectGated(require('../routes/withdrawalRoutes'), 'post', '/crypto', 'crypto withdrawal');
    expectGated(require('../routes/walletRoutes'), 'post', '/withdraw', 'wallet withdrawal');
  });

  test('deposit / funding initiation', () => {
    delete require.cache[require.resolve('../routes/depositRoutes')];
    delete require.cache[require.resolve('../routes/walletRoutes')];
    expectGated(require('../routes/depositRoutes'), 'post', '/fiat/initiate', 'fiat deposit');
    expectGated(require('../routes/depositRoutes'), 'post', '/fiat/initiate/moolre', 'moolre deposit');
    expectGated(require('../routes/walletRoutes'), 'post', '/deposit/initialize', 'wallet deposit');
  });

  test('P2P internal transfer', () => {
    delete require.cache[require.resolve('../routes/walletRoutes')];
    expectGated(require('../routes/walletRoutes'), 'post', '/internal-transfer', 'p2p transfer');
  });

  test('trade initiation', () => {
    delete require.cache[require.resolve('../routes/tradeRoutes')];
    expectGated(require('../routes/tradeRoutes'), 'post', '/initiate', 'trade initiation');
  });

  test('susu and cross-border susu money movement', () => {
    delete require.cache[require.resolve('../routes/susuRoutes')];
    delete require.cache[require.resolve('../routes/crossBorderSusuRoutes')];
    expectGated(require('../routes/susuRoutes'), 'post', '/groups', 'susu join');
    expectGated(require('../routes/crossBorderSusuRoutes'), 'post', '/contribute', 'susu contribution');
    expectGated(require('../routes/crossBorderSusuRoutes'), 'post', '/payout', 'susu payout');
  });
});

describe('exemptions stay exempt', () => {
  test('provider callbacks never carry the interactive gate', () => {
    delete require.cache[require.resolve('../routes/depositRoutes')];
    const deposits = require('../routes/depositRoutes');
    for (const p of ['/fiat/webhook', '/webhook/tatum', '/fiat/webhook/moolre']) {
      const names = layersFor(deposits, 'post', p);
      expect(names).not.toBeNull();
      expect(names).not.toContain('kycGate');
    }
  });

  test('read-only history and status stay open', () => {
    delete require.cache[require.resolve('../routes/walletRoutes')];
    const wallet = require('../routes/walletRoutes');
    for (const p of ['/history', '/withdraw/status/:withdrawalId']) {
      const names = layersFor(wallet, 'get', p);
      if (names) expect(names).not.toContain('kycGate');
    }
  });
});
