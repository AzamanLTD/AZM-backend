// services/moneySettingsService.js
// =============================================================================
// Money-settings service — the ONLY writer for the money settings API.
//
// Deliberately isolated from the legacy /api/admin/settings path
// (adminSettingsController), which coerces with Number(...) and rewrites the
// GlobalSettings singleton in place with no revision history. Reusing it for
// exact financial settings would mean a GHS threshold passing through a double
// and a previous value being destroyed by the write that replaces it.
//
// Read model: the current value is the newest revision whose effectiveAt is at
// or before now. A revision scheduled for the future is therefore STORED but not
// ACTIVE — which is the whole reason this is a revision log rather than a
// settings row.
//
// Write model: one transaction inserts the revision AND both audit records
// (AuditLog via the strict helper, AdminSettingsAuditLog for admin-UI
// continuity). A failed audit aborts the whole thing, so a money setting cannot
// change without durable evidence of who changed it and why.
// =============================================================================

const contract = require('../src/lib/moneySettingsContract');
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');

const MAX_REASON_LENGTH = 500;

class MoneySettingsError extends Error {
    constructor(code, message, status = 400, detail = null) {
        super(message);
        this.name = 'MoneySettingsError';
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}

/** Shape a revision row for the API. Exact strings stay strings. */
function presentRevision(row) {
    const kind = row.kind;
    let value;
    if (kind === 'ghs') value = row.valueText;
    else if (kind === 'enum') value = row.valueEnum;
    else value = row.valueInt;
    const effectiveAtIso = row.effectiveAt instanceof Date ? row.effectiveAt.toISOString() : row.effectiveAt;
    return {
        key: row.key,
        kind,
        value,
        // `effectiveFrom` is the field the Admin Portal parses; `effectiveAt` is
        // the same instant under this API's own name. One of them being absent
        // is how a UI ends up showing a scheduled change as already active.
        effectiveFrom: effectiveAtIso,
        effectiveAt: effectiveAtIso,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedBy: { adminId: row.adminId, adminName: row.adminName || null },
        reason: row.reason,
        revisionId: row.id,
    };
}

/**
 * Rollout/authority flags, read straight from GlobalSettings.
 *
 * An absent row, absent column or null value yields the STRING 'unknown', never
 * false. Reporting false would claim an authority is off when we simply could
 * not establish it, and an operator would act on that claim.
 */
async function readRolloutFlags(prisma) {
    const flags = {};
    let row = null;
    try {
        row = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    } catch (err) {
        logger.error({ err }, '[moneySettings] rollout flags unreadable');
        row = null;
    }
    for (const flag of contract.READ_ONLY_FLAGS) {
        const v = row ? row[flag] : undefined;
        flags[flag] = typeof v === 'boolean' ? v : 'unknown';
    }
    return flags;
}

/** Latest ACTIVE revision for one key (effectiveAt <= now), or null. */
async function findActiveRevision(prisma, key, now = new Date()) {
    return prisma.adminMoneySettingRevision.findFirst({
        where: { key, effectiveAt: { lte: now } },
        orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    });
}

/** Describe one key's current effective value, including where it came from. */
async function getCurrentSetting(prisma, key, now = new Date()) {
    const row = await findActiveRevision(prisma, key, now);
    if (row) {
        return { ...presentRevision(row), source: 'revision', ownerResolved: contract.isOwnerResolved(key) };
    }
    const fallback = contract.defaultValueFor(key);
    if (fallback) {
        const fallbackValue = (fallback.kind === 'int' || fallback.kind === 'bps')
            ? Number(fallback.canonical)
            : fallback.canonical;
        return {
            key,
            kind: fallback.kind,
            value: fallbackValue,
            source: fallback.source,
            ownerResolved: Boolean(fallback.ownerResolved),
            effectiveFrom: null,
            effectiveAt: null,
            createdAt: null,
            updatedBy: null,
            reason: fallback.source === 'owner_decision'
                ? 'Owner decision D1 (protected; not editable through this API)'
                : 'Documented default',
        };
    }
    // No revision and no documented default. "unset" is the honest answer.
    return {
        key,
        kind: contract.SETTING_KINDS[key],
        value: null,
        source: 'unset',
        ownerResolved: contract.isOwnerResolved(key),
        effectiveFrom: null,
        effectiveAt: null,
        createdAt: null,
        updatedBy: null,
        reason: null,
    };
}

async function getSnapshot(prisma, now = new Date()) {
    const settings = [];
    for (const key of contract.MONEY_SETTING_KEYS) {
        // Sequential on purpose: 8 keys, and a stable order makes the response
        // diffable in the admin UI and in tests.
        settings.push(await getCurrentSetting(prisma, key, now));
    }
    const flags = await readRolloutFlags(prisma);
    // `flags` is the name the Admin Portal's zod schema parses; `rolloutFlags`
    // is kept as a descriptive alias for any other reader. Both carry the same
    // values, including the string 'unknown' when a flag cannot be established.
    const bounds = {};
    for (const key of contract.MONEY_SETTING_KEYS) {
        const b = contract.BOUNDS[key] || {};
        bounds[key] = {
            min: b.min === undefined ? null : b.min,
            max: b.max === undefined ? null : b.max,
            unit: contract.SETTING_KINDS[key] === 'bps' ? 'basis points'
                : contract.SETTING_KINDS[key] === 'int' ? 'seconds'
                    : contract.SETTING_KINDS[key] === 'ghs' ? 'GHS' : null,
        };
    }
    return {
        settings,
        flags,
        bounds,
        rolloutFlags: flags,
        ownerResolved: {
            key: contract.OWNER_RESOLVED_KEY,
            value: contract.OWNER_RESOLVED_VALUE,
            editableThroughThisApi: false,
            note:
                'Owner decision D1. Protected: money.settings.write cannot change it. '
                + 'The USDC figure in COMBINED_ESTIMATE is an indicative GHS valuation, never spendable GHS.',
        },
        asOf: now.toISOString(),
    };
}

/**
 * Full history for one key, newest-first by effective time.
 * Every row keeps a status so a scheduled change cannot read as an active one.
 */
async function getHistory(prisma, rawKey, { limit = 100, now = new Date() } = {}) {
    const key = contract.canonicalKey(rawKey);
    if (!key) {
        throw new MoneySettingsError(
            contract.CODES.UNKNOWN_KEY,
            `Unknown money setting: ${rawKey}`,
            400
        );
    }
    const rows = await prisma.adminMoneySettingRevision.findMany({
        where: { key },
        orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });

    const active = await findActiveRevision(prisma, key, now);
    const activeId = active ? active.id : null;

    return rows.map((row) => ({
        ...presentRevision(row),
        status: row.id === activeId ? 'active' : (row.effectiveAt > now ? 'scheduled' : 'superseded'),
    }));
}

function normaliseReason(rawReason) {
    const reason = String(rawReason == null ? '' : rawReason).trim();
    if (!reason) {
        throw new MoneySettingsError(
            contract.CODES.REASON_REQUIRED,
            'A reason is required for every money-settings change.',
            400
        );
    }
    if (reason.length > MAX_REASON_LENGTH) {
        throw new MoneySettingsError(
            contract.CODES.INVALID_VALUE,
            `Reason must be at most ${MAX_REASON_LENGTH} characters.`,
            400,
            { maxLength: MAX_REASON_LENGTH, receivedLength: reason.length }
        );
    }
    return reason;
}

function normaliseEffectiveAt(rawEffectiveAt, now) {
    if (rawEffectiveAt === undefined || rawEffectiveAt === null || rawEffectiveAt === '') {
        return now;
    }
    const when = new Date(rawEffectiveAt);
    if (Number.isNaN(when.getTime())) {
        throw new MoneySettingsError(
            contract.CODES.INVALID_VALUE,
            'effectiveAt must be a valid ISO-8601 timestamp.',
            400
        );
    }
    return when;
}

/**
 * Write one revision.
 *
 * @param {object} prisma  Prisma client (or transaction client)
 * @param {object} input   { key, value, reason, effectiveAt, adminId, adminName, ipAddress }
 * @param {object} deps    { auditFn } — injectable so the rollback path is testable
 */
async function writeSetting(prisma, input, deps = {}) {
    const auditFn = deps.auditFn || audit;
    const now = deps.now || new Date();

    const key = contract.canonicalKey(input && input.key);
    if (!key) {
        throw new MoneySettingsError(
            contract.CODES.UNKNOWN_KEY,
            `Unknown money setting: ${input && input.key}`,
            400
        );
    }

    // Owner-resolved values are protected BEFORE validation, so even a
    // well-formed attempt to flip the headline mode is refused with the reason
    // that actually applies.
    if (contract.isOwnerResolved(key)) {
        throw new MoneySettingsError(
            contract.CODES.OWNER_RESOLVED,
            `${key} is an owner-resolved decision (${contract.OWNER_RESOLVED_VALUE}) and cannot be `
            + 'changed through this API. A change requires the separate owner procedure.',
            409,
            { key, currentValue: contract.OWNER_RESOLVED_VALUE, editableThroughThisApi: false }
        );
    }

    const verdict = contract.validateValue(key, input && input.value);
    if (!verdict.ok) {
        const status = verdict.code === contract.CODES.OUT_OF_BOUNDS ? 400 : 400;
        throw new MoneySettingsError(verdict.code, verdict.message, status, verdict.detail);
    }

    // The portal sends `note` and `effectiveFrom`; older callers and the brief
    // use `reason` and `effectiveAt`. Accept both, store one. Neither is
    // optional: a money change without a stated reason is refused.
    const reason = normaliseReason(input && (input.reason !== undefined ? input.reason : input.note));
    const effectiveRaw = input && (input.effectiveAt !== undefined ? input.effectiveAt : input.effectiveFrom);
    const effectiveAt = normaliseEffectiveAt(effectiveRaw, now);

    const adminId = Number(input && input.adminId);
    if (!Number.isInteger(adminId)) {
        throw new MoneySettingsError(
            'MONEY_SETTING_ACTOR_REQUIRED',
            'An authenticated admin identity is required to write a money setting.',
            500
        );
    }
    const adminName = (input && input.adminName) ? String(input.adminName).slice(0, 120) : null;

    const data = {
        key,
        kind: verdict.kind,
        valueInt: verdict.kind === 'int' || verdict.kind === 'bps' ? verdict.valueInt : null,
        valueText: verdict.kind === 'ghs' ? verdict.valueText : null,
        valueEnum: verdict.kind === 'enum' ? verdict.valueEnum : null,
        effectiveAt,
        adminId,
        adminName,
        reason,
    };

    const created = await prisma.$transaction(async (tx) => {
        const revision = await tx.adminMoneySettingRevision.create({ data });

        // 1) General append-only audit. STRICT: a failure aborts the change.
        await auditFn(
            tx,
            {
                actorId: adminId,
                actorName: adminName,
                action: 'UPDATE_MONEY_SETTING',
                targetType: 'MONEY_SETTING',
                targetId: key,
                metadata: {
                    key,
                    value: verdict.canonical,
                    kind: verdict.kind,
                    reason,
                    effectiveAt: effectiveAt.toISOString(),
                    revisionId: revision.id,
                },
                ipAddress: (input && input.ipAddress) || null,
            },
            { throwOnError: true }
        );

        // 2) Settings-specific trail, so the existing admin settings history
        //    view keeps showing money changes in the shape it already reads.
        await tx.adminSettingsAuditLog.create({
            data: {
                adminId,
                adminName,
                action: 'UPDATE_SETTINGS',
                targetType: 'MONEY_SETTING',
                targetId: key,
                changes: {
                    key,
                    kind: verdict.kind,
                    new: verdict.canonical,
                    reason,
                    effectiveAt: effectiveAt.toISOString(),
                    revisionId: revision.id,
                },
            },
        });

        return revision;
    });

    const current = await getCurrentSetting(prisma, key, now);
    return {
        revision: presentRevision(created),
        current,
        scheduled: created.effectiveAt > now,
    };
}

module.exports = {
    MoneySettingsError,
    getSnapshot,
    getCurrentSetting,
    getHistory,
    writeSetting,
    readRolloutFlags,
    findActiveRevision,
    presentRevision,
    MAX_REASON_LENGTH,
};
