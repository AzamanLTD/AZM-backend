// src/lib/moneySettingsContract.js
// =============================================================================
// CANONICAL MONEY-SETTINGS CONTRACT (backend authority).
//
// This mirrors the Admin Portal's src/lib/moneySettingsContract.js deliberately:
// the portal must never be the only place a bound exists, because a backend that
// accepts 0.5 seconds would let a client-side check be the sole control. Where
// the two disagree, THIS file wins and the portal is the thing to fix.
//
// Design constraints that drove it:
//
//  • No binary floats. Every money value is a CANONICAL DECIMAL STRING carried
//    verbatim into storage ("12.50", never 12.5 as a double). Basis points and
//    TTLs are integers. A float that round-trips to 12.499999 would silently
//    change a threshold the owner set.
//  • The legacy /api/admin/settings controller coerces with Number(...). That
//    path is untouched and must not be reused: it cannot round-trip an exact
//    GHS amount and it happily turns "1e3" into 1000.
//  • Aliases are resolved, never stored. One canonical spelling per setting.
// =============================================================================

/** Canonical keys — Money Contract Part 4 §8 names. */
const MONEY_SETTING_KEYS = Object.freeze([
    'quoteTtl.payment_topup',
    'quoteTtl.bucket_convert',
    'fxSpread.CONVERT_GHS_TO_USDC',
    'fxSpread.CONVERT_USDC_TO_GHS',
    'fxSpread.PAYMENT_TOPUP_GHS_FROM_USDC',
    'fxSpread.PAYMENT_TOPUP_USDC_FROM_GHS',
    'stepUpThresholdGhs',
    'balanceHeadlineMode',
]);

/**
 * Part 5 §1-E spellings, mapped onto canonical keys. Accepted on write and
 * resolved on read so an older caller cannot create a second stored spelling.
 */
const LEGACY_KEY_ALIASES = Object.freeze({
    'fxSpread.payment_topup.GHS_USDC': 'fxSpread.PAYMENT_TOPUP_GHS_FROM_USDC',
    'fxSpread.payment_topup.USDC_GHS': 'fxSpread.PAYMENT_TOPUP_USDC_FROM_GHS',
});

const MONEY_SETTINGS_VIEW_PERMISSION = 'money.settings.view';
const MONEY_SETTINGS_WRITE_PERMISSION = 'money.settings.write';

/** Whole seconds, inclusive. */
const QUOTE_TTL = Object.freeze({ min: 10, max: 900 });
const QUOTE_TTL_DEFAULTS = Object.freeze({
    'quoteTtl.payment_topup': 45,
    'quoteTtl.bucket_convert': 60,
});

/** Integer basis points; 0–10% inclusive. */
const FX_SPREAD = Object.freeze({ min: 0, max: 1000 });

/**
 * GHS threshold floor is exactly 0.00, which is meaningful: "always step up".
 *
 * The ceiling is DELIBERATELY BOUNDED rather than unbounded. The brief allowed
 * either, and bounded is the safer reading: an unbounded decimal is an unbounded
 * database row and an unbounded comparison. 1e9 GHS is far above any plausible
 * platform threshold, so this cannot refuse a real operational value, while it
 * does stop a typo (or an injected exponent) from becoming an absurdity.
 */
const STEP_UP_THRESHOLD = Object.freeze({
    min: '0.00',
    max: '1000000000.00',
    maxInclusive: true,
});

const HEADLINE_MODES = Object.freeze(['COMBINED_ESTIMATE', 'NATIVE_ONLY']);

/**
 * Owner decision D1, already resolved. Treated as a protected, owner-resolved
 * value: the ordinary money.settings.write permission must NOT be able to
 * reverse it, because a decision that any finance admin can flip is not a
 * decision. Changing it requires a separate owner procedure, deliberately not
 * exposed through this API.
 */
const OWNER_RESOLVED_KEY = 'balanceHeadlineMode';
const OWNER_RESOLVED_VALUE = 'COMBINED_ESTIMATE';

const SETTING_KINDS = Object.freeze({
    'quoteTtl.payment_topup': 'int',
    'quoteTtl.bucket_convert': 'int',
    'fxSpread.CONVERT_GHS_TO_USDC': 'bps',
    'fxSpread.CONVERT_USDC_TO_GHS': 'bps',
    'fxSpread.PAYMENT_TOPUP_GHS_FROM_USDC': 'bps',
    'fxSpread.PAYMENT_TOPUP_USDC_FROM_GHS': 'bps',
    stepUpThresholdGhs: 'ghs',
    balanceHeadlineMode: 'enum',
});

const BOUNDS = Object.freeze({
    'quoteTtl.payment_topup': QUOTE_TTL,
    'quoteTtl.bucket_convert': QUOTE_TTL,
    'fxSpread.CONVERT_GHS_TO_USDC': FX_SPREAD,
    'fxSpread.CONVERT_USDC_TO_GHS': FX_SPREAD,
    'fxSpread.PAYMENT_TOPUP_GHS_FROM_USDC': FX_SPREAD,
    'fxSpread.PAYMENT_TOPUP_USDC_FROM_GHS': FX_SPREAD,
    stepUpThresholdGhs: STEP_UP_THRESHOLD,
    balanceHeadlineMode: { values: HEADLINE_MODES },
});

/** Read-only rollout flags. There is no writer for these anywhere in this API. */
const READ_ONLY_FLAGS = Object.freeze([
    'nativeGhsSettlementEnabled',
    'nativeGhsWithdrawalEnabled',
    'fiatLiquidityAuthorityEnabled',
    'modelBSettlementEnabled',
]);

/** Typed refusal codes. Callers must branch on these, not on message text. */
const CODES = Object.freeze({
    UNKNOWN_KEY: 'MONEY_SETTING_UNKNOWN_KEY',
    INVALID_VALUE: 'MONEY_SETTING_INVALID_VALUE',
    OUT_OF_BOUNDS: 'MONEY_SETTING_OUT_OF_BOUNDS',
    REASON_REQUIRED: 'MONEY_SETTING_REASON_REQUIRED',
    OWNER_RESOLVED: 'MONEY_SETTING_OWNER_RESOLVED',
    UNKNOWN_ROLLOUT_FLAG: 'MONEY_SETTING_UNKNOWN_ROLLOUT_FLAG',
});

/**
 * Canonical decimal: digits, optional single dot, one or two decimals (pesewa
 * precision). No sign, no exponent, no thousands separators, no leading '+'.
 */
const GHS_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Resolve an alias or canonical key. Returns null for anything unknown. */
function canonicalKey(rawKey) {
    const key = String(rawKey == null ? '' : rawKey).trim();
    if (!key) return null;
    if (MONEY_SETTING_KEYS.includes(key)) return key;
    if (Object.prototype.hasOwnProperty.call(LEGACY_KEY_ALIASES, key)) {
        return LEGACY_KEY_ALIASES[key];
    }
    return null;
}

function isOwnerResolved(key) {
    return key === OWNER_RESOLVED_KEY;
}

/**
 * Compare two canonical decimal strings exactly, without floats.
 * Returns -1 / 0 / 1. Both sides must already match GHS_PATTERN.
 */
function compareDecimalStrings(a, b) {
    const split = (s) => {
        const [i, f = ''] = String(s).split('.');
        // Normalise pesewa to two digits so "1.5" and "1.50" compare equal.
        return { int: i.replace(/^0+(?=\d)/, ''), frac: (f + '00').slice(0, 2) };
    };
    const x = split(a);
    const y = split(b);
    if (x.int.length !== y.int.length) return x.int.length < y.int.length ? -1 : 1;
    if (x.int !== y.int) return x.int < y.int ? -1 : 1;
    if (x.frac === y.frac) return 0;
    return x.frac < y.frac ? -1 : 1;
}

/** Normalise a validated GHS value to exactly two decimal places. */
function canonicaliseGhs(value) {
    const [i, f = ''] = String(value).split('.');
    const int = i.replace(/^0+(?=\d)/, '') || '0';
    return `${int}.${(f + '00').slice(0, 2)}`;
}

function invalid(code, message, detail) {
    return { ok: false, code, message, detail: detail || null };
}

/**
 * Validate a proposed value for a canonical key.
 *
 * @returns {{ok:true, kind:string, valueInt?:number, valueText?:string, valueEnum?:string, canonical:string}}
 *        | {{ok:false, code:string, message:string, detail?:object|null}}
 *
 * Deliberately strict about the *shape* of a number: "1e3", " 5 ", "5.5" for an
 * integer and "-1" are all refused rather than coerced. A coerced money value is
 * how a threshold becomes something nobody chose.
 */
function validateValue(key, rawValue) {
    const kind = SETTING_KINDS[key];
    if (!kind) return invalid(CODES.UNKNOWN_KEY, `Unknown money setting: ${key}`);

    if (rawValue === undefined || rawValue === null) {
        return invalid(CODES.INVALID_VALUE, `A value is required for ${key}`);
    }

    if (kind === 'int' || kind === 'bps') {
        // Accept a JSON number only when it is already an integer; accept a
        // string only when it is pure digits. Everything else is refused.
        let n;
        if (typeof rawValue === 'number') {
            if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue)) {
                return invalid(CODES.INVALID_VALUE, `${key} must be an integer (no fractions)`);
            }
            n = rawValue;
        } else if (typeof rawValue === 'string') {
            const s = rawValue.trim();
            if (!/^\d+$/.test(s)) {
                return invalid(CODES.INVALID_VALUE, `${key} must be a whole number written as digits`);
            }
            n = Number(s);
            if (!Number.isSafeInteger(n)) {
                return invalid(CODES.INVALID_VALUE, `${key} is too large to be a safe integer`);
            }
        } else {
            return invalid(CODES.INVALID_VALUE, `${key} must be an integer`);
        }
        const { min, max } = BOUNDS[key];
        if (n < min || n > max) {
            return invalid(
                CODES.OUT_OF_BOUNDS,
                `${key} must be between ${min} and ${max}`,
                { min, max, received: n }
            );
        }
        return { ok: true, kind, valueInt: n, canonical: String(n) };
    }

    if (kind === 'ghs') {
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
            return invalid(CODES.INVALID_VALUE, `${key} must be an exact decimal string`);
        }
        // A JSON number is refused outright: by the time it arrives as a double
        // the exact value may already be gone, and we would be storing a lie.
        if (typeof rawValue === 'number') {
            return invalid(
                CODES.INVALID_VALUE,
                `${key} must be sent as a decimal STRING (e.g. "1500.00"), never a JSON number`
            );
        }
        const s = rawValue.trim();
        if (!GHS_PATTERN.test(s)) {
            return invalid(
                CODES.INVALID_VALUE,
                `${key} must be a plain non-negative decimal with at most 2 decimal places (no signs, exponents or spaces)`
            );
        }
        const canonical = canonicaliseGhs(s);
        if (compareDecimalStrings(canonical, STEP_UP_THRESHOLD.min) < 0) {
            return invalid(CODES.OUT_OF_BOUNDS, `${key} must be at least ${STEP_UP_THRESHOLD.min}`, {
                min: STEP_UP_THRESHOLD.min,
            });
        }
        if (compareDecimalStrings(canonical, STEP_UP_THRESHOLD.max) > 0) {
            return invalid(
                CODES.OUT_OF_BOUNDS,
                `${key} must not exceed ${STEP_UP_THRESHOLD.max}`,
                { max: STEP_UP_THRESHOLD.max }
            );
        }
        return { ok: true, kind, valueText: canonical, canonical };
    }

    if (kind === 'enum') {
        const s = String(rawValue).trim();
        if (!HEADLINE_MODES.includes(s)) {
            return invalid(
                CODES.INVALID_VALUE,
                `${key} must be one of: ${HEADLINE_MODES.join(', ')}`,
                { allowed: HEADLINE_MODES.slice() }
            );
        }
        return { ok: true, kind, valueEnum: s, canonical: s };
    }

    return invalid(CODES.UNKNOWN_KEY, `Unknown money setting kind for ${key}`);
}

/** The documented default for a key, or null when it has none. */
function defaultValueFor(key) {
    if (Object.prototype.hasOwnProperty.call(QUOTE_TTL_DEFAULTS, key)) {
        return {
            kind: SETTING_KINDS[key],
            canonical: String(QUOTE_TTL_DEFAULTS[key]),
            valueInt: QUOTE_TTL_DEFAULTS[key],
            source: 'default',
        };
    }
    if (key === OWNER_RESOLVED_KEY) {
        return {
            kind: 'enum',
            canonical: OWNER_RESOLVED_VALUE,
            valueEnum: OWNER_RESOLVED_VALUE,
            source: 'owner_decision',
            ownerResolved: true,
        };
    }
    // Spreads and the GHS threshold have NO documented default. Reporting 0
    // would be a lie that reads as "no spread" / "never step up", so the honest
    // answer is "unset" and the caller must handle it.
    return null;
}

module.exports = {
    MONEY_SETTING_KEYS,
    LEGACY_KEY_ALIASES,
    MONEY_SETTINGS_VIEW_PERMISSION,
    MONEY_SETTINGS_WRITE_PERMISSION,
    QUOTE_TTL,
    QUOTE_TTL_DEFAULTS,
    FX_SPREAD,
    STEP_UP_THRESHOLD,
    HEADLINE_MODES,
    OWNER_RESOLVED_KEY,
    OWNER_RESOLVED_VALUE,
    SETTING_KINDS,
    BOUNDS,
    READ_ONLY_FLAGS,
    CODES,
    canonicalKey,
    isOwnerResolved,
    validateValue,
    defaultValueFor,
    compareDecimalStrings,
    canonicaliseGhs,
    isPlainObject,
};
