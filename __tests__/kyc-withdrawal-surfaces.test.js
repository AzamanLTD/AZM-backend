// __tests__/kyc-withdrawal-surfaces.test.js
// =============================================================================
// There are TWO withdrawal surfaces in this backend:
//
//   POST /api/withdrawals/fiat|crypto   (routes/withdrawalRoutes.js)
//   POST /api/wallet/withdraw           (routes/walletRoutes.js)
//
// PR #383 gated only the first. The second performs the same debit through
// walletController.requestWithdrawal, so a gate on one surface is not a gate on
// the action: an unverified account could still take money out. These tests pin
// BOTH routes, and pin the ORDERING (identity refused before the 2FA/i
// dempotency machinery runs).
// =============================================================================

function routeLayer(router, path) {
    const layer = router.stack.find(
        (l) => l.route && l.route.path === path && l.route.methods.post,
    );
    return layer ? layer.route.stack.map((s) => s.handle) : null;
}

describe('KYC gates every withdrawal surface', () => {
    test('POST /api/withdrawals/fiat is gated before 2FA', () => {
        const router = require('../routes/withdrawalRoutes');
        const handles = routeLayer(router, '/fiat');
        expect(handles).not.toBeNull();
        const names = handles.map((h) => h.name);
        expect(names).toContain('kycGate');
        expect(names.indexOf('kycGate')).toBeLessThan(names.indexOf('require2FA') === -1 ? Infinity : names.indexOf('require2FA'));
    });

    test('POST /api/withdrawals/crypto is gated', () => {
        const router = require('../routes/withdrawalRoutes');
        const handles = routeLayer(router, '/crypto');
        expect(handles.map((h) => h.name)).toContain('kycGate');
    });

    test('POST /api/wallet/withdraw is gated before 2FA and idempotency', () => {
        const router = require('../routes/walletRoutes');
        const handles = routeLayer(router, '/withdraw');
        expect(handles).not.toBeNull();
        const names = handles.map((h) => h.name);
        expect(names).toContain('kycGate');
        const gate = names.indexOf('kycGate');
        const twoFa = names.findIndex((n) => n.toLowerCase().includes('require2fa') || n.toLowerCase().includes('twofactor'));
        expect(twoFa === -1 || gate < twoFa).toBe(true);
    });
});
