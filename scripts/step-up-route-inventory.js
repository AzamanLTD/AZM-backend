// scripts/step-up-route-inventory.js
// =============================================================================
// §B5 — THE CANONICAL STEP-UP ROUTE INVENTORY.
//
// One source of truth for three artifacts that must never disagree:
//   1. the static coverage guard (__tests__/b5-step-up-route-coverage.test.js),
//   2. the published route matrix (docs/b5-step-up-route-matrix.md, generated
//      by `node scripts/step-up-route-inventory.js --write-doc`),
//   3. the recorded coverage-gap population the release brief requires.
//
// SCOPE is explicit, never inferred from a single string match:
//   • every mutation route (POST/PUT/PATCH/DELETE) in routes/*.js whose PATH
//     matches a money term, plus
//   • every route listed in EXPLICIT_SCOPE — value-moving routes whose paths
//     carry no money term ("/ghs", "/fiat", "/initiate", "/satisfy", "/pay"…).
//
// Every in-scope route must carry exactly one classification:
//   GATED            — carries whenStepUpEnforced(requireActionStepUp(...)).
//   CUSTOMER_GAP     — genuinely moves customer value and has NO gate. This is
//                      the recorded, frozen coverage gap: it may only shrink.
//   CUSTOMER_EXEMPT  — moves value but customer step-up is not required, with
//                      an economic reason recorded here.
//   BUSINESS         — a KYB-scoped business operator acting on their own
//                      business (membership + KYB gated); not customer step-up.
//   OPERATOR         — an admin/operator action that needs separate operator
//                      authorisation; the brief forbids customer step-up here.
//   NON_VALUE        — matches a money term but moves no value (quotes,
//                      messages, uploads, status transitions, catalog edits,
//                      OTP sends, notification triggers).
//   WEBHOOK          — provider callback; settlement must never depend on a
//                      customer action.
//
// Adding a route to routes/*.js that lands in scope WITHOUT a classification
// fails the guard. That is the point: unreviewed money routes cannot ship.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Path terms that put a mutation route in scope for review. Deliberately broad:
// over-inclusion costs one classification line; under-inclusion ships an
// ungated money route.
const MONEY_TERMS = [
    'withdraw', 'deposit', 'transfer', 'trade', 'escrow', 'susu', 'vendor',
    'payout', 'contribute', 'fulfil', 'fulfill', 'send', 'gift', 'vault',
    'savings', 'convert', 'topup', 'top-up', 'fund', 'buy', 'sell', 'order',
    'purchase', 'payment', 'request', 'settle', 'refund', 'charge', 'fee',
    'bill', 'airtime', 'data', 'quote', 'spend', 'ewa', 'inventory', 'retail',
    'pos', 'pay',
];

// Value-moving routes whose paths carry no money term. Each entry is a route
// that moves customer value and must be classified like any money-term match.
const EXPLICIT_SCOPE = [
    ['withdrawalRoutes.js', 'POST', '/fiat'],
    ['withdrawalRoutes.js', 'POST', '/ghs'],
    ['withdrawalRoutes.js', 'POST', '/crypto'],
    ['withdrawalRoutes.js', 'POST', '/bank'],
    ['depositRoutes.js', 'POST', '/fiat/initiate'],
    ['depositRoutes.js', 'POST', '/fiat/initiate/moolre'],
    ['depositRoutes.js', 'POST', '/fiat/initiate/moolre/otp'],
    ['depositRoutes.js', 'POST', '/validate-name'],
    ['depositRoutes.js', 'POST', '/fiat/webhook'],
    ['depositRoutes.js', 'POST', '/fiat/webhook/moolre'],
    ['depositRoutes.js', 'POST', '/webhook/tatum'],
    ['escrowRoutes.js', 'POST', '/fund'],
    ['escrowRoutes.js', 'POST', '/satisfy'],
    ['p2pRoutes.js', 'POST', '/complete'],
    ['tradeRoutes.js', 'POST', '/initiate'],
    ['tradeRoutes.js', 'POST', '/accept'],
    ['vaultRoutes.js', 'POST', '/:id/break'],
    ['azmConversionRoutes.js', 'POST', '/'],
    ['dineInRoutes.js', 'POST', '/tabs/:tabId/pay'],
    ['paymentRequestRoutes.js', 'POST', '/'],
    ['susuRoutes.js', 'POST', '/groups'],
    ['susuRoutes.js', 'POST', '/groups/:id/contract'],
    ['susuRoutes.js', 'POST', '/groups/:id/cancel'],
    ['susuRoutes.js', 'POST', '/:id/contract/accept'],
    ['savedMomoRoutes.js', 'POST', '/'],
    ['billsRoutes.js', 'POST', '/saved-accounts'],
];

const CLASS = Object.freeze({
    GATED: 'GATED',
    CUSTOMER_GAP: 'CUSTOMER_GAP',
    CUSTOMER_EXEMPT: 'CUSTOMER_EXEMPT',
    BUSINESS: 'BUSINESS',
    OPERATOR: 'OPERATOR',
    NON_VALUE: 'NON_VALUE',
    WEBHOOK: 'WEBHOOK',
});

const OPERATOR_REASON = 'operator/admin action — needs separate operator authorisation, never customer step-up';
const BUSINESS_REASON = 'KYB-scoped business operator acting on their own business; membership + KYB gated';
const NON_VALUE_REASON = 'does not move value';

// The registry: "file|METHOD|path" → { class, reason }.
// Customer gaps carry the economic reason the gap is recorded, not ignored.
const R = (cls, reason) => ({ class: cls, reason });

const REGISTRY = {
    // ── operator / admin domain ──────────────────────────────────────────────
    'adminChatRoutes.js|POST|/intervene/:tradeId': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminControlPlaneRoutes.js|POST|/staff/:id/suspend': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminControlPlaneSummaryRoutes.js|POST|/disputes/:escrowId/assign': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminControlPlaneSummaryRoutes.js|POST|/disputes/:escrowId/resolve': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/withdrawals/:id/approve': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/withdrawals/:id/reject': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/withdrawals/:id/resolve-review': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/fee-profiles': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|PUT|/fee-profiles/:id': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|DELETE|/fee-profiles/:id': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/trade-accounts/:id/approve': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/trade-accounts/:id/reject': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/payouts/batch-process': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|PUT|/payouts/settings': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/disputes/:tradeId/resolve': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/escrow-disputes/:id/assign': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/escrow-disputes/:id/resolve': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/businesses/:bizId/suspend': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|POST|/businesses/:bizId/unsuspend': R(CLASS.OPERATOR, OPERATOR_REASON),
    'adminRoutes.js|DELETE|/ad-posts/:id': R(CLASS.OPERATOR, OPERATOR_REASON),

    // ── business operator (KYB-scoped, own business) ─────────────────────────
    'businessOSInventoryRoutes.js|POST|/restaurant/inventory/:id/restock': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSInventoryRoutes.js|POST|/restaurant/inventory/restock-intents': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSInventoryRoutes.js|POST|/restaurant/inventory/restock-intents/:id/ack': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSInventoryRoutes.js|POST|/restaurant/inventory/restock-intents/:id/cancel': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSPosRoutes.js|POST|/pos/order': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSRoutes.js|POST|/payroll/process': R(CLASS.BUSINESS, 'runs a payroll batch for the operator\'s own business (payroll.process permission)'),
    'businessOSRoutes.js|POST|/payroll/disburse': R(CLASS.BUSINESS, 'disburses the operator\'s own business payroll (payroll.disburse permission)'),
    'businessOSRoutes.js|POST|/pos/cash-sale': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSRoutes.js|POST|/pos/cash-close-tab': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSRoutes.js|POST|/retail/purchase-orders': R(CLASS.BUSINESS, BUSINESS_REASON),
    'businessOSRoutes.js|PATCH|/retail/purchase-orders/:id': R(CLASS.BUSINESS, BUSINESS_REASON),

    // ── provider webhooks (never customer-gated) ─────────────────────────────
    'financeRoutes.js|POST|/webhook/deposit': R(CLASS.WEBHOOK, 'provider deposit callback; settlement must not depend on a customer action'),
    'depositRoutes.js|POST|/fiat/webhook': R(CLASS.WEBHOOK, 'provider deposit callback'),
    'depositRoutes.js|POST|/fiat/webhook/moolre': R(CLASS.WEBHOOK, 'provider deposit callback'),
    'depositRoutes.js|POST|/webhook/tatum': R(CLASS.WEBHOOK, 'provider crypto callback'),

    // ── non-value matches ────────────────────────────────────────────────────
    'azmRoutes.js|POST|/spend/card-skin/equip': R(CLASS.NON_VALUE, 'equips an owned cosmetic; no balance change'),
    'businessDirectMessageRoutes.js|POST|/send': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/employees/my-ewa-request': R(CLASS.NON_VALUE, 'creates an EWA request record; the payout is POST /ewa/withdraw'),
    'businessOSRoutes.js|POST|/employees/shifts/:shiftId/request-swap': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/restaurant/tables/:id/metadata': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/restaurant/sections/reorder': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/feedback': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/restaurant/inventory': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/restaurant/inventory/:id': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/restaurant/inventory/deduct/:orderId': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/reservations/:id/propose-reschedule': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/orders/bulk-status': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/messages/:conversationId/send': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/retail/suppliers': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/retail/suppliers/:id': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|DELETE|/retail/suppliers/:id': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/retail/stock-counts': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/retail/stock-counts/:id/items/:itemId': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|POST|/retail/stock-counts/:id/reconcile': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessOSRoutes.js|PATCH|/retail/products/:id/barcode': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessRoutes.js|PATCH|/orders/:orderId/delivered': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'businessRoutes.js|POST|/invoices/:invoiceId/send': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'chatRoutes.js|POST|/send': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'chatUploadRoutesExtended.js|POST|/vendor-docs': R(CLASS.NON_VALUE, 'file upload'),
    'conversationRoutes.js|POST|/:conversationId/messages/:messageId/dispute-escrow': R(CLASS.NON_VALUE, 'flags a dispute; no balance change'),
    'friendRoutes.js|POST|/request': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'friendRoutes.js|PUT|/request/:id/accept': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'friendRoutes.js|PUT|/request/:id/reject': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'friendRoutes.js|POST|/transfer/request': R(CLASS.NON_VALUE, 'creates a request record; funds move only at fulfil'),
    'friendRoutes.js|PUT|/transfer/:id/decline': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'groupChatRoutes.js|POST|/:id/susu/initiate': R(CLASS.NON_VALUE, 'starts a susu cycle; contributions are scheduler-driven'),
    'groupChatRoutes.js|POST|/:id/susu/cancel': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'groupChatRoutes.js|POST|/:id/susu/vouch': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'groupChatRoutes.js|POST|/:id/join-requests': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'groupChatRoutes.js|POST|/:id/join-requests/:reqId/approve': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'groupChatRoutes.js|POST|/:id/join-requests/:reqId/reject': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'notificationRoutes.js|POST|/trigger/trade-started': R(CLASS.NON_VALUE, 'notification trigger'),
    'notificationRoutes.js|POST|/trigger/deposit-success': R(CLASS.NON_VALUE, 'notification trigger'),
    'orderBookRoutes.js|DELETE|/orders/:id': R(CLASS.NON_VALUE, 'cancels an order and releases its own reservation'),
    'orderTrackingRoutes.js|PUT|/:orderId/tracking/location': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'orderTrackingRoutes.js|PUT|/:orderId/tracking/eta': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'orderTrackingRoutes.js|POST|/:orderId/tracking/status': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'p2pRoutes.js|POST|/underpayment': R(CLASS.NON_VALUE, 'dispute marking'),
    'p2pRoutes.js|POST|/overpayment': R(CLASS.NON_VALUE, 'dispute marking'),
    'reservationRoutes.js|POST|/:id/counter-propose': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'securityRoutes.js|POST|/phone/send-otp': R(CLASS.NON_VALUE, 'sends an OTP challenge; no value moves'),
    'securityRoutes.js|POST|/app-unlock/sms/send': R(CLASS.NON_VALUE, 'sends an app-unlock OTP challenge; no value moves'),
    'showcaseRoutes.js|POST|/reorder': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'walletPassRoutes.js|POST|/vault/:vaultId': R(CLASS.NON_VALUE, 'generates a pass; no balance change'),
    'withdrawalRoutes.js|POST|/ghs/quote': R(CLASS.NON_VALUE, 'returns an indicative quote; no value moves'),
    'withdrawalRoutes.js|POST|/bank/quote': R(CLASS.NON_VALUE, 'returns an indicative quote; no value moves'),
    'depositRoutes.js|POST|/fiat/initiate/moolre/otp': R(CLASS.NON_VALUE, 'OTP confirmation for the initiate above'),
    'depositRoutes.js|POST|/validate-name': R(CLASS.NON_VALUE, 'name validation'),
    'paymentRequestRoutes.js|POST|/': R(CLASS.NON_VALUE, 'creates a request record; no funds move until the payer pays'),
    'susuRoutes.js|POST|/groups': R(CLASS.NON_VALUE, 'creates a susu group record'),
    'susuRoutes.js|POST|/groups/:id/contract': R(CLASS.NON_VALUE, 'accepts a contract; contributions are scheduler-driven'),
    'susuRoutes.js|POST|/groups/:id/cancel': R(CLASS.NON_VALUE, NON_VALUE_REASON),
    'susuRoutes.js|POST|/:id/contract/accept': R(CLASS.NON_VALUE, 'accepts a contract'),
    'savedMomoRoutes.js|POST|/': R(CLASS.NON_VALUE, 'saves a payout destination record; no funds move'),
    'billsRoutes.js|POST|/saved-accounts': R(CLASS.NON_VALUE, 'saves a bill account record; no funds move'),

    // ── customer-exempt (value moves; step-up not required, with reason) ─────
    'azmRoutes.js|POST|/spend/fee-discount': R(CLASS.CUSTOMER_EXEMPT, 'spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists, so the economic loss is bounded to the reward balance'),
    'azmRoutes.js|POST|/spend/ad-boost': R(CLASS.CUSTOMER_EXEMPT, 'spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists'),
    'azmRoutes.js|POST|/spend/card-skin/purchase': R(CLASS.CUSTOMER_EXEMPT, 'spends non-redeemable internal AZM reward points; no fiat/USDC exit rail exists'),

    // ── gated today ──────────────────────────────────────────────────────────
    'walletRoutes.js|POST|/withdraw': R(CLASS.GATED, 'FIAT_WITHDRAWAL — the proven end-to-end path'),
    'walletRoutes.js|POST|/internal-transfer': R(CLASS.GATED, 'INTERNAL_TRANSFER'),
    'escrowRoutes.js|POST|/fund': R(CLASS.GATED, 'ESCROW_FUND'),
    'escrowRoutes.js|POST|/satisfy': R(CLASS.GATED, 'ESCROW_RELEASE'),
    'p2pRoutes.js|POST|/complete': R(CLASS.GATED, 'P2P_TRADE_COMPLETE'),
    'tradeRoutes.js|POST|/initiate': R(CLASS.GATED, 'TRADE_INITIATE'),
    'tradeRoutes.js|POST|/accept': R(CLASS.GATED, 'TRADE_ACCEPT'),

    // ── recorded customer coverage gaps (frozen; may only shrink) ────────────
    'withdrawalRoutes.js|POST|/fiat': R(CLASS.CUSTOMER_GAP, 'legacy fiat withdrawal; KYC + 2FA + idempotent, no action-bound step-up'),
    'withdrawalRoutes.js|POST|/ghs': R(CLASS.CUSTOMER_GAP, 'native-GHS withdrawal; KYC + 2FA + idempotent, no action-bound step-up'),
    'withdrawalRoutes.js|POST|/crypto': R(CLASS.CUSTOMER_GAP, 'crypto withdrawal; KYC + 2FA + idempotent, no action-bound step-up'),
    'withdrawalRoutes.js|POST|/bank': R(CLASS.CUSTOMER_GAP, 'bank payout; KYC + 2FA + idempotent, no action-bound step-up'),
    'walletRoutes.js|POST|/deposit/initialize': R(CLASS.CUSTOMER_GAP, 'initiates a deposit; KYC + idempotent, no action-bound step-up'),
    'depositRoutes.js|POST|/fiat/initiate': R(CLASS.CUSTOMER_GAP, 'initiates a fiat deposit; KYC + idempotent, no action-bound step-up'),
    'depositRoutes.js|POST|/fiat/initiate/moolre': R(CLASS.CUSTOMER_GAP, 'initiates a Moolre deposit; KYC + idempotent, no action-bound step-up'),
    'friendRoutes.js|POST|/transfer/send': R(CLASS.CUSTOMER_GAP, 'peer transfer of funds; KYC + 2FA + idempotent, no action-bound step-up'),
    'friendRoutes.js|PUT|/transfer/:id/fulfill': R(CLASS.CUSTOMER_GAP, 'fulfils a peer transfer request and moves funds; KYC gated, no step-up'),
    'azmGiftRoutes.js|POST|/send': R(CLASS.CUSTOMER_GAP, 'AZM gift to another user; idempotent, no action-bound step-up'),
    'conversationRoutes.js|POST|/:conversationId/messages/:messageId/fund-escrow': R(CLASS.CUSTOMER_GAP, 'funds escrow from a conversation; no action-bound step-up'),
    'conversationRoutes.js|POST|/:conversationId/messages/:messageId/release-escrow': R(CLASS.CUSTOMER_GAP, 'releases escrow from a conversation; no action-bound step-up'),
    'savingsRoutes.js|POST|/goals/:id/deposit': R(CLASS.CUSTOMER_GAP, 'savings deposit; fresh-rate + idempotent, no action-bound step-up'),
    'savingsRoutes.js|POST|/goals/:id/withdraw': R(CLASS.CUSTOMER_GAP, 'savings withdrawal; 2FA + fresh-rate + idempotent, no action-bound step-up'),
    'vaultRoutes.js|POST|/:id/deposit': R(CLASS.CUSTOMER_GAP, 'vault deposit; idempotent, no action-bound step-up'),
    'vaultRoutes.js|POST|/:id/break': R(CLASS.CUSTOMER_GAP, 'early vault break; 2FA + idempotent, no action-bound step-up'),
    'sharedVaultRoutes.js|POST|/:id/deposit': R(CLASS.CUSTOMER_GAP, 'shared-vault deposit; idempotent, no action-bound step-up'),
    'crossBorderSusuRoutes.js|POST|/contribute': R(CLASS.CUSTOMER_GAP, 'cross-border susu contribution; KYC + idempotent, no action-bound step-up'),
    'crossBorderSusuRoutes.js|POST|/payout': R(CLASS.CUSTOMER_GAP, 'cross-border susu payout; KYC + idempotent, no action-bound step-up'),
    'multiCurrencyRoutes.js|POST|/convert': R(CLASS.CUSTOMER_GAP, 'currency conversion; idempotent, no action-bound step-up'),
    'azmConversionRoutes.js|POST|/': R(CLASS.CUSTOMER_GAP, 'AZM→USDC conversion; idempotent, no action-bound step-up'),
    'orderBookRoutes.js|POST|/orders': R(CLASS.CUSTOMER_GAP, 'places an order and reserves balance; idempotent, no action-bound step-up'),
    'financeRoutes.js|POST|/withdraw/fiat': R(CLASS.CUSTOMER_GAP, 'legacy finance fiat withdrawal; KYC + 2FA + idempotent, no action-bound step-up'),
    'businessOSRoutes.js|POST|/ewa/withdraw': R(CLASS.CUSTOMER_GAP, 'EWA payout to an employee; no action-bound step-up'),
    'businessOSRoutes.js|POST|/finance/payout': R(CLASS.CUSTOMER_GAP, 'business payout; no action-bound step-up'),
    'businessOSRoutes.js|POST|/orders/:id/refund': R(CLASS.CUSTOMER_GAP, 'order refund moves funds back; no action-bound step-up'),
    'businessRoutes.js|POST|/invoices/:invoiceId/pay': R(CLASS.CUSTOMER_GAP, 'customer pays a business invoice; KYC(pay) gated, no action-bound step-up'),
    'storefrontRoutes.js|POST|/:businessProfileId/order': R(CLASS.CUSTOMER_GAP, 'storefront checkout; no action-bound step-up'),
    'storefrontCheckoutIntegrityRoutes.js|POST|/:businessProfileId/order': R(CLASS.CUSTOMER_GAP, 'storefront checkout (integrity variant); no action-bound step-up'),
    'dineInRoutes.js|POST|/tabs/:tabId/pay': R(CLASS.CUSTOMER_GAP, 'customer pays a dine-in tab; KYC(pay) + 2FA, no action-bound step-up'),
};

// ── scanner ──────────────────────────────────────────────────────────────────

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

/** Every mutation route in routes/*.js with the signals the guard needs. */
function scanRoutes(routesDir = ROUTES_DIR) {
    const rows = [];
    for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort()) {
        const lines = fs.readFileSync(path.join(routesDir, file), 'utf8').split('\n');
        const text = lines.join('\n');
        // Route-level gate variables: `const gate = whenStepUpEnforced(requireActionStepUp(...))`
        // is a WRAPPED gate; `const gate = requireActionStepUp(...)` is a bare one.
        const wrappedBound = new Set();
        const bareBound = new Set();
        for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(whenStepUpEnforced\()?\s*requireActionStepUp\(/g)) {
            (m[2] ? wrappedBound : bareBound).add(m[1]);
        }
        lines.forEach((line, index) => {
            const m = line.match(/\s*router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/);
            if (!m) return;
            const block = declarationText(lines, index);
            const inlineWrapped = /whenStepUpEnforced\(\s*requireActionStepUp\(/.test(block);
            const inlineBare = /(?<!whenStepUpEnforced\()\s*requireActionStepUp\(/.test(
                block.replace(/whenStepUpEnforced\(\s*requireActionStepUp\(/g, ''),
            );
            const usesWrapped = [...wrappedBound].some((b) => new RegExp(`\\b${b}\\b`).test(block));
            const usesBare = [...bareBound].some((b) => new RegExp(`\\b${b}\\b`).test(block));
            const gated = inlineWrapped || inlineBare || usesWrapped || usesBare;
            rows.push({
                file,
                method: m[1].toUpperCase(),
                route: m[2],
                gated,
                kyc: /requireKyc|requireKYC|kycGate/i.test(block),
                twofa: /require2FA|twoFactor/i.test(block),
                idem: /idempotency\(/.test(block),
                whenStepUpEnforced: inlineWrapped || usesWrapped,
                bareGate: inlineBare || usesBare,
            });
        });
    }
    return rows;
}

const keyOf = (row) => `${row.file}|${row.method}|${row.route}`;

function inScope(row) {
    if (EXPLICIT_SCOPE.some(([f, m, p]) => f === row.file && m === row.method && p === row.route)) return true;
    return MONEY_TERMS.some((t) => row.route.toLowerCase().includes(t));
}

/**
 * Classify the in-scope population.
 * @returns {{ rows, inScope, unclassified, registryMisses, byClass }}
 */
function classify(rows = scanRoutes()) {
    const scopeRows = rows.filter(inScope);
    const unclassified = [];
    const registryMisses = [];
    const byClass = Object.fromEntries(Object.values(CLASS).map((c) => [c, []]));
    const seen = new Set();

    for (const row of scopeRows) {
        const k = keyOf(row);
        seen.add(k);
        const entry = REGISTRY[k];
        if (!entry) { unclassified.push(k); continue; }
        byClass[entry.class].push({ ...row, reason: entry.reason });
    }
    for (const k of Object.keys(REGISTRY)) {
        if (!seen.has(k)) registryMisses.push(k);
    }
    return { rows, inScope: scopeRows, unclassified, registryMisses, byClass };
}

module.exports = {
    MONEY_TERMS, EXPLICIT_SCOPE, CLASS, REGISTRY,
    scanRoutes, classify, keyOf, inScope,
};

// ── doc generator ────────────────────────────────────────────────────────────
// `node scripts/step-up-route-inventory.js --write-doc` regenerates the
// published matrix from this module so the report and the guard can never
// disagree.

if (require.main === module) {
    const writeDoc = process.argv.includes('--write-doc');
    const result = classify();
    const counts = Object.fromEntries(
        Object.entries(result.byClass).map(([c, list]) => [c, list.length]),
    );

    if (!writeDoc) {
        console.log('in-scope routes:', result.inScope.length);
        console.log('by class:', JSON.stringify(counts));
        if (result.unclassified.length) console.log('UNCLASSIFIED:', result.unclassified);
        if (result.registryMisses.length) console.log('REGISTRY MISSES:', result.registryMisses);
        process.exit(result.unclassified.length || result.registryMisses.length ? 1 : 0);
    }

    const rowsFor = (cls) => result.byClass[cls]
        .slice()
        .sort((a, b) => (a.file + a.route).localeCompare(b.file + b.route))
        .map((r) => `| \`${r.file.replace(/Routes\.js$/, '')} ${r.method} ${r.route}\` | ${r.reason} |`)
        .join('\n');

    const doc = `# B5 — action-bound step-up and KYC route coverage (current state)

**Generated from source** by \`node scripts/step-up-route-inventory.js --write-doc\`
(\`scripts/step-up-route-inventory.js\` is the single source of truth; the static
guard \`__tests__/b5-step-up-route-coverage.test.js\` imports the same module).
Do not hand-edit this file — regenerate it.

**This document describes the state as it IS, not as it should be.** Scope is
every mutation route (POST/PUT/PATCH/DELETE) in \`routes/*.js\` whose path
matches a money term, plus an explicit list of value-moving routes whose paths
carry no money term (\`/ghs\`, \`/fiat\`, \`/initiate\`, \`/satisfy\`, \`/pay\`…).

**Measured population: ${result.inScope.length} in-scope routes.**

| class | count | meaning |
|---|---|---|
| GATED | ${counts.GATED} | carries \`whenStepUpEnforced(requireActionStepUp(...))\` |
| CUSTOMER_GAP | ${counts.CUSTOMER_GAP} | moves customer value, no gate — recorded gap, may only shrink |
| CUSTOMER_EXEMPT | ${counts.CUSTOMER_EXEMPT} | moves value; step-up not required, economic reason recorded |
| BUSINESS | ${counts.BUSINESS} | KYB-scoped business operator on their own business |
| OPERATOR | ${counts.OPERATOR} | admin/operator action — separate operator authorisation, never customer step-up |
| NON_VALUE | ${counts.NON_VALUE} | matches a money term, moves no value |
| WEBHOOK | ${counts.WEBHOOK} | provider callback; never customer-gated |

\`whenStepUpEnforced(...)\` is a no-op unless \`STEP_UP_ENFORCEMENT=on\`.
**\`STEP_UP_ENFORCEMENT\` is OFF**, so every gate below is dormant in production
today. This document does not change that flag and must not.

## 1. Gated today (${counts.GATED})

| route | action |
|---|---|
${rowsFor('GATED')}

Only the withdrawal path has a real end-to-end route proof (challenge → proof →
grant → exact retry → transaction consumption). The other gates are wired and
covered by the static guard and unit-level action binding; they are NOT proven
end-to-end by that withdrawal test, and this document does not claim they are.

## 2. Recorded customer coverage gaps (${counts.CUSTOMER_GAP})

Genuinely value-moving customer routes with no action-bound step-up. This list
is frozen by the guard: it may only shrink, and every entry carries the
economic reason it is still open.

| route | why it is a gap |
|---|---|
${rowsFor('CUSTOMER_GAP')}

## 3. Customer-exempt (${counts.CUSTOMER_EXEMPT})

| route | economic reason step-up is not required |
|---|---|
${rowsFor('CUSTOMER_EXEMPT')}

## 4. Business-operator routes (${counts.BUSINESS})

KYB-scoped business operators acting on their own business; membership and KYB
are the boundary, not customer step-up.

| route | reason |
|---|---|
${rowsFor('BUSINESS')}

## 5. Operator routes (${counts.OPERATOR})

Admin/operator actions. The brief forbids customer step-up here; these need
separate operator authorisation.

| route | reason |
|---|---|
${rowsFor('OPERATOR')}

## 6. Non-value matches (${counts.NON_VALUE})

| route | reason |
|---|---|
${rowsFor('NON_VALUE')}

## 7. Provider webhooks (${counts.WEBHOOK})

Settlement must never depend on a customer action.

| route | reason |
|---|---|
${rowsFor('WEBHOOK')}

## 8. What the guard enforces

1. Every in-scope route has exactly one classification; a NEW money route fails
   the build until it is gated or explicitly exempted with a reason.
2. Every recorded gate is still present, and every gate sits behind
   \`whenStepUpEnforced(...)\` so wiring cannot activate enforcement by accident.
3. The CUSTOMER_GAP population matches the frozen list exactly — it cannot grow.
4. Provider webhooks are never gated.
`;

    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'b5-step-up-route-matrix.md'), doc);
    console.log('wrote docs/b5-step-up-route-matrix.md');
    console.log('by class:', JSON.stringify(counts));
}
