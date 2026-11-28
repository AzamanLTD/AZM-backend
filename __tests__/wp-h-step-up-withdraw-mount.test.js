// §WP-H G — the withdrawal route must never be left with two proofs or none.
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/services/totpStepClaimService', () => ({
    verifyAndClaimTotp: jest.fn(), sendTotpFailure: jest.fn(), sendTotpUnavailable: jest.fn(),
    TOTP_CODES: { UNAVAILABLE: 'TOTP_CLAIM_STORE_UNAVAILABLE' },
}));

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('withdrawal step-up mounting', () => {
    const env = { ...process.env };
    afterEach(() => { process.env = { ...env }; jest.resetModules(); });

    test('the gate sits AFTER idempotency so a committed retry needs no second grant', () => {
        const src = read('routes/walletRoutes.js');
        const idem = src.indexOf("idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true })");
        const gate = src.indexOf("stepUpGate,\n    walletController.requestWithdrawal");
        expect(idem).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(idem);
    });

    test('require2FA and the gate are mutually exclusive, never both', () => {
        const src = read('routes/walletRoutes.js');
        expect(src).toContain('isStepUpEnforced() ? next() : require2FA()(req, res, next)');
        // the raw require2FA() must no longer be chained directly onto /withdraw
        // Slice from the route declaration to its own terminator. Searching for the
        // handler name instead was brittle: it also appears in the comment block above.
        const start = src.indexOf("router.post('/withdraw',");
        const chain = src.slice(start, src.indexOf(');', start));
        expect(chain).toContain('secondFactor');
        expect(chain).not.toContain('require2FA(),');
    });

    test('the grant is consumed inside the economic transaction, not in middleware', async () => {
        const { consumeStepUp } = require('../middleware/requireActionStepUp');
        const consumeGrant = require('../src/services/actionStepUpService').consumeGrant;
        expect(typeof consumeStepUp).toBe('function');
        const src = read('controllers/walletController.js');
        const txOpen = src.indexOf('const result = await prisma.$transaction(async (tx) => {');
        const consume = src.indexOf('consumeStepUp(tx, req)');
        expect(consume).toBeGreaterThan(txOpen);
        expect(src).not.toMatch(/req\.app\.get\('prisma'\)\s*\)\s*;\s*\/\/ consume/);
    });

    test('default OFF leaves today\'s behaviour untouched', () => {
        delete process.env.STEP_UP_ENFORCEMENT;
        const { isStepUpEnforced } = require('../middleware/requireActionStepUp');
        expect(isStepUpEnforced()).toBe(false);
    });

    test('ON is opted into explicitly and a rejected grant is a 409 that releases the claim', () => {
        process.env.STEP_UP_ENFORCEMENT = 'on';
        const { isStepUpEnforced } = require('../middleware/requireActionStepUp');
        expect(isStepUpEnforced()).toBe(true);
        const src = read('controllers/walletController.js');
        expect(src).toContain("code: 'STEP_UP_REJECTED'");
        expect(src).toContain('res.locals.financialClaimRelease = true');
    });
});
