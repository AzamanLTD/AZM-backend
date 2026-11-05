// services/bills/serviceRegistry.js
// =============================================================================
// The authoritative service-template registry.
//
// A template says what a member may SAVE. It never says a biller is payable.
// Every capability is an explicit boolean so no caller can read one generic
// "available" flag and conclude that lookup, quoting or payment works.
//
// This registry is the only place field contracts live: the Flutter client may
// map icons, but it must not invent fields or validation of its own.
// =============================================================================

// FIELD VALIDATION POLICY
//
// These constraints are STRUCTURAL, not provider-authoritative. No signed
// provider contract or official format specification exists for ECG, Ghana
// Water, DStv, GOtv, StarTimes or broadband references, so enforcing an
// assumed shape would reject legitimate identifiers. Each pattern enforces
// only: required value, safe character set, and a conservative maximum size
// for storage and abuse prevention.
//
// Passing a pattern does NOT mean the provider recognises the reference. No
// account is ever reported as verified on the strength of a regex.

const schemaVersion = '1';

const NO_PROVIDER_CAPABILITIES = {
    saveAccount: true,
    lookupAccount: false,
    quote: false,
    payment: false,
};

/**
 * Field types are deliberately narrow: they describe *shape*, not business
 * meaning. `identifier` is any provider account reference.
 */
const FIELD_TYPES = new Set(['identifier', 'phone', 'text']);

function service(serviceCode, providerCode, label, identityField, fields, extra = {}) {
    return {
        serviceCode,
        providerCode,
        label,
        // Which field forms the canonical identity for duplicate detection.
        identityField,
        capabilities: { ...NO_PROVIDER_CAPABILITIES, ...(extra.capabilities || {}) },
        // No provider adapter exists yet, so every service names the reserved
        // adapter slot rather than a live integration.
        providerAdapter: extra.providerAdapter || null,
        fields,
    };
}

const categories = [
    {
        code: 'AIRTIME_DATA',
        label: 'Airtime & Data',
        services: [
            service('AIRTIME', 'MTN', 'MTN airtime', 'recipientPhone', [
                {
                    key: 'recipientPhone',
                    label: 'Phone number',
                    type: 'phone',
                    required: true,
                    pattern: '^(0\\d{9}|\\+233\\d{9})$',
                    maxLength: 13,
                },
            ]),
            service('DATA', 'MTN', 'MTN data', 'recipientPhone', [
                {
                    key: 'recipientPhone',
                    label: 'Phone number',
                    type: 'phone',
                    required: true,
                    pattern: '^(0\\d{9}|\\+233\\d{9})$',
                    maxLength: 13,
                },
            ]),
        ],
    },
    {
        code: 'ELECTRICITY',
        label: 'Electricity',
        services: [
            service('ECG_PREPAID', 'ECG', 'ECG prepaid', 'meterNumber', [
                {
                    key: 'meterNumber',
                    label: 'Meter number',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{6,24}$',
                    maxLength: 20,
                },
            ]),
            service('ECG_POSTPAID', 'ECG', 'ECG postpaid', 'accountNumber', [
                {
                    key: 'accountNumber',
                    label: 'Account number',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{6,24}$',
                    maxLength: 20,
                },
            ]),
        ],
    },
    {
        code: 'WATER',
        label: 'Water',
        services: [
            service('GHANA_WATER', 'GHANA_WATER', 'Ghana Water', 'customerReference', [
                {
                    key: 'customerReference',
                    label: 'Customer reference',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{6,24}$',
                    maxLength: 20,
                },
            ]),
        ],
    },
    {
        code: 'TV',
        label: 'TV',
        services: [
            service('DSTV', 'DSTV', 'DStv', 'smartcardNumber', [
                {
                    key: 'smartcardNumber',
                    label: 'Smartcard number',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{8,16}$',
                    maxLength: 14,
                },
            ]),
            service('GOTV', 'GOTV', 'GOtv', 'iucNumber', [
                {
                    key: 'iucNumber',
                    label: 'IUC number',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{8,16}$',
                    maxLength: 14,
                },
            ]),
            service('STARTIMES', 'STARTIMES', 'StarTimes', 'smartcardNumber', [
                {
                    key: 'smartcardNumber',
                    label: 'Smartcard number',
                    type: 'identifier',
                    required: true,
                    pattern: '^\\d{8,16}$',
                    maxLength: 14,
                },
            ]),
        ],
    },
    {
        code: 'INTERNET',
        label: 'Internet',
        services: [
            service('BROADBAND', 'GENERIC_BROADBAND', 'Broadband', 'serviceReference', [
                {
                    key: 'serviceReference',
                    label: 'Service reference',
                    type: 'identifier',
                    required: true,
                    pattern: '^[A-Za-z0-9-]{4,32}$',
                    maxLength: 32,
                },
            ]),
        ],
    },
];

/** Service codes reserved for later categories. They are NOT saveable yet. */
const RESERVED_CATEGORIES = [
    'CAR_INSURANCE',
    'EDUCATION_FEES',
    'GOVERNMENT_FEES',
    'TRANSPORT_TICKETS',
];

function _index() {
    const byService = new Map();
    for (const category of categories) {
        for (const svc of category.services) {
            byService.set(svc.serviceCode, { ...svc, categoryCode: category.code, categoryLabel: category.label });
        }
    }
    return byService;
}

function getService(serviceCode) {
    if (typeof serviceCode !== 'string') return null;
    return _index().get(serviceCode.trim().toUpperCase()) || null;
}

function assertKnownType(field) {
    if (!FIELD_TYPES.has(field.type)) {
        throw new Error(`service registry: field ${field.key} has unknown type ${field.type}`);
    }
    return field;
}

/**
 * Public template payload. Capability flags are copied per response so a
 * caller mutating the object cannot change server behaviour.
 */
function publicTemplates() {
    return {
        schemaVersion,
        categories: categories.map((category) => ({
            code: category.code,
            label: category.label,
            services: category.services.map((svc) => ({
                serviceCode: svc.serviceCode,
                providerCode: svc.providerCode,
                label: svc.label,
                // The canonical identity key, so clients never infer it from
                // field order. This is a schema key, not a display hint.
                identityField: svc.identityField,
                capabilities: { ...svc.capabilities },
                providerAdapter: svc.providerAdapter,
                fields: svc.fields.map((f) => assertKnownType({ ...f })),
            })),
        })),
        reservedCategories: [...RESERVED_CATEGORIES],
        // Stated once, in data, so no client can infer otherwise.
        paymentsEnabled: false,
    };
}

module.exports = {
    schemaVersion,
    categories,
    RESERVED_CATEGORIES,
    getService,
    publicTemplates,
    FIELD_TYPES,
};
