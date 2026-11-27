'use strict';

// =============================================================================
// §WP-I — READ-ONLY OPERATOR VISIBILITY FOR RECONCILIATION CASES
//
// The fail-closed paths create durable cases and quarantine claims. Without a
// read surface those are invisible, which is how a paid deposit can sit PENDING
// while a worker retries the same refusal forever. This module is the only
// reader: it returns a whitelisted DTO and never the stored JSON.
// =============================================================================

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

// Only these detail keys may reach an operator. Everything else - raw provider
// payloads, auth headers, payer numbers, stack traces - is dropped by omission
// rather than by scrubbing, so a new field in `details` cannot leak by default.
const ALLOWED_DETAIL_KEYS = ['phase', 'ties', 'txHash', 'providerRef', 'evidenceIds', 'liveRate', 'payoutGhs', 'message', 'contradictions'];
const MAX_TEXT = 240;

function clip(value) {
    if (typeof value !== 'string') return null;
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...` : value;
}

function safeDetails(details) {
    if (!details || typeof details !== 'object') return {};
    const out = {};
    for (const key of ALLOWED_DETAIL_KEYS) {
        if (!(key in details)) continue;
        const v = details[key];
        if (typeof v === 'string') out[key] = clip(v);
        else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
        else if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string').slice(0, 10).map(clip);
    }
    return out;
}

function clampLimit(raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
}

function clampOffset(raw) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
}

function exceptionDto(row) {
    return {
        kind: 'RECONCILIATION_EXCEPTION',
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        reference: row.reference || null,
        reason: row.reason,
        status: row.status,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        details: safeDetails(row.details),
    };
}

function quarantineDto(row) {
    return {
        kind: 'QUARANTINED_OBSERVATION',
        id: row.id,
        observationKey: row.observationKey,
        purpose: row.purpose,
        provider: row.provider,
        accountKey: row.accountKey || null,
        claimedByRef: row.claimedByRef || null,
        firstSeenAt: row.createdAt,
    };
}

function stuckDepositDto(row) {
    // Deliberately no destination/phone and no raw metadata: an operator needs
    // to find the deposit, not to read the customer's number off a screen.
    return {
        kind: 'STUCK_PENDING_DEPOSIT',
        id: row.id,
        type: row.type,
        status: row.status,
        amountGhs: row.amountGhs != null ? String(row.amountGhs) : null,
        reference: row.txHash || null,
        createdAt: row.createdAt,
    };
}

async function listExceptions(prisma, query = {}) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const where = [];
    const args = [];
    const push = (clause, value) => { args.push(value); where.push(clause.replace('?', `$${args.length}`)); };
    if (query.status) push('status = ?', String(query.status));
    if (query.entityType) push('"entityType" = ?', String(query.entityType));
    if (query.reason) push('reason = ?', String(query.reason));
    if (query.since) push('"lastSeenAt" >= ?::timestamptz', String(query.since));
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(limit, offset);
    const rows = await prisma.$queryRawUnsafe(
        `SELECT "id","entityType","entityId","reference","reason","status","details","firstSeenAt","lastSeenAt"
           FROM "ReconciliationException"
           ${filter}
          ORDER BY "firstSeenAt" DESC, "id" ASC
          LIMIT $${args.length - 1} OFFSET $${args.length}`,
        ...args,
    );
    return { limit, offset, items: (rows || []).map(exceptionDto) };
}

async function listQuarantined(prisma, query = {}) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const rows = await prisma.$queryRawUnsafe(
        `SELECT "id","observationKey","purpose","provider","accountKey","claimedByRef","createdAt"
           FROM "ProviderObservationClaim"
          WHERE "purpose" = 'QUARANTINE'
          ORDER BY "createdAt" DESC, "id" ASC
          LIMIT $1 OFFSET $2`,
        limit, offset,
    );
    return { limit, offset, items: (rows || []).map(quarantineDto) };
}

async function listStuckDeposits(prisma, query = {}) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const hours = Number.isFinite(Number(query.olderThanHours)) ? Number(query.olderThanHours) : 1;
    const rows = await prisma.$queryRawUnsafe(
        `SELECT "id","type","status","amountGhs","txHash","createdAt"
           FROM "TransactionHistory"
          WHERE "type" = 'DEPOSIT_FIAT'
            AND "status" = 'PENDING'
            AND "createdAt" <= now() - ($1 || ' hours')::interval
          ORDER BY "createdAt" ASC, "id" ASC
          LIMIT $2 OFFSET $3`,
        String(Math.max(1, Math.trunc(hours))), limit, offset,
    );
    return { limit, offset, items: (rows || []).map(stuckDepositDto) };
}

async function summary(prisma) {
    const [exceptions] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) FILTER (WHERE "status" = 'OPEN') AS open,
                COUNT(*) AS total,
                MIN("firstSeenAt") FILTER (WHERE "status" = 'OPEN') AS oldest_open
           FROM "ReconciliationException"`,
    );
    const byReason = await prisma.$queryRawUnsafe(
        `SELECT "reason", COUNT(*)::int AS count
           FROM "ReconciliationException"
          WHERE "status" = 'OPEN'
          GROUP BY "reason"
          ORDER BY count DESC, "reason" ASC`,
    );
    const [quarantine] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "ProviderObservationClaim" WHERE "purpose" = 'QUARANTINE'`,
    );
    const [stuck] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "TransactionHistory"
          WHERE "type" = 'DEPOSIT_FIAT' AND "status" = 'PENDING'
            AND "createdAt" <= now() - interval '1 hour'`,
    );
    const oldestOpen = exceptions && exceptions.oldest_open ? new Date(exceptions.oldest_open) : null;
    return {
        openExceptions: Number(exceptions && exceptions.open ? exceptions.open : 0),
        totalExceptions: Number(exceptions && exceptions.total ? exceptions.total : 0),
        quarantinedObservations: Number(quarantine && quarantine.count ? quarantine.count : 0),
        stuckPendingDeposits: Number(stuck && stuck.count ? stuck.count : 0),
        oldestOpenCaseAt: oldestOpen,
        oldestOpenCaseAgeHours: oldestOpen ? Math.round((Date.now() - oldestOpen.getTime()) / 3600000) : null,
        openByReason: (byReason || []).map((r) => ({ reason: r.reason, count: Number(r.count) })),
    };
}

module.exports = {
    MAX_LIMIT,
    DEFAULT_LIMIT,
    ALLOWED_DETAIL_KEYS,
    safeDetails,
    clampLimit,
    exceptionDto,
    quarantineDto,
    stuckDepositDto,
    listExceptions,
    listQuarantined,
    listStuckDeposits,
    summary,
};
