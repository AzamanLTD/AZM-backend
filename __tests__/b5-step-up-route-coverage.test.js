/**
 * §B5 — THE STEP-UP COVERAGE GUARD.
 *
 * The route matrix said "1 of 101" and that number was discovered by hand, once.
 * Nothing in the repository would have noticed a NEW ungated money route, or a
 * gate being quietly deleted from one that had it. This test is that notice.
 *
 * It reads the mounted route declarations and applies three rules:
 *   1. Every route recorded as gated must still be gated.
 *   2. The ungated money-route population may not GROW past the recorded ceiling.
 *      A new ungated money route fails here instead of shipping.
 *   3. Every gate is behind whenStepUpEnforced(), so wiring cannot activate
 *      enforcement by accident.
 *
 * Provider webhooks are asserted never to be gated: settlement must not depend on
 * a customer action.
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const MONEY_TERMS = ['withdraw', 'deposit', 'transfer', 'trade', 'escrow', 'susu',
    'vendor', 'payout', 'contribute', 'fulfil', 'fulfill', 'send'];
const MONEY_FILES = ['withdraw', 'deposit', 'p2p', 'susu', 'trade', 'escrow', 'wallet', 'payment'];

/** The text of one router.<verb>(...) call, ended by balanced parentheses. */
function declarationText(lines, start) {
    let depth = 0;
    const out = [];
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i];
        out.push(line);
        depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        if (depth <= 0 && line.includes(')')) break;
    }
    return out.join('\n');
}

function scanRoutes() {
    const gated = [];
    const ungated = [];
    const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();

    for (const file of files) {
        const full = path.join(ROUTES_DIR, file);
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        const text = lines.join('\n');
        // A gate may be declared once as a named const and reused.
        const bound = new Set(
            [...text.matchAll(/const\s+(\w+)\s*=\s*(?:whenStepUpEnforced\()?\s*requireActionStepUp\(/g)]
                .map((m) => m[1]),
        );

        lines.forEach((line, index) => {
            const m = line.match(/\s*router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/);
            if (!m) return;
            const routePath = m[2];
            const looksLikeMoney = MONEY_TERMS.some((t) => routePath.toLowerCase().includes(t))
                || MONEY_FILES.some((t) => file.toLowerCase().includes(t));
            if (!looksLikeMoney) return;

            const block = declarationText(lines, index);
            const isGated = block.includes('requireActionStepUp')
                || [...bound].some((b) => new RegExp(`\\b${b}\\b`).test(block));
            const entry = `${file} ${m[1].toUpperCase()} ${routePath}`;
            (isGated ? gated : ungated).push(entry);
        });
    }
    return { gated, ungated };
}

// The population as measured and reviewed on 2026-11-18. Adding a route here is a
// deliberate act: gate it, or record why it does not need the gate.
const RECORDED_GATED = [
    'escrowRoutes.js POST /fund',
    'escrowRoutes.js POST /satisfy',
    'p2pRoutes.js POST /complete',
    'tradeRoutes.js POST /initiate',
    'tradeRoutes.js POST /accept',
    'walletRoutes.js POST /withdraw',
    'walletRoutes.js POST /internal-transfer',
];

// Measured ceiling, not a target. It may fall as routes are gated; it may only
// rise with a deliberate edit to this number in the same commit that adds the
// route.
const UNGATED_CEILING = 93;

describe('§B5 step-up route coverage', () => {
    const { gated, ungated } = scanRoutes();

    test('every recorded gate is still present', () => {
        expect(gated.slice().sort()).toEqual(RECORDED_GATED.slice().sort());
    });

    test('the ungated money-route population has not grown', () => {
        expect(ungated.length).toBeLessThanOrEqual(UNGATED_CEILING);
        if (ungated.length > UNGATED_CEILING) {
            // eslint-disable-next-line no-console
            console.log('New ungated money routes:', ungated);
        }
    });

    test('no gate can activate enforcement on its own', () => {
        const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
        for (const file of files) {
            const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
            if (!text.includes('requireActionStepUp(')) continue;
            // A bare requireActionStepUp( mounted directly would enforce
            // regardless of the switch.
            const bare = /router\.(?:post|put|patch|delete)\([^)]*?(?<!whenStepUpEnforced\()requireActionStepUp\(/s.test(text);
            expect({ file, bare }).toEqual({ file, bare: false });
        }
    });

    test('provider webhooks are never gated by customer step-up', () => {
        for (const needle of ['/fiat/webhook', '/webhook/moolre', '/webhook/tatum']) {
            const gatedWebhook = gated.some((g) => g.includes(needle));
            expect({ needle, gatedWebhook }).toEqual({ needle, gatedWebhook: false });
        }
    });
});
