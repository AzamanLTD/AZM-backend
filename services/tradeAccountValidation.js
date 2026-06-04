// services/tradeAccountValidation.js
// =============================================================================
// AZAMAN V2 — TRADE ACCOUNT VALIDATION SERVICE (Phase F2)
//
// Validates `accountDetails` JSON blobs against type-specific schemas.
// Each supported payment method has defined required/optional fields.
// Used by:
//   - tradeAccountController.addTradeAccount (vendor registers an account)
//   - tradeController.initiateTrade (buyer provides recipient details for SELL ads)
// =============================================================================

// ── Supported method types ───────────────────────────────────────────────────
const SUPPORTED_METHODS = [
    'ZELLE',
    'CASHAPP',
    'VENMO',
    'PAYPAL',
    'APPLE_PAY',
    'GOOGLE_PAY',
    'WISE',
    'REVOLUT',
    'GIFT_CARD',
    'WESTERN_UNION',
    'WIRE_TRANSFER',
];

// ── Validation helpers ───────────────────────────────────────────────────────

const isValidEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isValidPhone = (v) => typeof v === 'string' && /^\+[1-9]\d{6,14}$/.test(v);
const isValidCashtag = (v) => typeof v === 'string' && /^\$[a-zA-Z0-9_]{1,20}$/.test(v);
const isValidUsername = (v) => typeof v === 'string' && /^@?[a-zA-Z0-9_]{1,30}$/.test(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// ── Per-type validation schemas ──────────────────────────────────────────────

const SCHEMAS = {
    ZELLE: {
        validate: (d) => {
            if (!d.email && !d.phone) return 'Zelle requires either email or phone';
            if (d.email && !isValidEmail(d.email)) return 'Invalid email format for Zelle';
            if (d.phone && !isValidPhone(d.phone)) return 'Phone must be E.164 format (e.g. +12025551234)';
            return null;
        },
        displayLabel: (d) => d.email || d.phone,
    },
    CASHAPP: {
        validate: (d) => {
            if (!d.cashtag) return 'CashApp requires a $cashtag';
            if (!isValidCashtag(d.cashtag)) return 'CashApp $cashtag must start with $ and be 1-20 alphanumeric characters';
            return null;
        },
        displayLabel: (d) => d.cashtag,
    },
    VENMO: {
        validate: (d) => {
            if (!d.username && !d.phone) return 'Venmo requires either @username or phone';
            if (d.username && !isValidUsername(d.username)) return 'Invalid Venmo username format';
            if (d.phone && !isValidPhone(d.phone)) return 'Phone must be E.164 format';
            return null;
        },
        displayLabel: (d) => d.username || d.phone,
    },
    PAYPAL: {
        validate: (d) => {
            if (!d.email) return 'PayPal requires an email address';
            if (!isValidEmail(d.email)) return 'Invalid email format for PayPal';
            return null;
        },
        displayLabel: (d) => d.email,
    },
    APPLE_PAY: {
        validate: (d) => {
            if (!d.phone) return 'Apple Pay requires a phone number';
            if (!isValidPhone(d.phone)) return 'Phone must be E.164 format';
            return null;
        },
        displayLabel: (d) => d.phone,
    },
    GOOGLE_PAY: {
        validate: (d) => {
            if (!d.email && !d.phone) return 'Google Pay requires either email or phone';
            if (d.email && !isValidEmail(d.email)) return 'Invalid email format for Google Pay';
            if (d.phone && !isValidPhone(d.phone)) return 'Phone must be E.164 format';
            return null;
        },
        displayLabel: (d) => d.email || d.phone,
    },
    WISE: {
        validate: (d) => {
            if (!d.email) return 'Wise requires an email address';
            if (!isValidEmail(d.email)) return 'Invalid email format for Wise';
            return null;
        },
        displayLabel: (d) => d.email,
    },
    REVOLUT: {
        validate: (d) => {
            if (!d.username && !d.phone) return 'Revolut requires either @username or phone';
            if (d.username && !isValidUsername(d.username)) return 'Invalid Revolut username format';
            if (d.phone && !isValidPhone(d.phone)) return 'Phone must be E.164 format';
            return null;
        },
        displayLabel: (d) => d.username || d.phone,
    },
    GIFT_CARD: {
        validate: (d) => {
            if (!d.cardType) return 'Gift Card requires a cardType (e.g. Amazon, iTunes, Steam)';
            if (!isNonEmptyString(d.cardType)) return 'cardType must be a non-empty string';
            // denomination is optional (some ads accept any value)
            return null;
        },
        displayLabel: (d) => `${d.cardType}${d.denomination ? ` ($${d.denomination})` : ''}`,
    },
    WESTERN_UNION: {
        validate: (d) => {
            if (!d.fullName) return 'Western Union requires the recipient full name';
            if (!isNonEmptyString(d.fullName)) return 'fullName must be a non-empty string';
            if (!d.country) return 'Western Union requires the recipient country';
            if (!isNonEmptyString(d.country)) return 'country must be a non-empty string';
            return null;
        },
        displayLabel: (d) => `${d.fullName} (${d.country})`,
    },
    WIRE_TRANSFER: {
        validate: (d) => {
            if (!d.bankName) return 'Wire Transfer requires bankName';
            if (!isNonEmptyString(d.bankName)) return 'bankName must be a non-empty string';
            if (!d.accountNumber) return 'Wire Transfer requires accountNumber';
            if (!isNonEmptyString(d.accountNumber)) return 'accountNumber must be a non-empty string';
            // routingNumber and swift are optional (international vs domestic)
            return null;
        },
        displayLabel: (d) => `${d.bankName} ****${(d.accountNumber || '').slice(-4)}`,
    },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate account details against the method type's schema.
 *
 * @param {string} methodType — one of SUPPORTED_METHODS
 * @param {object} details — the accountDetails JSON blob
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAccountDetails(methodType, details) {
    if (!methodType || !SUPPORTED_METHODS.includes(methodType.toUpperCase())) {
        return {
            valid: false,
            error: `Unsupported method type "${methodType}". Supported: ${SUPPORTED_METHODS.join(', ')}`
        };
    }

    if (!details || typeof details !== 'object') {
        return { valid: false, error: 'accountDetails must be a non-null object' };
    }

    const schema = SCHEMAS[methodType.toUpperCase()];
    const error = schema.validate(details);

    if (error) return { valid: false, error };
    return { valid: true };
}

/**
 * Get a safe display label for an account (masks sensitive data for marketplace).
 * E.g., "j***@email.com" for PayPal, "$Kw***" for CashApp.
 *
 * @param {string} methodType
 * @param {object} details
 * @returns {string}
 */
function getDisplayLabel(methodType, details) {
    const schema = SCHEMAS[methodType?.toUpperCase()];
    if (!schema) return methodType || 'Unknown';
    const raw = schema.displayLabel(details || {});
    if (!raw) return methodType;
    // Mask: show first 2 chars + *** + last 2 chars (or full if <= 5 chars)
    if (raw.length <= 5) return raw;
    return raw.slice(0, 2) + '***' + raw.slice(-2);
}

/**
 * Get the list of supported payment method types.
 * @returns {string[]}
 */
function getSupportedMethods() {
    return [...SUPPORTED_METHODS];
}

module.exports = {
    validateAccountDetails,
    getDisplayLabel,
    getSupportedMethods,
    SUPPORTED_METHODS,
};
