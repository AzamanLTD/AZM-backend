/**
 * §B5 — THE STEP-UP COVERAGE GUARD.
 *
 * The route matrix once said "1 of 101" and that number was discovered by hand,
 * once. This guard replaces hand counts with the shared inventory module
 * (scripts/step-up-route-inventory.js) and enforces:
 *
 *   1. COMPLETENESS — every in-scope money route has exactly one recorded
 *      classification. A new money route fails here until it is gated or
 *      explicitly exempted with an economic reason.
 *   2. GATE INTEGRITY — every recorded gate is still present, and no gate can
 *      activate enforcement on its own (all sit behind whenStepUpEnforced).
 *   3. GAP FREEZE — the recorded CUSTOMER_GAP population matches exactly; it
 *      may only shrink.
 *   4. WEBHOOKS — provider callbacks are never customer-gated.
 *   5. DOC/CONFIG AGREEMENT — the published matrix is generated from the same
 *      module and states the same measured population.
 */
const fs = require('fs');
const path = require('path');

const {
    CLASS, REGISTRY, scanRoutes, classify, keyOf,
} = require('../scripts/step-up-route-inventory');

const DOC = path.join(__dirname, '..', 'docs', 'b5-step-up-route-matrix.md');

describe('§B5 step-up route coverage', () => {
    const result = classify(scanRoutes());

    test('every in-scope money route is classified (no unreviewed route can ship)', () => {
        expect(result.unclassified).toEqual([]);
    });

    test('every recorded classification corresponds to a real route (no stale registry entries)', () => {
        expect(result.registryMisses).toEqual([]);
    });

    test('the gated set is exactly the recorded seven, and each is behind whenStepUpEnforced', () => {
        const gated = result.byClass[CLASS.GATED].map(keyOf).sort();
        expect(gated).toEqual([
            'escrowRoutes.js|POST|/fund',
            'escrowRoutes.js|POST|/satisfy',
            'p2pRoutes.js|POST|/complete',
            'tradeRoutes.js|POST|/accept',
            'tradeRoutes.js|POST|/initiate',
            'walletRoutes.js|POST|/internal-transfer',
            'walletRoutes.js|POST|/withdraw',
        ].sort());
        for (const row of result.byClass[CLASS.GATED]) {
            expect({ route: keyOf(row), whenStepUpEnforced: row.whenStepUpEnforced })
                .toEqual({ route: keyOf(row), whenStepUpEnforced: true });
        }
    });

    test('the recorded customer coverage gap is frozen (may only shrink)', () => {
        const gaps = result.byClass[CLASS.CUSTOMER_GAP].map(keyOf).sort();
        const FROZEN = [
            'azmConversionRoutes.js|POST|/',
            'azmGiftRoutes.js|POST|/send',
            'businessOSRoutes.js|POST|/ewa/withdraw',
            'businessOSRoutes.js|POST|/finance/payout',
            'businessOSRoutes.js|POST|/orders/:id/refund',
            'businessRoutes.js|POST|/invoices/:invoiceId/pay',
            'conversationRoutes.js|POST|/:conversationId/messages/:messageId/fund-escrow',
            'conversationRoutes.js|POST|/:conversationId/messages/:messageId/release-escrow',
            'crossBorderSusuRoutes.js|POST|/contribute',
            'crossBorderSusuRoutes.js|POST|/payout',
            'depositRoutes.js|POST|/fiat/initiate',
            'depositRoutes.js|POST|/fiat/initiate/moolre',
            'dineInRoutes.js|POST|/tabs/:tabId/pay',
            'financeRoutes.js|POST|/withdraw/fiat',
            'friendRoutes.js|POST|/transfer/send',
            'friendRoutes.js|PUT|/transfer/:id/fulfill',
            'multiCurrencyRoutes.js|POST|/convert',
            'orderBookRoutes.js|POST|/orders',
            'savingsRoutes.js|POST|/goals/:id/deposit',
            'savingsRoutes.js|POST|/goals/:id/withdraw',
            'sharedVaultRoutes.js|POST|/:id/deposit',
            'storefrontCheckoutIntegrityRoutes.js|POST|/:businessProfileId/order',
            'storefrontRoutes.js|POST|/:businessProfileId/order',
            'vaultRoutes.js|POST|/:id/break',
            'vaultRoutes.js|POST|/:id/deposit',
            'walletRoutes.js|POST|/deposit/initialize',
            'withdrawalRoutes.js|POST|/bank',
            'withdrawalRoutes.js|POST|/crypto',
            'withdrawalRoutes.js|POST|/fiat',
            'withdrawalRoutes.js|POST|/ghs',
        ].sort();
        expect(gaps).toEqual(FROZEN);
    });

    test('every non-gated classification carries a written reason', () => {
        for (const cls of Object.values(CLASS)) {
            if (cls === CLASS.GATED) continue;
            for (const row of result.byClass[cls]) {
                const ok = typeof row.reason === 'string' && row.reason.trim().length > 10;
                expect({ route: keyOf(row), hasReason: ok }).toEqual({ route: keyOf(row), hasReason: true });
            }
        }
    });

    test('no gate can activate enforcement on its own', () => {
        for (const [key, entry] of Object.entries(REGISTRY)) {
            if (entry.class !== CLASS.GATED) continue;
            const row = result.byClass[CLASS.GATED].find((r) => keyOf(r) === key);
            expect({ key, present: !!row, wrapped: row ? row.whenStepUpEnforced : false })
                .toEqual({ key, present: true, wrapped: true });
        }
        // A bare requireActionStepUp( (inline or via a route-level variable)
        // would enforce regardless of the switch. None may exist anywhere.
        const bare = [...result.byClass[CLASS.GATED], ...result.inScope]
            .filter((row) => row.bareGate)
            .map(keyOf);
        expect(bare).toEqual([]);
    });

    test('provider webhooks are never gated by customer step-up', () => {
        for (const row of result.byClass[CLASS.WEBHOOK]) {
            expect({ route: keyOf(row), gated: row.gated }).toEqual({ route: keyOf(row), gated: false });
        }
        for (const needle of ['/fiat/webhook', '/webhook/moolre', '/webhook/tatum']) {
            const gatedWebhook = result.byClass[CLASS.GATED].some((g) => g.route.includes(needle));
            expect({ needle, gatedWebhook }).toEqual({ needle, gatedWebhook: false });
        }
    });

    test('the published matrix is generated from this module and agrees on the population', () => {
        expect(fs.existsSync(DOC)).toBe(true);
        const doc = fs.readFileSync(DOC, 'utf8');
        expect(doc).toContain('Generated from source');
        expect(doc).toContain(`Measured population: ${result.inScope.length} in-scope routes`);
        expect(doc).toContain(`| GATED | ${result.byClass[CLASS.GATED].length} |`);
        expect(doc).toContain(`| CUSTOMER_GAP | ${result.byClass[CLASS.CUSTOMER_GAP].length} |`);
        for (const row of result.byClass[CLASS.GATED]) {
            expect(doc).toContain(`\`${row.file.replace(/Routes\.js$/, '')} ${row.method} ${row.route}\``);
        }
    });
});
