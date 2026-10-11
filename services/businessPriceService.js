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

// INTENTIONALLY STRICTER V1 RULE (documented, tested): the worst case assumes
// EVERY negative delta across EVERY option of EVERY group applies
// simultaneously — even options that are mutually exclusive within one
// variant group, and even beyond a modifier group's `max` selection count.
// Selectable-aware minimum-price math (per-group single selection for
// variants, `max`-bounded selection for modifier groups) is deferred to a
// future, separately reviewed version; until then configurations whose
// true selectable worst case is positive may still be rejected as too
// conservative — this NEVER under-rejects, never loosens the
// positive-final-price invariant, and never uses floating-point arithmetic.
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

    // BRANCH tenant integrity: a branch price may name only a REAL location of
    // the product's OWN business. Arbitrary location ids are rejected here
    // (the DB CHECK enforces the scope/location shape; this verifies the
    // branch exists and belongs to the same businessProfileId). BRANCH prices
    // are still not consumed by the v1 resolver (schema-ready only).
    if (scope === 'BRANCH') {
        const location = await tx.businessLocation.findUnique({
            where: { id: locationId },
            select: { id: true, businessProfileId: true },
        });
        if (!location) {
            throw new BusinessPriceError('GHS_BRANCH_UNKNOWN', `BRANCH scope requires an existing BusinessLocation: unknown location ${locationId}`);
        }
        if (location.businessProfileId !== product.businessProfileId) {
            throw new BusinessPriceError('GHS_BRANCH_WRONG_BUSINESS',
                `BRANCH location ${locationId} belongs to businessProfile ${location.businessProfileId}, not the product's businessProfile ${product.businessProfileId} — cross-tenant branch prices are rejected`);
        }
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
// Confirms an existing unconfirmed ACTIVE row (P2 worklist action) as a
// SINGLE-WINNER compare-and-set: the UPDATE itself carries the precondition
// (ACTIVE, current, unconfirmed), so the database — not a read-then-write
// sequence — decides the winner. A concurrent caller can never overwrite the
// winning actor, timestamp or note: the CAS loser rereads the committed
// authoritative row and converges on it. A retry (idempotent replay) returns
// the committed row unchanged — the audit trail is written exactly once.
async function confirmPrice(tx, { priceId, confirmedByType, confirmedById, note = null }) {
    if (!['BUSINESS', 'ADMIN'].includes(confirmedByType)) {
        throw new BusinessPriceError('GHS_CONFIRM_ACTOR_INVALID', 'confirmation requires confirmedByType BUSINESS or ADMIN');
    }
    if (!confirmedById) {
        throw new BusinessPriceError('GHS_ACTOR_REQUIRED', 'confirmation requires an auditable actor id');
    }
    if (!tx || typeof tx.businessPrice?.updateMany !== 'function') {
        throw new BusinessPriceError('GHS_TX_REQUIRED', 'confirmPrice requires the caller-owned Prisma transaction client');
    }
    // The CAS: one statement, one winner. updateMany blocks on the row lock and
    // re-evaluates the precondition against the committed row version, so a
    // concurrent confirmation that committed first makes this return 0.
    const cas = await tx.businessPrice.updateMany({
        where: { id: priceId, status: 'ACTIVE', effectiveTo: null, confirmedAt: null },
        data: {
            confirmedByType,
            confirmedById,
            confirmedAt: new Date(),
            ...(note != null ? { note } : {}), // no note passed → the existing audit note is preserved
        },
    });
    if (cas.count === 1) {
        return tx.businessPrice.findUniqueOrThrow({ where: { id: priceId } }); // the committed authoritative row
    }
    // CAS lost (or the row is in a non-confirmable state): reread and converge
    // on the committed truth. Never a second write.
    const row = await tx.businessPrice.findUnique({ where: { id: priceId } });
    if (!row) throw new BusinessPriceError('GHS_PRICE_UNKNOWN', `unknown BusinessPrice ${priceId}`);
    if (row.status !== 'ACTIVE' || row.effectiveTo !== null) {
        throw new BusinessPriceError('GHS_PRICE_NOT_CURRENT', 'only the current ACTIVE row of an identity can be confirmed');
    }
    if (row.confirmedAt !== null) {
        return row; // a concurrent caller won the CAS — converge on its actor + timestamp, never rewrite
    }
    // Unreachable in a healthy database (the CAS where clause matched nothing
    // while the row still satisfies it): fail closed rather than retry-write.
    throw new BusinessPriceError('GHS_CONFIRM_CAS_INCONSISTENT',
        `confirmPrice CAS lost but the row remains unconfirmed for ${priceId} — reread and retry in a new transaction`);
}

// ─── resolution / eligibility ────────────────────────────────────────────────
//
// The v1 catalogue rule: the effective GHS price of an item is the single
// ACTIVE BusinessPrice row with currency=GHS, scope=DEFAULT, locationId
// NULL (the global identity), effectiveTo=null — AND a BUSINESS/ADMIN
// confirmation, AND effectiveFrom at or before the resolution instant.
// MIGRATION rows never resolve. SCHEDULED FUTURE PRICES ARE NOT SUPPORTED
// in v1: setPrice never accepts an effectiveFrom (it stamps now), and the
// resolver refuses to serve a future-dated current row (fail closed) so a
// malformed row can never be exposed early nor silently hide the identity.
// This is the ONLY eligibility gate; consumers (Mix discovery P3, checkout
// P4) must call it, never query BusinessPrice directly.

async function resolveEffectiveGhsPrice(client, businessProductId) {
    const rows = await client.businessPrice.findMany({
        where: {
            businessProductId,
            currency: 'GHS',
            scope: 'DEFAULT',
            locationId: null, // the GLOBAL identity only — a malformed row (DEFAULT with a location) must never resolve as the global price
            status: 'ACTIVE',
            effectiveTo: null,
        },
        orderBy: { effectiveFrom: 'desc' },
    });
    // v1 contract: NO scheduled future pricing. A price is never exposed
    // before its effective start. setPrice always stamps effectiveFrom = now,
    // so a current row with effectiveFrom in the future can only exist via a
    // raw write or clock skew — serving it would silently expose a scheduled
    // price this contract does not support, so the resolver FAILS CLOSED.
    const now = new Date();
    const confirmed = rows.filter((row) =>
        ['BUSINESS', 'ADMIN'].includes(row.confirmedByType) && row.confirmedAt !== null);
    const eligible = confirmed.filter((row) => row.effectiveFrom.getTime() <= now.getTime());
    const futureDated = confirmed.filter((row) => row.effectiveFrom.getTime() > now.getTime());
    if (futureDated.length > 0 && eligible.length === 0) {
        throw new BusinessPriceError('GHS_FUTURE_DATED_CURRENT_PRICE',
            `current price for product ${businessProductId} is scheduled for the future (${futureDated[0].effectiveFrom.toISOString()}) — scheduled pricing is not supported in v1; refusing to serve or hide it silently`);
    }
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
