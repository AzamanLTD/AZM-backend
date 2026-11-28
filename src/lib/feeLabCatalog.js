// src/lib/feeLabCatalog.js
// =============================================================================
// THE FEE LAB CATALOG — every point where Azaman charges, or could charge.
//
// Each point says, in plain words, what it is, when it is charged, who pays,
// when it is given back, and where its value lives. Each parameter names its
// TARGET, the place the app reads the value today:
//   { kind: 'globalSettings', field, scale: 'fraction' | 'usdc' }
//   { kind: 'globalSettingsJson', field, path }      (one entry of a JSON map)
//   { kind: 'feePolicy', key, cause }                (services/feeRefundPolicy)
//   { kind: 'none', reason }                         (modelled only)
// Only parameters with a real target can be published; publishing writes the
// target, so the app uses the new value at once (services/feeLabService).
//
// status: LIVE (charged today) | MODELED (not charged today: a proposal; the
// lab models it so the business case can be made, nothing can be published).
//
// Units: 'bps' integer basis points (100 = 1%); 'usdc' exact decimal string;
// 'policy' REFUND | KEEP. Roles: pct, flat, min, max (the fee rule), share
// (Azaman's share of the fee, when the fee is split), policy.
//
// volume: a VOLUME_SOURCES id; each source is SQL that yields one row per
// transaction with `amt` (USDC) and optionally `seg` (a segment, e.g. the
// payment method or the risk tier), between the period's dates.
// Sources were checked against prisma/schema.prisma (2026-11-28).
// =============================================================================

const { Prisma } = require('@prisma/client');

const FLOWS = Object.freeze([
    { id: 'MARKETPLACE', label: 'Marketplace & bookings' },
    { id: 'WALLET', label: 'Wallet: in, out and between people' },
    { id: 'P2P', label: 'P2P trading' },
    { id: 'SAVINGS', label: 'Savings & Susu' },
    { id: 'BUSINESS', label: 'Business tools' },
    { id: 'EXCHANGE', label: 'Exchange & currencies' },
]);

const pct = (key, label, target, extra = {}) => ({ key, label, unit: 'bps', role: 'pct', min: 0, max: 1000, target, ...extra });
const usdc = (key, label, role, target, extra = {}) => ({ key, label, unit: 'usdc', role, min: '0', max: '100', target, ...extra });
const gs = (field) => ({ kind: 'globalSettings', field, scale: 'fraction' });
const none = (reason) => ({ kind: 'none', reason });

const P2P_METHODS = ['ZELLE', 'CASHAPP', 'APPLE_PAY', 'GOOGLE_PAY', 'VENMO', 'PAYPAL', 'WISE', 'REVOLUT', 'WESTERN_UNION', 'WIRE_TRANSFER'];
const P2P_LABELS = {
    ZELLE: 'Zelle', CASHAPP: 'Cash App', APPLE_PAY: 'Apple Pay', GOOGLE_PAY: 'Google Pay', VENMO: 'Venmo',
    PAYPAL: 'PayPal', WISE: 'Wise', REVOLUT: 'Revolut', WESTERN_UNION: 'Western Union', WIRE_TRANSFER: 'Wire transfer',
};

const FEE_POINTS = Object.freeze([
    // ── Marketplace & bookings ──────────────────────────────────────────────
    {
        id: 'escrow.fee',
        flow: 'MARKETPLACE',
        name: 'Escrow and booking fee',
        status: 'LIVE',
        summary: 'Store orders paid with protection, hotel stays and transit seats paid in the app, and escrow deals.',
        when: 'When the customer pays: the fee is added on top of the price, and the price is held until delivery, check-in or boarding.',
        payer: 'Customer',
        refunds: [
            'The business cancels (hotel, operator, trip): the fee comes back (rule below).',
            'The customer cancels, does not show, or the booking lapses: the fee is kept.',
            'Escrow deals and store orders refunded through a dispute or expiry: the fee is kept.',
        ],
        params: [pct('fee.escrow.pct', 'Fee on the price', gs('smartEscrowFeePct'))],
        revenueSources: ['SMART_ESCROW_FEE'],
        volume: 'escrowFunded',
    },
    {
        id: 'escrow.refundRules',
        flow: 'MARKETPLACE',
        name: 'When the booking fee is given back',
        status: 'LIVE',
        summary: 'Applies to stays and seats paid in the app when the booking is refunded.',
        when: 'At the refund.',
        payer: '—',
        refunds: [],
        params: [
            { key: 'feeRefund.BUSINESS_CANCELLED', label: 'The business cancels', unit: 'policy', role: 'policy', target: { kind: 'feePolicy', key: 'feeRefund.BUSINESS_CANCELLED', cause: 'BUSINESS_CANCELLED' } },
            { key: 'feeRefund.CUSTOMER_CANCELLED', label: 'The customer cancels', unit: 'policy', role: 'policy', target: { kind: 'feePolicy', key: 'feeRefund.CUSTOMER_CANCELLED', cause: 'CUSTOMER_CANCELLED' } },
            { key: 'feeRefund.NO_SHOW', label: 'The customer does not show', unit: 'policy', role: 'policy', target: { kind: 'feePolicy', key: 'feeRefund.NO_SHOW', cause: 'NO_SHOW' } },
        ],
        revenueSources: [],
        volume: null,
    },
    {
        id: 'invoice.fee',
        flow: 'MARKETPLACE',
        name: 'Invoice and dine-in tab fee',
        status: 'LIVE',
        summary: 'A business invoice or a restaurant tab paid from the wallet (USDC invoices).',
        when: 'When the customer pays. The business pays it out of the payment, unless the customer chose to cover it.',
        payer: 'Business (or the customer, if they cover it)',
        refunds: ['Never: a paid invoice cannot be refunded in the app.'],
        params: [pct('fee.invoice.pct', 'Fee on the bill and tip', gs('businessInvoiceFeePct'))],
        revenueSources: ['BUSINESS_INVOICE_FEE'],
        volume: 'invoicesPaid',
    },
    {
        id: 'payout.commission',
        flow: 'MARKETPLACE',
        name: 'Commission on business payouts',
        status: 'MODELED',
        summary: 'A share of what a hotel, operator or store is paid when a held payment is released.',
        when: 'Would be charged at release (check-in, boarding, delivery confirmed).',
        payer: 'Business',
        refunds: ['Would follow the release: a refunded booking pays no commission.'],
        params: [pct('fee.payoutCommission.pct', 'Commission', none('The app does not take a commission at release yet.'), { modelDefault: 0 })],
        revenueSources: [],
        volume: 'escrowSettled',
    },
    {
        id: 'noShow.share',
        flow: 'MARKETPLACE',
        name: "Azaman's share of no-show penalties",
        status: 'MODELED',
        summary: 'Today the business keeps 100% of a no-show penalty.',
        when: 'Would be taken when a no-show penalty is charged.',
        payer: 'Business (out of the penalty)',
        refunds: [],
        params: [pct('fee.noShowShare.pct', 'Share of the penalty', none('Azaman takes no part of a no-show penalty today.'), { modelDefault: 0, max: 5000 })],
        revenueSources: [],
        volume: 'noShowPenalties',
    },

    // ── Wallet ──────────────────────────────────────────────────────────────
    {
        id: 'withdraw.momo',
        flow: 'WALLET',
        name: 'Cash-out to MoMo (exit fee)',
        status: 'LIVE',
        summary: 'Withdrawing to mobile money. The rate depends on the account\'s risk tier.',
        when: 'At the request, on top of the amount; earned when the provider confirms the payout.',
        payer: 'Customer',
        refunds: [
            'A failed or rejected payout: amount and fee both come back.',
            'A referred customer: half of the fee goes to the referrer.',
            'AZM points can cut the fee by 25%, 50% or 100%.',
        ],
        params: [
            pct('fee.withdrawMomo.STANDARD', 'Standard accounts', { kind: 'globalSettingsJson', field: 'withdrawalFeeByRiskTier', path: 'STANDARD' }, { segment: 'STANDARD' }),
            pct('fee.withdrawMomo.TRUSTED', 'Trusted accounts', { kind: 'globalSettingsJson', field: 'withdrawalFeeByRiskTier', path: 'TRUSTED' }, { segment: 'TRUSTED' }),
            pct('fee.withdrawMomo.HIGH_RISK', 'High-risk accounts', { kind: 'globalSettingsJson', field: 'withdrawalFeeByRiskTier', path: 'HIGH_RISK' }, { segment: 'HIGH_RISK' }),
        ],
        revenueSources: ['EXIT_FEE'],
        volume: 'momoWithdrawals',
        caveats: ['Booked exit-fee revenue includes the referrer\'s half; the projection counts the full fee.'],
    },
    {
        id: 'deposit.cedi',
        flow: 'WALLET',
        name: 'Cedi deposits (MoMo top-ups)',
        status: 'MODELED',
        summary: 'Today a cedi deposit converts at the live rate with no spread and no fee; Azaman absorbs the provider\'s fee.',
        when: 'Would be charged when the deposit lands.',
        payer: 'Customer',
        refunds: [],
        params: [
            pct('fee.depositCedi.spread', 'Spread on the rate', none('Cedi conversions use the live rate with no spread. The money-settings FX spreads are stored but not read by the app.'), { modelDefault: 0, max: 500 }),
            usdc('fee.depositCedi.flat', 'Flat fee per deposit', 'flat', none('Deposits charge no fee today.'), { modelDefault: '0', max: '5' }),
        ],
        revenueSources: [],
        volume: 'cediDeposits',
    },
    {
        id: 'transfer.people',
        flow: 'WALLET',
        name: 'Sending money to people',
        status: 'MODELED',
        summary: 'Transfers between Azaman users are free today.',
        when: 'Would be charged on each transfer.',
        payer: 'Sender',
        refunds: [],
        params: [
            pct('fee.transfer.pct', 'Fee on the amount', none('Transfers between people are free today.'), { modelDefault: 0, max: 300 }),
            usdc('fee.transfer.flat', 'Flat fee per transfer', 'flat', none('Transfers between people are free today.'), { modelDefault: '0', max: '2' }),
            usdc('fee.transfer.max', 'Cap per transfer', 'max', none('Transfers between people are free today.'), { modelDefault: null, max: '50' }),
        ],
        revenueSources: [],
        volume: 'peerTransfers',
    },
    {
        id: 'withdraw.crypto',
        flow: 'WALLET',
        name: 'Crypto withdrawal network charge',
        status: 'LIVE',
        summary: 'A pass-through of the network cost (0.05 MATIC at the market price), taken out of the amount sent.',
        when: 'At the request.',
        payer: 'Customer',
        refunds: ['A withdrawal that fails before it is broadcast: everything comes back.'],
        params: [usdc('fee.cryptoGas.flat', 'Charge per withdrawal (about)', 'flat', none('Set in code from the network price, not a setting.'), { modelDefault: '0.0275', max: '5' })],
        revenueSources: ['GAS_FEE_REVENUE'],
        volume: 'cryptoWithdrawals',
        caveats: ['The real network cost is not recorded, so this is gross, not profit.'],
    },
    {
        id: 'withdraw.walletPlatform',
        flow: 'WALLET',
        name: 'Wallet withdrawal platform fee',
        status: 'LIVE',
        summary: 'A percentage on POST /api/wallet/withdraw. It is set to 0% today.',
        when: 'At the request, taken out of the amount.',
        payer: 'Customer',
        refunds: ['An admin rejection returns the full amount; the fee bookkeeping on that path is unclear.'],
        params: [pct('fee.walletPlatform.pct', 'Fee on the amount', none('Turning this above 0% would break these withdrawals today: the profit log has no source for it (CRYPTO_WITHDRAWAL_FEE is not in the enum). Fix that first.'), { modelDefault: 0 })],
        revenueSources: [],
        volume: null,
        caveats: ['Do not raise this from the old Fee Engine either until the profit-source bug is fixed.'],
    },

    // ── P2P ─────────────────────────────────────────────────────────────────
    {
        id: 'p2p.fee',
        flow: 'P2P',
        name: 'P2P trade fee',
        status: 'LIVE',
        summary: 'A percentage of each completed trade, set per payment method. Part of it goes to the vendor.',
        when: 'When the trade completes (including an admin force-release).',
        payer: 'Whoever receives the USDC',
        refunds: ['Cancelled, expired or disputed trades are not charged.'],
        params: [
            ...P2P_METHODS.map((m) => pct(`fee.p2p.${m}`, P2P_LABELS[m], { kind: 'globalSettingsJson', field: 'feeByPaymentMethod', path: m }, { segment: m })),
            pct('fee.p2p.default', 'Other methods', gs('p2pFeePct'), {
                segment: '*',
                caveat: 'Used only for a method without its own rate, and only when no Fee Profile matches the trade.',
            }),
            pct('fee.p2p.azamanShare', "Azaman's share of the fee", none('The split is set in Fee Profiles (default 60% to Azaman, 40% to the vendor).'), { role: 'share', modelDefault: 6000, max: 10000 }),
        ],
        revenueSources: ['P2P_MARGIN'],
        volume: 'p2pTrades',
    },

    // ── Savings & Susu ──────────────────────────────────────────────────────
    {
        id: 'susu.fee',
        flow: 'SAVINGS',
        name: 'Susu cycle fee',
        status: 'LIVE',
        summary: 'A percentage of the pooled contributions, taken from the payout.',
        when: 'When a cycle pays out.',
        payer: 'The member being paid out',
        refunds: ['Never.'],
        params: [pct('fee.susu.pct', 'Fee on the pool', gs('susuProfitPct'))],
        revenueSources: ['SUSU_FEE'],
        volume: 'susuPayouts',
    },
    {
        id: 'vault.breakEarly',
        flow: 'SAVINGS',
        name: 'Vault early-break penalty',
        status: 'LIVE',
        summary: 'Breaking a locked vault early costs 5% of the balance.',
        when: 'When the vault is broken early.',
        payer: 'Saver',
        refunds: ['Never.'],
        params: [pct('fee.vaultBreak.pct', 'Penalty', none('Each vault stores its own rate (5% for every vault today); there is no global setting.'), { modelDefault: 500 })],
        revenueSources: ['SAVINGS_FEE'],
        volume: 'vaultBreaks',
    },
    {
        id: 'savings.earlyWithdrawal',
        flow: 'SAVINGS',
        name: 'Savings goal early-withdrawal penalty',
        status: 'LIVE',
        summary: 'Withdrawing from a locked goal before it matures costs 2%.',
        when: 'At the withdrawal.',
        payer: 'Saver',
        refunds: ['Never.'],
        params: [pct('fee.savingsEarly.pct', 'Penalty', none('Each goal stores its own rate (2% for every goal today); there is no global setting.'), { modelDefault: 200 })],
        revenueSources: ['SAVINGS_FEE'],
        volume: null,
    },

    // ── Business tools ──────────────────────────────────────────────────────
    {
        id: 'ewa.fee',
        flow: 'BUSINESS',
        name: 'Early wage access fee',
        status: 'LIVE',
        summary: 'An employee draws earned wages early; 1% is taken from what they receive.',
        when: 'At the draw.',
        payer: 'Employee',
        refunds: ['Never.'],
        params: [pct('fee.ewa.pct', 'Fee on the draw', none('A constant in the code (ewaService EWA_FEE_RATE), not a setting.'), { modelDefault: 100 })],
        revenueSources: ['EWA_FEE'],
        volume: 'ewaDraws',
    },
    {
        id: 'payroll.fee',
        flow: 'BUSINESS',
        name: 'Payroll disbursements',
        status: 'MODELED',
        summary: 'Paying staff through Azaman is free today.',
        when: 'Would be charged per disbursement.',
        payer: 'Business',
        refunds: [],
        params: [pct('fee.payroll.pct', 'Fee on the payroll', none('Payroll is free today.'), { modelDefault: 0, max: 300 })],
        revenueSources: [],
        volume: 'payroll',
    },
    {
        id: 'business.plan',
        flow: 'BUSINESS',
        name: 'Business plan (monthly)',
        status: 'MODELED',
        summary: 'A monthly subscription for businesses on Azaman. There are no plans today.',
        when: 'Would be charged monthly.',
        payer: 'Business',
        refunds: [],
        cadence: 'monthly',
        params: [usdc('fee.businessPlan.flat', 'Price per business per month', 'flat', none('There are no business plans today.'), { modelDefault: '0', max: '500' })],
        revenueSources: [],
        volume: 'activeBusinesses',
    },

    // ── Exchange & currencies ───────────────────────────────────────────────
    {
        id: 'orderbook.fees',
        flow: 'EXCHANGE',
        name: 'AZM/USDC order book fees',
        status: 'LIVE',
        summary: 'Maker 0.2% and taker 0.5%, both taken from whoever receives the USDC.',
        when: 'On each match.',
        payer: 'Whoever receives the USDC',
        refunds: ['Never.'],
        params: [pct('fee.orderbook.pct', 'Maker + taker', none('Constants in the code (orderBookController MAKER_FEE, TAKER_FEE).'), { modelDefault: 70 })],
        revenueSources: [],
        volume: 'orderBookTrades',
        caveats: ['Not in the profit log: it reaches the treasury but shows in no revenue report.'],
    },
    {
        id: 'fx.multiCurrency',
        flow: 'EXCHANGE',
        name: 'Multi-currency conversion spread',
        status: 'LIVE',
        summary: 'Converting between currency wallets applies a 1.5% spread.',
        when: 'At the conversion.',
        payer: 'Customer',
        refunds: [],
        params: [pct('fee.fxMulti.pct', 'Spread', none('A constant in the code (multiCurrencyController FX_SPREAD).'), { modelDefault: 150 })],
        revenueSources: [],
        volume: null,
        caveats: ['Charged but booked nowhere: the spread leaves the customer and reaches no Azaman account.'],
    },
    {
        id: 'fx.crossBorderSusu',
        flow: 'EXCHANGE',
        name: 'Cross-border Susu conversion fee',
        status: 'LIVE',
        summary: 'Contributing to a Susu in another currency applies 0.5%.',
        when: 'At the contribution.',
        payer: 'Member',
        refunds: [],
        params: [pct('fee.fxCrossSusu.pct', 'Fee', none('A constant in the code (crossBorderSusuController CROSS_BORDER_FEE).'), { modelDefault: 50 })],
        revenueSources: [],
        volume: null,
        caveats: ['Charged but booked nowhere: recorded only on the FX snapshot.'],
    },
]);

// ── volume sources ───────────────────────────────────────────────────────────
// Each yields rows with `amt` (USDC, positive) and optionally `seg`.
const VOLUME_SOURCES = Object.freeze({
    escrowFunded: { sql: (from, to) => Prisma.sql`
        SELECT "amountUsdc" AS amt FROM "SmartEscrow"
        WHERE "fundedAt" >= ${from} AND "fundedAt" < ${to}` },
    escrowSettled: { sql: (from, to) => Prisma.sql`
        SELECT "amountUsdc" AS amt FROM "SmartEscrow"
        WHERE "status" IN ('SETTLED', 'RELEASED') AND "settledAt" >= ${from} AND "settledAt" < ${to}` },
    invoicesPaid: { sql: (from, to) => Prisma.sql`
        SELECT ("billTotalUsdc" + COALESCE("tipUsdc", 0)) AS amt FROM "BusinessInvoice"
        WHERE "status" = 'PAID' AND "paidAt" >= ${from} AND "paidAt" < ${to}` },
    noShowPenalties: { sql: (from, to) => Prisma.sql`
        SELECT "penaltyAmountUsdc" AS amt FROM "Reservation"
        WHERE "penaltyChargedAt" >= ${from} AND "penaltyChargedAt" < ${to}
        UNION ALL
        SELECT "penaltyAmountUsdc" AS amt FROM "TransitBooking"
        WHERE "penaltyChargedAt" >= ${from} AND "penaltyChargedAt" < ${to}` },
    momoWithdrawals: { segmented: true, sql: (from, to) => Prisma.sql`
        SELECT ABS(th."amountUsdc") AS amt, u."withdrawalRiskTier" AS seg
        FROM "TransactionHistory" th JOIN "User" u ON u."id" = th."userId"
        WHERE th."type" = 'WITHDRAWAL_FIAT' AND th."status" = 'COMPLETED'
          AND th."createdAt" >= ${from} AND th."createdAt" < ${to}` },
    cediDeposits: { sql: (from, to) => Prisma.sql`
        SELECT ABS("amountUsdc") AS amt FROM "TransactionHistory"
        WHERE "type" = 'DEPOSIT_FIAT' AND "status" = 'COMPLETED'
          AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    peerTransfers: { sql: (from, to) => Prisma.sql`
        SELECT "amount" AS amt FROM "PeerTransfer"
        WHERE "status" = 'COMPLETED' AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    cryptoWithdrawals: { sql: (from, to) => Prisma.sql`
        SELECT ABS("amountUsdc") AS amt FROM "TransactionHistory"
        WHERE "type" = 'WITHDRAWAL_CRYPTO' AND "status" = 'COMPLETED'
          AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    p2pTrades: { segmented: true, sql: (from, to) => Prisma.sql`
        SELECT "amountCrypto" AS amt, UPPER(regexp_replace("paymentMethod", '[[:space:]-]', '_', 'g')) AS seg
        FROM "Trade"
        WHERE "status" = 'COMPLETED' AND "completedAt" >= ${from} AND "completedAt" < ${to}` },
    susuPayouts: { sql: (from, to) => Prisma.sql`
        SELECT ("payoutAmount" + COALESCE("feeUsdc", 0)) AS amt FROM "SusuCycle"
        WHERE "paidOutAt" >= ${from} AND "paidOutAt" < ${to}` },
    vaultBreaks: { sql: (from, to) => Prisma.sql`
        SELECT (ABS("amountUsdc") + "feeUsdc") AS amt FROM "TransactionHistory"
        WHERE "type" = 'VAULT_RELEASE' AND "feeUsdc" > 0
          AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    ewaDraws: { sql: (from, to) => Prisma.sql`
        SELECT (ABS("amountUsdc") + "feeUsdc") AS amt FROM "TransactionHistory"
        WHERE "type" = 'EWA_WITHDRAWAL' AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    payroll: { sql: (from, to) => Prisma.sql`
        SELECT ABS("amountUsdc") AS amt FROM "TransactionHistory"
        WHERE "type" = 'PAYROLL_DISBURSEMENT' AND "createdAt" >= ${from} AND "createdAt" < ${to}` },
    // One row per active business: the plan is a flat fee per business per
    // month (cadence monthly), so the period does not scale it.
    activeBusinesses: { sql: () => Prisma.sql`
        SELECT 1::numeric AS amt FROM "BusinessProfile" WHERE "isSuspended" = false` },
    orderBookTrades: { sql: (from, to) => Prisma.sql`
        SELECT ("price" * "quantity") AS amt FROM "OrderBookTrade"
        WHERE "createdAt" >= ${from} AND "createdAt" < ${to}` },
});

const _byKey = new Map();
for (const p of FEE_POINTS) for (const x of p.params) _byKey.set(x.key, x);

const PUBLISHABLE_KINDS = new Set(['globalSettings', 'globalSettingsJson', 'feePolicy']);
const isPublishable = (param) => Boolean(param && param.target && PUBLISHABLE_KINDS.has(param.target.kind));
const paramByKey = (key) => _byKey.get(key) || null;

const _targetLabel = (t) => {
    if (!t) return null;
    if (t.kind === 'globalSettings') return `GlobalSettings.${t.field}`;
    if (t.kind === 'globalSettingsJson') return `GlobalSettings.${t.field}.${t.path}`;
    if (t.kind === 'feePolicy') return `Fee policy ${t.key}`;
    return null;
};

/** What the portal sees of a point (no SQL, no internals). */
const publicPoint = (p) => ({
    id: p.id, flow: p.flow, name: p.name, status: p.status, summary: p.summary, when: p.when,
    payer: p.payer, refunds: p.refunds || [], caveats: p.caveats || [], revenueSources: p.revenueSources || [],
    cadence: p.cadence || 'per-transaction', hasVolume: Boolean(p.volume),
});
const publicParam = (x) => ({
    key: x.key, label: x.label, unit: x.unit, role: x.role, segment: x.segment || null,
    min: x.min ?? null, max: x.max ?? null,
    publishable: isPublishable(x),
    notPublishableReason: isPublishable(x) ? null : (x.target && x.target.reason) || 'Modelled only.',
    writesTo: _targetLabel(x.target),
    caveat: x.caveat || null,
});

module.exports = { FLOWS, FEE_POINTS, VOLUME_SOURCES, paramByKey, isPublishable, publicPoint, publicParam, P2P_METHODS };
