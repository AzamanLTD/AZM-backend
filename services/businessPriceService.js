'use strict';
// =============================================================================
// BusinessPrice service — GHS listing-price authority (P1, 2026-10-10).
//
// Authority: docs/MARKETPLACE_GHS_PRICING_AND_PAYMENT_CONTRACT_2026-10-10.md
// §1.1 (Option B, owner-approved) and the finalized Mix decisions. Phase 1:
// schema + configuration-service validation, NO public surface. Discovery
// (P3) and checkout (P4/P6) consume this service; they do not bypass it.
//
// Invariants enforced HERE (application layer) and, where expressible, by the
// DATABASE (infra/install-business-price-overlay.js):
//   • One ACTIVE current row per (product, currency, scope, branch) — the
//     partial unique index is the authority; this service sequences writes so
//     the happy path never trips it, and a race fails closed (P2002).
//   • A base GHS price is POSITIVE — zero only under a separately approved
//     free-item model (none in v1). No inference from priceRange/priceUsdc
//     or any conversion: amounts arrive as source-backed strings.
//   • Exact-decimal discipline (the fiatLiquidityService.toExactGhsDecimal
//     pattern): pesewas arithmetic in BigInt, never binary floats; a JS
//     number is REJECTED as an authoritative input; sub-pesewa precision and
//     surrounding whitespace are rejected — the authority never rounds
//     silently.
//   • Only a BUSINESS or ADMIN confirmation (actor + timestamp) makes a price
//     ELIGIBLE. MIGRATION rows exist for the P2 backfill worklist and never
//     confer eligibility. resolveEffectiveGhsPrice is the single eligibility
//     gate — Mix/discovery must use it, never a raw query.
//   • Variants/modifierGroups keep their JSON shape; the optional
//     priceDeltaGhs entries are exact 2dp decimal STRINGS validated here,
//     independent of the USDC priceDelta (never converted into each other).
// =============================================================================

const { Prisma } = require('@prisma/client');

const GHS_DP = 2;
const PESAWE = 10n ** BigInt(GHS_DP);

const SCOPE_VALUES = ['DEFAULT', 'BRANCH'];
const CONFIRMED_BY_VALUES = ['BUSINESS', 'ADMIN', 'MIGRATION'];
const CURRENCY_VALUES = ['GHS'];

// v1 delta bounds (pesewas-equivalent in GHS exact strings below). Configuration
// point for a GlobalSettings migration later; module constants until then.
const GHS_DELTA_MIN_GHS = '-100000'; // a delta may fully discount, never below
const GHS_DELTA_MAX_GHS = '100000';

class BusinessPriceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BusinessPriceError';
        this.code = code;
    }
}

// ─── exact GHS decimals ──────────────────────────────────────────────────────
// Authoritative input is a STRING (or a Prisma.Decimal read back from the DB).
// A JS number is a binary float and is rejected outright — the test matrix pins
// `25` (number) and `0.1 + 0.2` as invalid inputs.

function isNegativeZeroString(s) {
    return /^-0(\.0+)?$/.test(s);
}

function parseGhsDecimal(value, { field = 'amountGhs', allowNegative = false, allowZero = true } = {}) {
    if (typeof value === 'number') {
        throw new BusinessPriceError('GHS_FLOAT_REJECTED',
            `[${field}] is a JS number — binary floating-point is never an authoritative GHS input: ${value}`);
    }
    if (value instanceof Prisma.Decimal) {
        value = value.toString();
    }
    if (typeof value !== 'string') {
        throw new BusinessPriceError('GHS_NOT_A_STRING',
            `[${field}] must be an exact 2dp decimal string: ${String(value)}`);
    }
    const s = value;
    if (s.trim() !== s || s.length === 0) {
        throw new BusinessPriceError('GHS_MALFORMED',
            `[${field}] has surrounding whitespace or is empty: "${s}"`);
    }
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
        throw new BusinessPriceError('GHS_SUB_PESAWEA',
            `[${field}] is not an exact 2dp decimal (sub-pesewa precision, malformed, or exponent): "${s}" — the authority never rounds silently`);
    }
    if (isNegativeZeroString(s)) {
        throw new BusinessPriceError('GHS_NEGATIVE_ZERO',
            `[${field}] is negative zero — a sign-ambiguous amount: "${s}"`);
    }
    const d = new Prisma.Decimal(s);
    if (!allowNegative && d.lt(0)) {
        throw new BusinessPriceError('GHS_NEGATIVE',
            `[${field}] must not be negative: "${s}"`);
    }
    return d;
}

// A base listing price: strictly positive. Zero awaits the separately
// approved free-item model (owner-decided: unsupported in GHS Mix v1).
function parseBaseGhsAmount(value, opts = {}) {
    const d = parseGhsDecimal(value, { field: opts.field || 'amountGhs', allowNegative: false });
    if (d.lte(0)) {
        throw new BusinessPriceError('GHS_BASE_NOT_POSITIVE',
            `[${opts.field || 'amountGhs'}] a base GHS price must be positive (free-item model is separately approved and not in v1): "${value}"`);
    }
    return d;
}

// Exact pesewas (BigInt) — the arithmetic unit for delta and final-price math.
function toPesewas(decimal) {
    const d = decimal instanceof Prisma.Decimal ? decimal : new Prisma.Decimal(String(decimal));
    if (d.decimalPlaces() > GHS_DP) {
        throw new BusinessPriceError('GHS_SUB_PESAWEA',
            `value carries sub-pesewa precision: ${d.toString()}`);
    }
    return BigInt(d.times(PESAWE.toString()).toFixed(0));
}

function pesewasToGhsString(pesewas) {
    const sign = pesewas < 0n ? '-' : '';
    const abs = pesewas < 0n ? -pesewas : pesewas;
    const whole = abs / PESAWE;
    const frac = abs % PESAWE;
    return `${sign}${whole}.${frac.toString().padStart(2, '0')}`;
}

// ─── variant/modifier priceDeltaGhs validation ──────────────────────────────
//
// The optional priceDeltaGhs entry on a variant/modifier option is an exact
// 2dp decimal STRING ("0", "5.00", "-1.50"). It is independent data from the
// USDC priceDelta — never converted into it. Bounds are enforced, and the
// final price of the worst-case selection (every negative delta selected) must
// be positive.

function validateGhsDeltas({ baseGhs, variants, modifierGroups }) {
    const base = parseBaseGhsAmount(baseGhs, { field: 'baseGhs' });
    const min = new Prisma.Decimal(GHS_DELTA_MIN_GHS);
    const max = new Prisma.Decimal(GHS_DELTA_MAX_GHS);

    const groups = [];
    if (variants !== undefined && variants !== null) groups.push(...(Array.isArray(variants) ? variants : []));
    if (modifierGroups !== undefined && modifierGroups !== null) groups.push(...(Array.isArray(modifierGroups) ? modifierGroups : []));

    let worstCase = toPesewas(base);
    for (const group of groups) {
        const options = Array.isArray(group?.options) ? group.options
            : Array.isArray(group?.values) ? group.values : [];
        for (const option of options) {
            const delta = option?.priceDeltaGhs;
            if (delta === undefined || delta === null) continue; // GHS deltas are opt-in per option
            const d = parseGhsDecimal(delta, { field: 'priceDeltaGhs', allowNegative: true });
            if (d.lt(min) || d.gt(max)) {
                throw new BusinessPriceError('GHS_DELTA_OUT_OF_BOUNDS',
                    `priceDeltaGhs "${d.toString()}" outside configured bounds [${GHS_DELTA_MIN_GHS}, ${GHS_DELTA_MAX_GHS}]`);
            }
            const p = toPesewas(d);
            if (p < 0n) worstCase += p; // worst case: every negative delta is selected
        }
    }
    if (worstCase <= 0n) {
        throw new BusinessPriceError('GHS_FINAL_PRICE_NOT_POSITIVE',
            `the worst-case selection (base + every negative delta) is not a positive price: ${pesewasToGhsString(worstCase)} GHS`);
    }
    return { basePesewas: toPesewas(base), worstCaseFinalPesewas: worstCase };
}

// ─── write path ─────────────────────────────────────────────────────────────

function assertScope(scope) {
    if (!SCOPE_VALUES.includes(scope)) {
        throw new BusinessPriceError('GHS_SCOPE_INVALID', `scope must be one of ${SCOPE_VALUES.join('|')}: ${scope}`);
    }
}

// Archives the current ACTIVE row for the identity, closing its effective
// window. Guarded so the CHECK (effectiveTo > effectiveFrom) can never trip
// on a just-created row: the window close is strictly later than effectiveFrom.
async function archiveCurrent(tx, { businessProductId, currency = 'GHS', scope = 'DEFAULT', locationId = null }) {
    const now = new Date();
    const current = await tx.businessPrice.findFirst({
        where: { businessProductId, currency, scope, locationId: locationId ?? null, status: 'ACTIVE', effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
    });
    if (!current) return null;
    let effectiveTo = now;
    if (effectiveTo.getTime() <= current.effectiveFrom.getTime()) {
        effectiveTo = new Date(current.effectiveFrom.getTime() + 1); // strictly later, always
    }
    return tx.businessPrice.update({
        where: { id: current.id },
        data: { status: 'ARCHIVED', effectiveTo },
    });
}

// Creates a new price row for the identity, archiving any current ACTIVE row
// in the same caller-owned transaction. confirmed=true requires a BUSINESS or
// ADMIN actor; MIGRATION rows enter unconfirmed (P2 backfill worklist) and
// NEVER carry eligibility.
async function setPrice(tx, {
    businessProductId, amountGhs, currency = 'GHS', scope = 'DEFAULT', locationId = null,
    confirmedByType = 'BUSINESS', confirmedById = null, note = null, confirm = true,
}) {
    if (!tx || typeof tx.businessPrice?.create !== 'function') {
        throw new BusinessPriceError('GHS_TX_REQUIRED', 'setPrice requires the caller-owned Prisma transaction client');
    }
    if (!CURRENCY_VALUES.includes(currency)) {
        throw new BusinessPriceError('GHS_CURRENCY_INVALID', `v1 accepts currency "GHS" only: ${currency}`);
    }
    assertScope(scope);
    if (scope === 'BRANCH' && !locationId) {
        throw new BusinessPriceError('GHS_BRANCH_NEEDS_LOCATION', 'BRANCH scope requires a locationId');
    }
    if (scope === 'DEFAULT' && locationId) {
        throw new BusinessPriceError('GHS_DEFAULT_NO_LOCATION', 'DEFAULT scope must have locationId null (all branches)');
    }
    const amount = parseBaseGhsAmount(amountGhs);
    if (!CONFIRMED_BY_VALUES.includes(confirmedByType)) {
        throw new BusinessPriceError('GHS_CONFIRMED_BY_INVALID', `confirmedByType must be one of ${CONFIRMED_BY_VALUES.join('|')}`);
    }
    if (confirm && !['BUSINESS', 'ADMIN'].includes(confirmedByType)) {
        throw new BusinessPriceError('GHS_MIGRATION_CANNOT_CONFIRM', 'MIGRATION rows never confirm into eligibility (P2 worklist confirms as BUSINESS/ADMIN)');
    }
    if (confirm && !confirmedById) {
        throw new BusinessPriceError('GHS_ACTOR_REQUIRED', 'confirmation requires an auditable actor id');
    }

    const product = await tx.businessProduct.findUnique({ where: { id: businessProductId }, select: { id: true, businessProfileId: true } });
    if (!product) {
        throw new BusinessPriceError('GHS_PRODUCT_UNKNOWN', `unknown BusinessProduct ${businessProductId}`);
    }

    await archiveCurrent(tx, { businessProductId, currency, scope, locationId });

    return tx.businessPrice.create({
        data: {
            businessProductId,
            currency,
            amountExact: amount.toFixed(2),
            scope,
            locationId: locationId ?? null,
            status: 'ACTIVE',
            confirmedByType,
            confirmedById: confirm ? confirmedById : null,
            confirmedAt: confirm ? new Date() : null,
            note,
        },
    });
}

// Confirms an existing unconfirmed ACTIVE row (P2 worklist action). Actor +
// timestamp are recorded — the audit trail the eligibility rule depends on.
async function confirmPrice(tx, { priceId, confirmedByType, confirmedById, note = null }) {
    if (!['BUSINESS', 'ADMIN'].includes(confirmedByType)) {
        throw new BusinessPriceError('GHS_CONFIRM_ACTOR_INVALID', 'confirmation requires confirmedByType BUSINESS or ADMIN');
    }
    if (!confirmedById) {
        throw new BusinessPriceError('GHS_ACTOR_REQUIRED', 'confirmation requires an auditable actor id');
    }
    const row = await tx.businessPrice.findUnique({ where: { id: priceId } });
    if (!row) throw new BusinessPriceError('GHS_PRICE_UNKNOWN', `unknown BusinessPrice ${priceId}`);
    if (row.status !== 'ACTIVE' || row.effectiveTo !== null) {
        throw new BusinessPriceError('GHS_PRICE_NOT_CURRENT', 'only the current ACTIVE row of an identity can be confirmed');
    }
    if (row.confirmedAt !== null) {
        return row; // idempotent: already confirmed — converge, never rewrite the audit trail
    }
    return tx.businessPrice.update({
        where: { id: priceId },
        data: { confirmedByType, confirmedById, confirmedAt: new Date(), note: note ?? row.note },
    });
}

// ─── resolution / eligibility ────────────────────────────────────────────────
//
// The v1 catalogue rule: the effective GHS price of an item is the single
// ACTIVE BusinessPrice row with currency=GHS, scope=DEFAULT, effectiveTo=null
// — AND a BUSINESS/ADMIN confirmation. MIGRATION rows never resolve. This is
// the ONLY eligibility gate; consumers (Mix discovery P3, checkout P4) must
// call it, never query BusinessPrice directly.

async function resolveEffectiveGhsPrice(client, businessProductId) {
    const rows = await client.businessPrice.findMany({
        where: {
            businessProductId,
            currency: 'GHS',
            scope: 'DEFAULT',
            status: 'ACTIVE',
            effectiveTo: null,
        },
        orderBy: { effectiveFrom: 'desc' },
    });
    const eligible = rows.filter((row) =>
        ['BUSINESS', 'ADMIN'].includes(row.confirmedByType) && row.confirmedAt !== null);
    if (eligible.length === 0) return null;
    if (eligible.length > 1) {
        // The partial unique index makes this impossible in a healthy database;
        // resolving anyway would pick a winner silently.
        throw new BusinessPriceError('GHS_CURRENT_PRICE_AMBIGUOUS',
            `multiple eligible current prices for product ${businessProductId} — the unique index is missing or the row set is corrupt`);
    }
    return eligible[0];
}

module.exports = {
    BusinessPriceError,
    parseGhsDecimal,
    parseBaseGhsAmount,
    toPesewas,
    pesewasToGhsString,
    validateGhsDeltas,
    setPrice,
    confirmPrice,
    resolveEffectiveGhsPrice,
    // closed domains exported for tests and future admin surfaces
    SCOPE_VALUES,
    CONFIRMED_BY_VALUES,
    CURRENCY_VALUES,
};
