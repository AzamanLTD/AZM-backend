// services/feeLabService.js
// =============================================================================
// AZAMAN — FEE LAB: every place Azaman charges (or could charge), what it
// charges today, what it earned, and a guarded way to change it.
//
// READ (getOverview): the catalog (src/lib/feeLabCatalog.js) with each
// parameter's LIVE value, read from where the app reads it today; the
// period's booked revenue per profit source (AdminProfitLog); and each
// point's real volume in the period (count, USDC volume, and a size
// histogram) so the portal can model percent, flat fees, minimums and caps
// per transaction.
//
// PUBLISH (publish): writes the changed values where the app reads them, in
// ONE transaction, so a published change takes effect immediately with no new
// runtime path:
//   • a GlobalSettings fraction field (smartEscrowFeePct, ...): basis points
//     → fraction, exact (the columns hold 4 decimals: 1 bps resolution);
//   • an entry of a GlobalSettings JSON map (withdrawalFeeByRiskTier.STANDARD);
//   • a fee policy (feeRefund.*): an AdminMoneySettingRevision row, read by
//     services/feeRefundPolicy at refund time.
// The transaction locks the GlobalSettings row, refuses if any value changed
// since the admin loaded it (FEE_CHANGED_MEANWHILE), and writes the settings
// audit trail and the general audit log (strict: an audit failure aborts the
// publish). Points the app does not charge yet are modelled only and cannot
// be published (FEE_NOT_PUBLISHABLE). The route requires fees.manage and a
// second factor.
// =============================================================================

const { randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');
const catalogLib = require('../src/lib/feeLabCatalog');
const { audit } = require('../utils/audit');
const { DEFAULT_FEE_REFUND } = require('./feeRefundPolicy');

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90 });
const MAX_CHANGES = 50;
const REASON_MIN = 5;
const REASON_MAX = 500;
// Transaction-size histogram edges, in USDC.
const BUCKET_EDGES = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000]);
const VOLUME_QUERY_TIMEOUT_MS = 4000;

class FeeLabError extends Error {
    constructor(code, message, httpStatus = 400, detail = undefined) {
        super(message);
        this.name = 'FeeLabError';
        this.code = code;
        this.httpStatus = httpStatus;
        if (detail !== undefined) this.detail = detail;
    }
}

const _decimalText = (v) => {
    if (v == null) return null;
    const d = new Prisma.Decimal(v);
    const s = d.toFixed();
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const _fractionToBps = (v) => (v == null ? null : new Prisma.Decimal(v).mul(10000).toDecimalPlaces(0).toNumber());
const _json = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
    }
    return typeof v === 'object' ? v : null;
};

// ── live values ──────────────────────────────────────────────────────────────

async function _latestPolicyRows(db, keys, now) {
    if (!keys.length || !db.adminMoneySettingRevision) return new Map();
    const rows = await db.adminMoneySettingRevision.findMany({
        where: { key: { in: keys }, effectiveAt: { lte: now } },
        orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
    });
    const latest = new Map();
    for (const r of rows) if (!latest.has(r.key)) latest.set(r.key, r);
    return latest;
}

/** One parameter's live value, in the catalog's unit. */
function _liveFor(param, settings, policyRows) {
    const t = param.target || { kind: 'none' };
    if (t.kind === 'globalSettings') {
        const v = settings ? settings[t.field] : null;
        if (t.scale === 'fraction') return _fractionToBps(v);
        if (t.scale === 'usdc') return _decimalText(v);
        return null;
    }
    if (t.kind === 'globalSettingsJson') {
        const map = _json(settings ? settings[t.field] : null);
        const v = map && Object.prototype.hasOwnProperty.call(map, t.path) ? map[t.path] : null;
        if (v != null) return _fractionToBps(v);
        // No own entry: the app falls back to this field (the value shown is
        // what is charged; publishing adds the entry).
        if (t.fallbackField && settings && settings[t.fallbackField] != null) return _fractionToBps(settings[t.fallbackField]);
        return null;
    }
    if (t.kind === 'feePolicy') {
        const row = policyRows.get(t.key);
        if (row && (row.valueEnum === 'REFUND' || row.valueEnum === 'KEEP')) return row.valueEnum;
        return DEFAULT_FEE_REFUND[t.cause] ? 'REFUND' : 'KEEP';
    }
    // Modelled only: the catalog's starting value for the model, if any.
    return param.modelDefault ?? null;
}

/** 'own' for a JSON-map entry that exists, 'fallback' when it does not. */
function _liveSource(param, settings) {
    const t = param.target || {};
    if (t.kind !== 'globalSettingsJson') return null;
    const map = _json(settings ? settings[t.field] : null);
    return map && Object.prototype.hasOwnProperty.call(map, t.path) && map[t.path] != null ? 'own' : 'fallback';
}

/** The catalog with every parameter's live value and whether it can publish. */
async function readCatalog(db, { now = new Date() } = {}) {
    const settings = await db.globalSettings.findUnique({ where: { id: 1 } });
    const policyKeys = [];
    for (const p of catalogLib.FEE_POINTS) for (const x of p.params) if (x.target && x.target.kind === 'feePolicy') policyKeys.push(x.target.key);
    const policyRows = await _latestPolicyRows(db, policyKeys, now);
    return catalogLib.FEE_POINTS.map((point) => ({
        ...catalogLib.publicPoint(point),
        params: point.params.map((param) => ({
            ...catalogLib.publicParam(param),
            live: _liveFor(param, settings, policyRows),
            liveSource: _liveSource(param, settings),
        })),
    }));
}

// ── volumes and booked revenue ───────────────────────────────────────────────

/** Booked revenue per profit source in [from, to). */
async function _actuals(db, from, to) {
    const rows = await db.adminProfitLog.groupBy({
        by: ['source'],
        where: { createdAt: { gte: from, lt: to } },
        _sum: { amountUsdc: true },
        _count: { _all: true },
    });
    /** @type {Record<string, {revenueUsdc: number, count: number}>} */
    const out = {};
    for (const r of rows) {
        out[r.source] = { revenueUsdc: Number(r._sum.amountUsdc || 0), count: r._count._all };
    }
    return out;
}

const _summarise = (buckets) => ({
    count: buckets.reduce((s, b) => s + b.count, 0),
    volumeUsdc: buckets.reduce((s, b) => s + b.volumeUsdc, 0),
    buckets,
});

/**
 * One point's volume in [from, to): count, USDC volume and the histogram,
 * and per segment (payment method, risk tier) for a segmented source.
 * The catalog names the source; catalogLib.VOLUME_SOURCES builds its SQL
 * (one amount per row, parameterized dates). Edges are constants.
 */
async function _volume(db, sourceId, from, to) {
    const source = catalogLib.VOLUME_SOURCES[sourceId];
    if (!source) return null;
    const edges = Prisma.sql`ARRAY[${Prisma.join(BUCKET_EDGES)}]::numeric[]`;
    const seg = source.segmented ? Prisma.sql`s.seg::text` : Prisma.sql`NULL::text`;
    const query = db.$queryRaw`
        SELECT ${seg} AS seg, width_bucket(s.amt, ${edges}) AS b, COUNT(*)::int AS n, COALESCE(SUM(s.amt), 0)::text AS v
        FROM (${source.sql(from, to)}) AS s
        WHERE s.amt IS NOT NULL AND s.amt > 0
        GROUP BY 1, 2 ORDER BY 1, 2`;
    // Each source in its own read-only transaction with a time limit, so a
    // slow table is reported as unavailable instead of holding the page.
    const [, , rows] = await db.$transaction([
        db.$executeRawUnsafe('SET TRANSACTION READ ONLY'),
        db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${VOLUME_QUERY_TIMEOUT_MS}`),
        query,
    ]);
    const all = new Map();
    const bySeg = new Map();
    for (const r of rows) {
        const b = Number(r.b);
        const entry = { bucket: b, upToUsdc: b < BUCKET_EDGES.length ? BUCKET_EDGES[b] : null, count: Number(r.n), volumeUsdc: Number(r.v) };
        const merged = all.get(b) || { ...entry, count: 0, volumeUsdc: 0 };
        merged.count += entry.count;
        merged.volumeUsdc += entry.volumeUsdc;
        all.set(b, merged);
        if (source.segmented) {
            const key = r.seg == null ? '*' : String(r.seg);
            if (!bySeg.has(key)) bySeg.set(key, []);
            bySeg.get(key).push(entry);
        }
    }
    const out = _summarise(Array.from(all.values()).sort((a, b) => a.bucket - b.bucket));
    if (source.segmented) {
        out.segments = {};
        for (const [key, buckets] of bySeg) out.segments[key] = _summarise(buckets);
    }
    return out;
}

/**
 * Everything the Fee Lab page shows.
 * @param {object} db prisma
 * @param {{period?: string, now?: Date}} [opts]
 */
async function getOverview(db, { period = '30d', now = new Date() } = {}) {
    const periodDays = PERIODS[period];
    if (!periodDays) throw new FeeLabError('FEE_LAB_PERIOD_INVALID', `period must be one of ${Object.keys(PERIODS).join(', ')}.`);
    const to = now;
    const from = new Date(now.getTime() - periodDays * DAY_MS);
    const catalog = await readCatalog(db, { now });
    const actuals = await _actuals(db, from, to);
    /** @type {Record<string, object>} */
    const volumes = {};
    /** @type {Record<string, string>} */
    const volumeErrors = {};
    for (const point of catalogLib.FEE_POINTS) {
        if (!point.volume) continue;
        try {
            const v = await _volume(db, point.volume, from, to);
            if (v) volumes[point.id] = v;
        } catch (err) {
            // One unreadable source must not blank the page; it is reported.
            volumeErrors[point.id] = 'Volume unavailable';
        }
    }
    const settings = await db.globalSettings.findUnique({ where: { id: 1 }, select: { liveUsdToGhs: true } });
    return {
        period, periodDays,
        from: from.toISOString(), to: to.toISOString(),
        flows: catalogLib.FLOWS,
        catalog,
        actuals,
        volumes,
        volumeErrors,
        bucketEdgesUsdc: BUCKET_EDGES,
        usdToGhs: settings && settings.liveUsdToGhs != null ? Number(settings.liveUsdToGhs) : null,
    };
}

// ── publish ──────────────────────────────────────────────────────────────────

function _validateValue(param, raw) {
    if (param.unit === 'bps') {
        const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isInteger(n)) return null;
        if (n < param.min || n > param.max) return null;
        return n;
    }
    if (param.unit === 'usdc') {
        const text = typeof raw === 'string' ? raw.trim() : null;
        if (!text || !/^\d+(\.\d{1,6})?$/.test(text)) return null;
        const d = new Prisma.Decimal(text);
        if (d.lt(param.min) || d.gt(param.max)) return null;
        return _decimalText(d);
    }
    if (param.unit === 'policy') return raw === 'REFUND' || raw === 'KEEP' ? raw : null;
    return null;
}

const _same = (unit, a, b) => {
    if (a == null || b == null) return a == null && b == null;
    if (unit === 'usdc') return new Prisma.Decimal(a).eq(new Prisma.Decimal(b));
    if (unit === 'bps') return Number(a) === Number(b);
    return a === b;
};

/**
 * The checks that need no database: run BEFORE the second factor, so a
 * request that would be refused anyway does not spend the admin's code.
 * Returns the planned changes; throws FeeLabError.
 */
function precheck({ changes, reason }) {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < REASON_MIN || why.length > REASON_MAX) {
        throw new FeeLabError('FEE_LAB_REASON_REQUIRED', `Say why (${REASON_MIN} to ${REASON_MAX} characters).`);
    }
    if (!Array.isArray(changes) || changes.length === 0) throw new FeeLabError('FEE_LAB_NOTHING_TO_PUBLISH', 'There are no changes to publish.');
    if (changes.length > MAX_CHANGES) throw new FeeLabError('FEE_LAB_TOO_MANY', `At most ${MAX_CHANGES} changes at once.`);
    const seen = new Set();
    const planned = [];
    for (const c of changes) {
        const key = c && typeof c.key === 'string' ? c.key : '';
        const param = catalogLib.paramByKey(key);
        if (!param) throw new FeeLabError('FEE_LAB_UNKNOWN_KEY', `Unknown fee setting: ${key || '(none)'}.`);
        if (seen.has(key)) throw new FeeLabError('FEE_LAB_DUPLICATE_KEY', `${key} appears twice.`);
        seen.add(key);
        if (!catalogLib.isPublishable(param)) {
            throw new FeeLabError('FEE_NOT_PUBLISHABLE', `${param.label} is modelled only: the app does not charge it yet.`, 409, { key });
        }
        const to = _validateValue(param, c.to);
        if (to == null) {
            throw new FeeLabError('FEE_LAB_OUT_OF_BOUNDS', `${param.label}: the new value is not allowed.`, 400, { key, min: param.min, max: param.max });
        }
        planned.push({ key, param, from: c.from ?? null, to });
    }
    return { why, planned };
}

/**
 * Publish changed fee values. All or nothing.
 * @param {object} prisma
 * @param {{changes: Array<{key: string, from: unknown, to: unknown}>, reason: string,
 *          adminId: number, adminName?: string|null, ipAddress?: string|null, now?: Date}} input
 */
async function publish(prisma, { changes, reason, adminId, adminName = null, ipAddress = null, now = null }) {
    if (!Number.isInteger(adminId)) throw new FeeLabError('FEE_LAB_ACTOR_REQUIRED', 'An authenticated admin is required.', 401);
    const { why, planned } = precheck({ changes, reason });

    const publishId = randomUUID();
    let at = now;
    await prisma.$transaction(async (tx) => {
        // One publish at a time: the settings row is the lock. The time is
        // taken after it, so a rule published here is the newest one in
        // effect (a racing publish waited and sees it in the stale check).
        await tx.$executeRaw`SELECT id FROM "GlobalSettings" WHERE id = 1 FOR UPDATE`;
        at = now || new Date();
        const settings = await tx.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) throw new FeeLabError('FEE_LAB_SETTINGS_MISSING', 'Platform settings are not initialised.', 409);
        const policyRows = await _latestPolicyRows(tx, planned.filter((p) => p.param.target.kind === 'feePolicy').map((p) => p.param.target.key), at);

        // Nobody changed these since the admin loaded them.
        const stale = [];
        for (const p of planned) {
            const live = _liveFor(p.param, settings, policyRows);
            p.live = live;
            if (!_same(p.param.unit, live, p.from)) stale.push({ key: p.key, from: p.from, live });
        }
        if (stale.length) {
            throw new FeeLabError('FEE_CHANGED_MEANWHILE', 'Someone changed these fees after you loaded them. Reload and check before publishing.', 409, { stale });
        }

        const data = {};
        const jsonEdits = {};
        for (const p of planned) {
            const t = p.param.target;
            if (t.kind === 'globalSettings' && t.scale === 'fraction') data[t.field] = new Prisma.Decimal(p.to).div(10000);
            else if (t.kind === 'globalSettings' && t.scale === 'usdc') data[t.field] = new Prisma.Decimal(p.to);
            else if (t.kind === 'globalSettingsJson') {
                jsonEdits[t.field] = jsonEdits[t.field] || { ...(_json(settings[t.field]) || {}) };
                jsonEdits[t.field][t.path] = new Prisma.Decimal(p.to).div(10000).toNumber();
            }
        }
        Object.assign(data, jsonEdits);
        if (Object.keys(data).length) await tx.globalSettings.update({ where: { id: 1 }, data });

        for (const p of planned.filter((x) => x.param.target.kind === 'feePolicy')) {
            await tx.adminMoneySettingRevision.create({
                data: {
                    key: p.param.target.key, kind: 'enum', valueEnum: p.to,
                    effectiveAt: at, adminId, adminName, reason: why,
                },
            });
        }

        const items = planned.map((p) => ({ key: p.key, target: p.param.target, old: p.live, new: p.to }));
        await tx.adminSettingsAuditLog.create({
            data: {
                adminId, adminName,
                action: 'UPDATE_SETTINGS',
                targetType: 'FEE_LAB',
                targetId: publishId,
                changes: { reason: why, items },
            },
        });
        await audit(tx, {
            actorId: adminId,
            actorName: adminName,
            action: 'PUBLISH_FEES',
            targetType: 'FEE_LAB',
            targetId: publishId,
            metadata: { reason: why, items },
            ipAddress,
        }, { throwOnError: true });
    });

    return { publishId, published: planned.map((p) => ({ key: p.key, from: p.live, to: p.to })), catalog: await readCatalog(prisma, { now: at }) };
}

/** Recent publishes, newest first (the settings audit trail). */
async function history(prisma, { limit = 20 } = {}) {
    const rows = await prisma.adminSettingsAuditLog.findMany({
        where: { targetType: 'FEE_LAB' },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100),
    });
    return rows.map((r) => ({
        id: r.targetId, at: r.createdAt, adminId: r.adminId, adminName: r.adminName,
        reason: r.changes && r.changes.reason, items: (r.changes && r.changes.items) || [],
    }));
}

module.exports = { getOverview, readCatalog, precheck, publish, history, FeeLabError, PERIODS, BUCKET_EDGES };
