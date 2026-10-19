'use strict';
// =============================================================================
// MARKETPLACE MIX P1 — cross-business item discovery service.
//
// Authority: docs/MARKETPLACE_MIX_REDESIGN_2026-10-10.md §3 (endpoint + DTO +
// exclusions), §3.2 (ordering/cursor/cache), §3.3 (indexes), §4 (taxonomy +
// availability truth) and §9 D-5 (capability separation); the GHS pricing
// companion contract §3.2/§4 (price authority + eligibility gate).
//
// SCOPE DISCIPLINE (P1, feature-flagged, no UI): this service implements the
// candidate query, the eligibility matrix, the GHS price authority, the stable
// cursor and the honest DTO. OUT of scope by the approved phasing: analytics-
// backed ranking + diversity interleave (§5.2 → P3), public web pages (§6 →
// P5), GHS checkout/collection/settlement (companion §3.3 → P6, behind its own
// financial review), and an `on_request`/quotation response state — the
// approved Mix contract EXCLUDES unpriced items entirely; quotation opt-in is
// a Stores-catalogue behavior only.
//
// Pricing authority: prices resolve EXCLUSIVELY through
// services/businessPriceService.js (resolveEffectiveGhsPrices /
// eligibleCurrentGhsPriceWhere). BusinessPrice is never queried directly here
// as a substitute for that service, never converted from priceUsdc, and a
// product without a business/admin-confirmed GHS price is not in the feed.
// =============================================================================

const { Prisma } = require('@prisma/client');
const priceService = require('../businessPriceService');
const logger = require('../../src/config/logger');

// ─── configuration (pre-calibration honesty: §5.2 labels/scores are
// "proposed" until the P3 engagement rollups + A/B calibration land) ─────────

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;
const MAX_QUERY_LEN = 100;
// §3.1 repeatable taxonomy chips: bound the IN-list a single request can
// demand so a crafted query cannot demand an unbounded chip OR.
const MAX_TAXONOMY_CHIPS = 10;
// §3.2: cursor pagination is cursor-only (no offset scan amplification).
// Rounds bound the window-filter refill loop: each round fetches (need+1)
// where-eligible rows and post-filters section windows; the loop exits early
// whenever the page fills or the source exhausts. The bound exists to keep one
// request from becoming an unbounded scan — it must NOT break §4 page
// exactness: every row dropped by the section-window post-filter still has to
// be walked past, or eligible items sorting behind them silently vanish from
// the page. (2026-10-18 CI proof, run 39120763057: with only 3 rounds the
// battery's disposable database accumulated >75 stale window-closed rows
// ahead of a freshly seeded eligible item and the feed returned an EMPTY
// first page — items: [] — for tests asserting the item surfaces.) MAX_ROUNDS
// bounds the QUERY count per request; the adaptive take below (2026-10-19)
// grows each round's fetch after zero-eligible rounds so the same query
// budget now walks far past the old fixed ~1920-row ceiling, with a separate
// MAX_SCAN_ROWS row budget as the hard per-request work cap.
const MAX_ROUNDS = 80;
// ── Adaptive scan growth (acceptance close-out, 2026-10-19) ─────────────────
// The refill loop's per-ROUND fetch grows when rounds come back with NOTHING
// eligible: a fixed take of (need+1) re-walks window-closed candidates at ~24
// rows per query, so a feed with thousands of stale rows burned its 80-round
// query budget on ~1920 rows and returned an empty page with a cursor (the
// measured stress case: 21k stale rows -> 9 client requests / 720 queries /
// ~60s before the first eligible item). Growth keeps the SAME hard budgets —
// MAX_ROUNDS bounds queries, MAX_SCAN_ROWS bounds examined rows per request —
// while doubling the fetch after each empty round so a zero-eligible walk
// covers far more source per query. A productive round resets the fetch to
// (need+1) so the page's tail stays cheap. Both caps ship as constants: one
// request can never scan more than MAX_SCAN_ROWS rows or issue more than
// MAX_ROUNDS findMany queries, whatever the data looks like.
const MAX_ROUND_TAKE = 512; // per-query fetch cap (rows)
const MAX_SCAN_ROWS = 25000; // hard per-request row-examination budget
const CACHE_TTL_SECONDS = 60; // §3.2 first-page TTL
// Pre-calibration rank normalization (§5.2 fallback w7: category-wide
// engagement ordering). score = min(1, log1p(totalOrders)/log1p(NORM)).
// Honest label: null until the P3 engagement rollups can back
// POPULAR_NEARBY / OFTEN_ORDERED thresholds from real outcomes.
const RANK_TOTAL_ORDERS_NORM = 1000;

const VALID_CATEGORIES = new Set([
    'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE',
    'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS',
    'FINANCIAL_SERVICES', 'OTHER', 'HOSPITALITY',
]);

// Action/capability truth (§5.3): computed server-side from what the business
// actually supports; a business never sees a delivery, booking, or payment
// button it does not support. payableIn reports ONLY actually-supported rails:
// escrow checkout is USDC-only today — "GHS" appears here ONLY after the GHS
// collection rail ships (companion §3.3, P6). A GHS LISTING price is display
// data and never a payment claim.
const ACTION_BY_CATEGORY = {
    FOOD_BEVERAGE: 'ADD_TO_CART',
    RETAIL: 'ADD_TO_CART',
    HOSPITALITY: 'BOOK',
    LOGISTICS: 'VIEW_SEATS',
};
const DEFAULT_ACTION = 'ENQUIRE';
const PAYABLE_IN = ['USDC'];

// ─── section time-window truth (§4) ─────────────────────────────────────────
//
// CatalogSection.availableFrom/To are local "HH:MM" strings. Ghana is UTC+0
// year-round (Africa/Accra, no DST), so the browse-time evaluation compares
// against the server's UTC wall clock. Both null = always open. A wrap window
// (from > to, e.g. 22:00-02:00) is open across midnight. A MALFORMED window
// string fails CLOSED (the section is not surfaced) — a broken config must
// never silently widen availability.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value) {
    if (typeof value !== 'string') return null;
    const m = TIME_RE.exec(value.trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function sectionWindowOpen(section, nowMinutes) {
    if (!section) return true; // no section → no window constraint
    if (section.availableFrom == null && section.availableTo == null) return true;
    const from = section.availableFrom == null ? null : parseHHMM(section.availableFrom);
    const to = section.availableTo == null ? null : parseHHMM(section.availableTo);
    // Malformed half-window: fail closed rather than guess the intent.
    if (section.availableFrom != null && from == null) return false;
    if (section.availableTo != null && to == null) return false;
    if (from == null) return nowMinutes <= to; // open-until
    if (to == null) return nowMinutes >= from; // open-from
    if (from <= to) return nowMinutes >= from && nowMinutes <= to;
    return nowMinutes >= from || nowMinutes <= to; // overnight wrap
}

function nowMinutesUtc() {
    const now = new Date();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
}

// ─── cursor (§3.2: opaque base64, versioned, encodes the FULL key tuple) ────
//
// Ordering key: (totalOrders DESC, createdAt DESC, id ASC) — the P1 fallback
// of the approved stable ordering (§5.2 w7: category-wide engagement, real
// outcomes only, no stars). The approved key tuple (rankScore, diversity
// rounds) arrives with the P3 ranker; the cursor version byte lets that
// switch happen without misreading old cursors.
//
// Stability trade-off, identical to the approved design: totalOrders is
// mutable, so an item whose order count changes mid-browse may shift within
// the walk (the approved rankScore key has the same property). The key tuple
// in the cursor makes the comparison exact — no offset drift.

const CURSOR_VERSION = 1;

function encodeCursor(row) {
    return Buffer.from(JSON.stringify({
        v: CURSOR_VERSION,
        o: row.totalOrders,
        c: row.createdAt.getTime(),
        i: row.id,
    })).toString('base64url');
}

// Cursor input safety: a cursor is untrusted client input. Everything a
// crafted cursor could push into the Prisma query is validated BEFORE the
// query is constructed — out-of-range/NaN timestamps, non-finite or
// negative counts, and oversized/empty id strings are all rejected as
// malformed (→ 422), never surfaced as a Prisma 500.
const CURSOR_RAW_MAX_LEN = 4096;   // base64url envelope cap, checked pre-decode
const CURSOR_ID_MAX_LEN = 64;      // cuid/uuid-sized, plus headroom
// ECMAScript/PostgreSQL Date range bound: |ms| beyond ±8.64e15 is not a
// valid Date, and new Date(NaN) must never reach the query either.
const MAX_DATE_MS = 8640000000000000;

function decodeCursor(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > CURSOR_RAW_MAX_LEN) return null;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_VERSION) return null;
    if (!Number.isInteger(parsed.o) || !Number.isInteger(parsed.c) || typeof parsed.i !== 'string') {
        return null;
    }
    // totalOrders is a non-negative count: reject negatives and values beyond
    // 2^53-1 (Number.MAX_SAFE_INTEGER) so the bound is never a float lie.
    if (parsed.o < 0 || parsed.o > Number.MAX_SAFE_INTEGER) return null;
    // createdAt must land inside the valid Date range (both ECMAScript and
    // PostgreSQL timestamp bounds): reject NaN-date integers and out-of-
    // range epochs before they reach the query.
    if (!Number.isSafeInteger(parsed.c) || Math.abs(parsed.c) >= MAX_DATE_MS) return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    // id participates in a gt comparison — cap its length.
    if (parsed.i.length === 0 || parsed.i.length > CURSOR_ID_MAX_LEN) return null;
    return { totalOrders: parsed.o, createdAt, id: parsed.i };
}

function afterKeyWhere(key) {
    if (!key) return undefined;
    return {
        OR: [
            { totalOrders: { lt: key.totalOrders } },
            { AND: [{ totalOrders: key.totalOrders }, { createdAt: { lt: key.createdAt } }] },
            { AND: [{ totalOrders: key.totalOrders }, { createdAt: key.createdAt }, { id: { gt: key.id } }] },
        ],
    };
}

// ─── first-page cache (§3.2: TTL 60s, Redis with in-memory fallback, exactly
// the storefrontRenderService pattern) ───────────────────────────────────────
//
// P1 note (honest gap, documented in the PR): the release of the feed is
// feature-flagged and consumed by no UI yet, so the write-path invalidation
// hooks ship with the P2 UI PR; until then the 60s TTL bounds staleness.
// `invalidateDiscoveryFeedCache()` is exported so those hooks are one-line
// wiring, not a service rewrite.

let redisClient = null;
const memoryCache = new Map();

try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        const isTLS = process.env.REDIS_URL.startsWith('rediss://');
        redisClient = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 2,
            tls: isTLS ? { rejectUnauthorized: false } : undefined,
            retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
        });
        redisClient.on('error', (e) => logger.warn('[DiscoveryFeed] Redis cache error:', e.message));
    }
} catch {
    redisClient = null;
}

function isRedisReady(client) {
    return client?.status === 'ready' || client?.status === 'connect';
}

function cacheKey(params) {
    // The taxonomy list is normalized (sorted — parseParams already deduped)
    // so chip order does not fragment the cache for the same membership set.
    const taxonomies = [...(params.taxonomies || [])].sort();
    const normalized = [
        params.category || '',
        params.q || '',
        taxonomies.join(','),
        params.city || '',
        params.region || '',
        String(params.limit),
    ].join('|');
    return `discovery:mix:items:v1:${Buffer.from(normalized).toString('base64url')}`;
}

async function getCached(key) {
    try {
        if (isRedisReady(redisClient)) {
            const cached = await redisClient.get(key);
            return cached ? JSON.parse(cached) : null;
        }
    } catch (e) {
        logger.warn('[DiscoveryFeed] cache read failed:', e.message);
    }
    const mem = memoryCache.get(key);
    if (mem && mem.expiresAt > Date.now()) return mem.value;
    memoryCache.delete(key);
    return null;
}

async function setCached(key, value) {
    try {
        if (isRedisReady(redisClient)) {
            await redisClient.setex(key, CACHE_TTL_SECONDS, JSON.stringify(value));
            return;
        }
    } catch (e) {
        logger.warn('[DiscoveryFeed] cache write failed:', e.message);
    }
    memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

function invalidateDiscoveryFeedCache() {
    memoryCache.clear();
    if (isRedisReady(redisClient)) {
        // Best-effort pattern delete; the TTL bounds any stragglers.
        redisClient.keys('discovery:mix:items:v1:*')
            .then((keys) => keys.length && redisClient.del(keys))
            .catch(() => {});
    }
}

// ─── candidate where-clause (§3.1 exclusions, server-enforced) ──────────────
//
// The where clause carries every exclusion expressible in SQL:
//   • product isActive + isAvailable
//   • business not suspended, not owner-paused (B-1), AND publicly
//     discoverable (§9 D-5 marketplace-visibility flag — SEPARATE capability
//     from the custom-storefront storefrontDisabled kill-switch, which is
//     deliberately NOT consulted here: neither bypasses the other)
//   • a business/admin-confirmed, current, effective-dated GHS price row
//     (the price service's own predicate — single source of eligibility)
//   • section (when set): active; when a taxonomy chip is requested, the
//     section must carry exactly that canonical taxonomy
//   • location (when branch-scoped): the branch must be active; with a
//     city/region filter, the branch (or — for all-branch items — any active
//     branch of the business) must match
// The section time-window is evaluated post-query (§4: once per request
// batch, grouped by section) because "HH:MM" strings + wrap windows are not
// a Prisma predicate; the refill loop keeps pages exact despite the filter.

function buildWhere({ category, q, taxonomies, city, region, key }) {
    const AND = [];

    // Product category inherits from the profile when null (schema comment).
    if (category && VALID_CATEGORIES.has(category)) {
        AND.push({
            OR: [
                { category },
                { category: null, businessProfile: { category } },
            ],
        });
    }

    if (q) {
        AND.push({
            OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
            ],
        });
    }

    // A specific chip NEVER surfaces UNMAPPED sections (§4); the chip filter
    // implies the section must exist and be active. Repeatable chips OR
    // together (set membership) — deterministic regardless of request order.
    if (taxonomies && taxonomies.length > 0) {
        AND.push({ catalogSection: { isActive: true, taxonomy: { in: taxonomies } } });
    }

    if (city || region) {
        const locationMatch = {};
        if (city) locationMatch.city = { equals: city, mode: 'insensitive' };
        if (region) locationMatch.region = { equals: region, mode: 'insensitive' };
        AND.push({
            OR: [
                // all-branch item: SOME active branch of the business matches
                { locationId: null, businessProfile: { locations: { some: { isActive: true, ...locationMatch } } } },
                // branch-scoped item: its own active branch matches
                { location: { isActive: true, ...locationMatch } },
            ],
        });
    }

    // A section-bearing item requires its section to be active; a sectionless
    // item has no section constraint (general feed). A taxonomy chip filter
    // already implies an active section via its own AND clause, so this OR is
    // only needed without one.
    if (!taxonomies || taxonomies.length === 0) {
        AND.push({
            OR: [
                { catalogSectionId: null },
                { catalogSection: { isActive: true } },
            ],
        });
    }

    // Branch-scoped items name an ACTIVE branch — an inactive branch's items
    // are excluded (§3.1 location exclusion). An all-branch item
    // (locationId null) has no branch constraint.
    AND.push({
        OR: [
            { locationId: null },
            { location: { isActive: true } },
        ],
    });

    const after = afterKeyWhere(key);
    if (after) AND.push(after);

    const where = {
        isActive: true,
        isAvailable: true,
        businessProfile: {
            isSuspended: false,
            isPausedByOwner: false,
            isPubliclyDiscoverable: true,
        },
        prices: { some: priceService.eligibleCurrentGhsPriceWhere() },
    };
    if (AND.length > 0) where.AND = AND;
    return where;
}

// ─── fetch + refill loop ─────────────────────────────────────────────────────

const INCLUDE = {
    businessProfile: { select: { id: true, bizId: true, businessName: true, category: true } },
    location: { select: { id: true, label: true, city: true, region: true } },
    catalogSection: {
        select: { id: true, name: true, taxonomy: true, isActive: true, availableFrom: true, availableTo: true },
    },
};

async function fetchRound(prisma, where, take) {
    return prisma.businessProduct.findMany({
        where,
        take,
        orderBy: [{ totalOrders: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        include: INCLUDE,
    });
}

// ─── DTO assembly (§3.1) ─────────────────────────────────────────────────────

function serializeRank(product) {
    const score = Math.min(1, Math.log1p(product.totalOrders) / Math.log1p(RANK_TOTAL_ORDERS_NORM));
    // label null = thresholds not met / not yet calibrated (§5.2: honest
    // labels come from the P3 engagement rollups; P1 never fabricates them).
    return { score: Number(score.toFixed(4)), label: null };
}

// ─── variant/modifier GHS truth (READ-TIME VALIDATION, fail closed) ────────
//
// WRITE-PATH AUDIT (2026-10-14, review correction #3): the product write
// services (businessProductService._cleanOptionRows/_cleanModifierGroups and
// storefrontProductConfigurationService.normalizedOptionList) whitelist
// {name, priceDelta} and DISCARD any priceDeltaGhs — no sanctioned write path
// persists GHS deltas yet, and validateGhsDeltas had ZERO wired callers. The
// earlier "validated at write time" claim on a pass-through serializer was
// therefore FALSE and is withdrawn: the READ path is the gate. The feed is
// the only P1 consumer of priceDeltaGhs, so the validation authority lives
// HERE:
//   • every option carrying priceDeltaGhs must be a 2dp-precision decimal
//     STRING within the configured delta bounds (a JSON number, a >2dp
//     value, or garbage is a corrupt configuration);
//   • the whole configuration must pass the price service's
//     validateGhsDeltas against the item's resolved base GHS price (the
//     worst-case all-negative-deltas selection must stay a positive price);
//   • valid deltas are reserialized as the EXACT 2dp canonical decimal
//     string ("5" → "5.00", "-1.5" → "-1.50");
//   • ANY violation excludes the item from the feed (fail closed per
//     identity, loud log) — never a partial DTO, never a silent delta drop,
//     never a 500.
// The USDC priceDelta passes through unchanged: it keeps its own independent
// meaning (companion contract §1.1 — the two deltas are never converted into
// each other).
//
// When a portal write path for GHS deltas ships (P2+), it MUST wire
// validateGhsDeltas at write time too; until then this read gate keeps
// direct-DB or legacy rows out of the public surface.

// ─── variant/modifier STORAGE-SHAPE normalization ────────────────────────────
//
// The platform has TWO sanctioned writers and therefore several storage
// shapes that a BusinessProduct.variants / .modifierGroups JSON column can
// legitimately hold. This read path must understand ALL of them — a shape
// it does not normalize is a shape whose options (and GHS deltas) silently
// vanish from the public feed:
//
//   A. FLAT option arrays — businessProductService._cleanOptionRows writes
//      variants as [{ name, priceDelta }] with NO group wrapper. The
//      storefront's normalizeVariantGroups semantics fold these into a
//      single synthesized { name: 'Size', required: true } group; this read
//      path folds them identically (mixed arrays that contain BOTH flat
//      rows and grouped rows follow the storefront's grouped reading).
//   B. GROUPED arrays — [{ name, required?, options: [...] | values: [...] }]
//      from the portal write path (modifierGroups always take this shape).
//   C. LEGACY object-keyed configurations — storefrontProductConfiguration
//      .normalizeVariantGroups accepts { "Size": [...options], ... } keyed by
//      option group; each entry becomes a required group.
//   D. Modifier groups may carry the legacy keys `values` (option list) and
//      `max` (selection bound), and inherit the storefront's required
//      semantics: required is true ONLY when explicitly set.
//
// Shape reading mirrors the storefront service (the USDC checkout authority)
// so the feed and checkout can never disagree about what a row means. The
// USDC priceDelta passes through unchanged — it keeps its own independent
// meaning and is never converted into (or derived from) a GHS delta.

function _optionLabel(option) {
    if (option && typeof option === 'object') {
        return String(option.name ?? option.label ?? option.value ?? '').trim();
    }
    return String(option ?? '').trim();
}

// Mirrors storefront normalizedOptionList shape rules, but PRESERVES the
// original option fields for object options (so id/label/priceDelta/… ride
// through untouched) and NEVER silently drops a priceDeltaGhs: an option the
// legacy USDC normalizer would discard (nameless) is tolerated only while it
// carries no GHS delta — a delta on a dropped option fails the whole item.
function _normalizedOptions(rawOptions, ctx) {
    if (!Array.isArray(rawOptions)) return [];
    const out = [];
    for (const option of rawOptions) {
        if (option && typeof option === 'object' && !Array.isArray(option)) {
            const name = _optionLabel(option);
            if (!name) {
                if (Object.prototype.hasOwnProperty.call(option, 'priceDeltaGhs')
                    && option.priceDeltaGhs !== undefined && option.priceDeltaGhs !== null) {
                    throw new priceService.BusinessPriceError('GHS_DELTA_ON_DROPPED_OPTION',
                        `${ctx}: an unnamed option carries priceDeltaGhs — refusing to silently drop a GHS delta`);
                }
                continue; // legacy normalizedOptionList drops nameless options (USDC semantics preserved)
            }
            const reserialized = { ...option };
            if (Object.prototype.hasOwnProperty.call(option, 'priceDeltaGhs')
                && option.priceDeltaGhs !== undefined && option.priceDeltaGhs !== null) {
                reserialized.priceDeltaGhs = _canonicalDelta(option.priceDeltaGhs);
            }
            out.push(reserialized);
        } else {
            // Non-object option (legacy lists allow bare strings): the
            // storefront normalizes these to { id, name, priceDelta: 0 } —
            // preserve that exact USDC meaning. No GHS delta can ride here.
            const label = _optionLabel(option);
            out.push({ id: label, name: label, priceDelta: 0 });
        }
    }
    return out;
}

function _hasAnyGhsDelta(group) {
    if (group && typeof group === 'object' && !Array.isArray(group)) {
        if (Object.prototype.hasOwnProperty.call(group, 'priceDeltaGhs')
            && group.priceDeltaGhs !== undefined && group.priceDeltaGhs !== null) return true;
        const opts = Array.isArray(group.options) ? group.options
            : Array.isArray(group.values) ? group.values : [];
        for (const option of opts) {
            if (option && typeof option === 'object' && !Array.isArray(option)
                && Object.prototype.hasOwnProperty.call(option, 'priceDeltaGhs')
                && option.priceDeltaGhs !== undefined && option.priceDeltaGhs !== null) return true;
        }
    }
    return false;
}

// Validates + canonicalizes one GHS delta to the exact 2dp decimal STRING.
// A JSON number, boolean, object, or malformed/sub-pesewa value is a corrupt
// configuration (the approved contract is a decimal string; the authority
// never rounds silently).
function _canonicalDelta(value) {
    if (typeof value !== 'string') {
        throw new priceService.BusinessPriceError('GHS_DELTA_NOT_A_STRING',
            'priceDeltaGhs must be an exact 2dp decimal STRING');
    }
    const d = priceService.parseGhsDecimal(value, { field: 'priceDeltaGhs', allowNegative: true });
    return priceService.pesewasToGhsString(priceService.toPesewas(d));
}

// A priceDeltaGhs sitting at the GROUP ROOT (not on an option) is NOT a
// supported shape: the approved contract defines GHS deltas on OPTIONS only,
// a root delta has no pricing semantics (validateGhsDeltas never inspects
// it, so nothing would bound it), and exposing it as a price field would be
// misleading. Reject it outright — the item fails closed instead. If root
// deltas are ever to be supported, their semantics and bounds must first be
// defined and enforced consistently.
function _assertNoGroupRootDelta(group, ctx) {
    if (group && typeof group === 'object' && !Array.isArray(group)
        && Object.prototype.hasOwnProperty.call(group, 'priceDeltaGhs')
        && group.priceDeltaGhs !== undefined && group.priceDeltaGhs !== null) {
        throw new priceService.BusinessPriceError('GHS_DELTA_AT_GROUP_ROOT',
            `${ctx}: priceDeltaGhs at the group ROOT is not a supported shape (the approved contract defines deltas on OPTIONS only) — item excluded`);
    }
}

// Mirrors storefront normalizeVariantGroups (the USDC checkout authority for
// what a variants column MEANS), preserving the shapes above.
function _normalizedVariantGroups(raw) {
    if (Array.isArray(raw)) {
        const objectEntries = raw.filter((entry) => entry && typeof entry === 'object');
        const flatObjectRows = objectEntries.filter((entry) => !Array.isArray(entry.options) && !Array.isArray(entry.values));
        const groupedObjectRows = objectEntries.length - flatObjectRows.length;
        if (flatObjectRows.length > 0 && groupedObjectRows > 0) {
            // GENUINELY MIXED flat option rows + grouped entries. The legacy
            // normalizer reads this as grouped and silently turns every flat
            // row into an empty group — losing its option semantics, its USDC
            // priceDelta and any GHS delta. That legacy reading is NOT a safe
            // normalization: the shape is ambiguous (is the flat row an
            // option or a group?) and cannot be represented without loss, so
            // the item fails closed rather than publishing a misshapen DTO.
            throw new priceService.BusinessPriceError('GHS_MIXED_VARIANT_SHAPE',
                'variants mixes flat option rows with grouped entries — ambiguous shape that cannot be represented without losing data; item excluded');
        }
        const isFlatOptionList = flatObjectRows.length > 0 && groupedObjectRows === 0;
        if (isFlatOptionList) {
            // Shape A: businessProductService flat rows → one Size group.
            return [{ name: 'Size', required: true, options: _normalizedOptions(raw, 'variants') }];
        }
        // Shape B (grouped). Name semantics mirror normalizeVariantGroups
        // exactly: entries without a usable name/id keep the `Variant N`
        // placeholder (legacy keeps them); ONLY an object whose explicit
        // name/id trims empty is dropped — and a dropped group must not take
        // a GHS delta with it.
        const groups = [];
        raw.forEach((group, index) => {
            const isObj = Boolean(group) && typeof group === 'object' && !Array.isArray(group);
            const nameRaw = isObj ? (group.name ?? group.id) : undefined;
            const name = String(nameRaw ?? `Variant ${index + 1}`).trim();
            if (isObj && name === '') {
                if (_hasAnyGhsDelta(group)) {
                    throw new priceService.BusinessPriceError('GHS_DELTA_ON_DROPPED_GROUP',
                        `variants[${index}]: a nameless group carries priceDeltaGhs — refusing to silently drop a GHS delta`);
                }
                return; // legacy .filter(group => group.name) drops it
            }
            _assertNoGroupRootDelta(group, `variants[${index}]`);
            const options = _normalizedOptions(isObj ? (group.options ?? group.values) : undefined,
                `variants[${index}]`);
            const out = {
                name,
                required: isObj ? group.required !== false : true,
                options,
            };
            groups.push(out);
        });
        return groups;
    }
    // Shape C: legacy object-keyed configuration — each key is a required group.
    if (raw && typeof raw === 'object') {
        const groups = [];
        for (const [key, values] of Object.entries(raw)) {
            const name = String(key).trim();
            const options = _normalizedOptions(values, `variants["${key}"]`);
            if (!name) {
                // An empty key can only carry deltas via its options; guard.
                const carriesDelta = Array.isArray(values) && values.some((o) => o && typeof o === 'object'
                    && Object.prototype.hasOwnProperty.call(o, 'priceDeltaGhs')
                    && o.priceDeltaGhs !== undefined && o.priceDeltaGhs !== null);
                if (carriesDelta) {
                    throw new priceService.BusinessPriceError('GHS_DELTA_ON_DROPPED_GROUP',
                        `variants["${key}"]: a nameless group carries priceDeltaGhs — refusing to silently drop a GHS delta`);
                }
                continue; // legacy Object.entries().filter(group => group.name) drops it
            }
            groups.push({ name, required: true, options });
        }
        return groups;
    }
    // Not a supported shape (scalar/null): carries no options, no deltas.
    return [];
}

// Mirrors storefront normalizeModifierGroups: required ONLY when explicitly
// true, maxSelection from maxSelection|max (≥1), options or values.
function _normalizedModifierGroups(raw) {
    if (!Array.isArray(raw)) return [];
    const groups = [];
    raw.forEach((group, index) => {
        const isObj = Boolean(group) && typeof group === 'object' && !Array.isArray(group);
        const nameRaw = isObj ? (group.name ?? group.id) : undefined;
        const name = String(nameRaw ?? `Options ${index + 1}`).trim();
        if (isObj && name === '') {
            if (_hasAnyGhsDelta(group)) {
                throw new priceService.BusinessPriceError('GHS_DELTA_ON_DROPPED_GROUP',
                    `modifierGroups[${index}]: a nameless group carries priceDeltaGhs — refusing to silently drop a GHS delta`);
            }
            return; // legacy .filter(group => group.name) drops it
        }
        _assertNoGroupRootDelta(group, `modifierGroups[${index}]`);
        const maxRaw = isObj ? Number(group.maxSelection ?? group.max ?? 1) : NaN;
        const maxSelection = Math.max(1, Math.floor(Number.isFinite(maxRaw) ? maxRaw : 0));
        const options = _normalizedOptions(isObj ? (group.options ?? group.values) : undefined,
            `modifierGroups[${index}]`);
        const out = {
            name,
            required: isObj ? group.required === true : false,
            maxSelection,
            options,
        };
        groups.push(out);
    });
    return groups;
}

// Returns the validated, canonically reserialized variant/modifier groups for
// the DTO, or null when the product carries no variant/modifier data at all.
// Throws priceService.BusinessPriceError on any corrupt GHS configuration
// (caller excludes the item — fail closed per identity).
function serializeVariantGhs(rawVariants, rawModifierGroups, baseGhs) {
    const variantsOut = _normalizedVariantGroups(rawVariants);
    const modifiersOut = _normalizedModifierGroups(rawModifierGroups);
    const hasVariants = variantsOut.length > 0;
    const hasModifiers = modifiersOut.length > 0;
    if (!hasVariants && !hasModifiers) return null;

    // Canonicalization (typing + precision per delta) happened during shape
    // normalization; now run the price service's own authority for bounds +
    // the positive-worst-case-final-price invariant against the resolved base.
    priceService.validateGhsDeltas({
        baseGhs,
        variants: hasVariants ? variantsOut : undefined,
        modifierGroups: hasModifiers ? modifiersOut : undefined,
    });
    return { variants: hasVariants ? variantsOut : null, modifierGroups: hasModifiers ? modifiersOut : null };
}

function buildItemDto(product, priceRow, windowOpenBySection) {
    // READ-TIME GHS delta authority (see serializeVariantGhs block): a corrupt
    // variant/modifier configuration throws here and the caller EXCLUDES the
    // item (fail closed per identity) — it never reaches the DTO partially
    // validated, and the feed never 500s on one bad row.
    const variantData = serializeVariantGhs(product.variants, product.modifierGroups, priceRow.amountExact);
    const pricing = {
        // Exact 2dp string straight from the effective BusinessPrice row —
        // string, not number, so no client ever floats it (companion §3.2).
        amount: priceService.pesewasToGhsString(priceService.toPesewas(priceRow.amountExact)),
        currency: 'GHS',
        displayCurrency: 'GHS',
        // Informational only — priceUsdc never prices or estimates the item.
        hasUsdcListPrice: product.priceUsdc != null,
    };
    const images = Array.isArray(product.imageUrls) ? product.imageUrls : [];
    const businessCategory = product.businessProfile.category;
    const action = ACTION_BY_CATEGORY[businessCategory] || DEFAULT_ACTION;
    const location = product.location
        ? { locationId: product.location.id, label: product.location.label, distanceKm: null } // D-6: geo distance deferred
        : null;
    const sectionWindowOpen = product.catalogSection
        ? windowOpenBySection.get(product.catalogSection.id)
        : true;

    return {
        id: product.id,
        businessId: product.businessProfile.id,
        bizId: product.businessProfile.bizId,
        businessName: product.businessProfile.businessName,
        businessCategory,
        item: {
            name: product.name,
            slug: product.slug,
            description: product.description,
            imageUrl: images[0] || null,
            images,
            tags: product.tags,
        },
        pricing,
        variants: variantData?.variants ?? null,
        modifierGroups: variantData?.modifierGroups ?? null,
        availability: {
            isAvailable: product.isAvailable, // where-enforced true; stored truth reported
            sectionWindowOpen,
            preparationMins: product.preparationMins,
            deliveryTerms: product.deliveryTerms,
            estimatedDelivery: product.estimatedDelivery,
        },
        location,
        section: product.catalogSection
            ? { id: product.catalogSection.id, name: product.catalogSection.name, taxonomy: product.catalogSection.taxonomy }
            : null,
        action,
        capabilities: {
            orderable: true, // active product of an eligible business (single-item order path exists)
            bookable: businessCategory === 'HOSPITALITY',
            deliverable: Boolean(product.deliveryTerms), // declared per-item delivery support
            dineIn: false, // P1: dine-in capability detection not wired — never claim it
            // ONLY actually-supported rails. GHS checkout is a hard
            // dependency gate (companion §3.3) — no "GHS" here until it ships.
            payableIn: PAYABLE_IN,
        },
        rank: serializeRank(product),
        // Public DTO never exposes owner userId, emails, costPrice,
        // supplierId, totalRevenue, or internal moderation fields (§3.1).
    };
}

// ─── param validation ────────────────────────────────────────────────────────

function parseParams(raw) {
    const params = {};
    const category = raw.category ? String(raw.category).trim() : null;
    if (category && !VALID_CATEGORIES.has(category)) {
        throw new DiscoveryParamError('category', `unknown category: ${category}`);
    }
    params.category = category || null;

    const q = raw.q ? String(raw.q).trim() : null;
    if (q && q.length > MAX_QUERY_LEN) {
        throw new DiscoveryParamError('q', `query longer than ${MAX_QUERY_LEN} characters`);
    }
    params.q = q || null;

    // §3.1: `taxonomy` is a REPEATABLE parameter (?taxonomy=MEALS&taxonomy=
    // DRINKS). Express's query parser yields an array for repeats and a
    // string for a single value; both are accepted. A comma-list inside one
    // value is NOT a taxonomy split — it is simply an unknown id → 422
    // (no silent fuzzy parsing of client input).
    params.taxonomies = [];
    const rawTaxonomies = raw.taxonomy == null ? [] : Array.isArray(raw.taxonomy) ? raw.taxonomy : [raw.taxonomy];
    for (const t of rawTaxonomies) {
        const value = String(t).trim();
        if (!value) continue;
        if (!params.taxonomies.includes(value)) params.taxonomies.push(value); // dedupe, first-seen order
    }
    if (params.taxonomies.length > MAX_TAXONOMY_CHIPS) {
        throw new DiscoveryParamError('taxonomy', `at most ${MAX_TAXONOMY_CHIPS} taxonomy filters per request`);
    }
    params.city = raw.city ? String(raw.city).trim().slice(0, 100) : null;
    params.region = raw.region ? String(raw.region).trim().slice(0, 100) : null;

    let limit = parseInt(raw.limit, 10);
    if (Number.isNaN(limit)) limit = DEFAULT_LIMIT;
    if (limit < 1 || limit > MAX_LIMIT) {
        throw new DiscoveryParamError('limit', `limit must be between 1 and ${MAX_LIMIT}`);
    }
    params.limit = limit;

    if (raw.cursor) {
        if (String(raw.cursor).length > CURSOR_RAW_MAX_LEN) {
            throw new DiscoveryParamError('cursor', 'cursor longer than ' + CURSOR_RAW_MAX_LEN + ' characters');
        }
        const key = decodeCursor(raw.cursor);
        if (!key) throw new DiscoveryParamError('cursor', 'malformed or unsupported cursor');
        params.key = key;
    }
    return params;
}

class DiscoveryParamError extends Error {
    constructor(field, message) {
        super(message);
        this.name = 'DiscoveryParamError';
        this.field = field;
    }
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function searchDiscoveryItems(prisma, rawParams, { useCache = true } = {}) {
    const params = parseParams(rawParams);

    // Taxonomy chips are validated against the canonical mapping table so a
    // typo never silently degrades to an empty feed, and an unknown chip is
    // a 422, not a zero-item success. Every requested id must be a known,
    // ACTIVE chip. §4 reserved id: UNMAPPED means "no chip" — its items stay
    // discoverable under the category's GENERAL feed (no taxonomy filter),
    // but UNMAPPED is NOT a requestable chip (filtering "all unmapped
    // sections" is not an owner-approved browse mode and would leak a
    // moderation/debug surface). Requesting it is a 422.
    if (params.taxonomies.length > 0) {
        if (params.taxonomies.includes('UNMAPPED')) {
            throw new DiscoveryParamError('taxonomy',
                'UNMAPPED is not a requestable chip — unmapped sections appear only in the general feed');
        }
        const chips = await prisma.catalogSectionTaxonomy.findMany({
            where: { id: { in: params.taxonomies } },
            select: { id: true, isActive: true },
        });
        const activeIds = new Set(chips.filter((c) => c.isActive).map((c) => c.id));
        const unknown = params.taxonomies.filter((t) => !activeIds.has(t));
        if (unknown.length > 0) {
            throw new DiscoveryParamError('taxonomy',
                `unknown or inactive taxonomy: ${unknown.join(', ')}`);
        }
    }

    // §3.2: first-page cache (TTL 60s, normalized query key). Cursor pages
    // are never cached — a cursor is a position in a moving feed.
    if (useCache && !params.key) {
        const key = cacheKey(params);
        const cached = await getCached(key);
        if (cached) return cached;
        const result = await runQuery(prisma, params);
        await setCached(key, result);
        return result;
    }
    return runQuery(prisma, params);
}

async function runQuery(prisma, params) {
    // First page starts from the request cursor key (or the beginning); the
    // refill loop advances it internally.
    let lastConsumed = null;
    let lastOverflow = false;
    let rounds = 0;
    let scanned = 0;
    let take = Math.min(params.limit + 1, MAX_ROUND_TAKE);
    const emitted = [];
    const nowMin = nowMinutesUtc();

    while (emitted.length < params.limit && rounds < MAX_ROUNDS && scanned < MAX_SCAN_ROWS) {
        const need = params.limit - emitted.length;
        const key = rounds === 0 ? (params.key || null) : cursorKeyOf(lastConsumed);
        const where = buildWhere({ ...params, key });
        // Adaptive take (2026-10-19): clamp the fetch to the remaining row
        // budget so the per-request work cap is exact even at the boundary.
        const effTake = Math.min(take, MAX_SCAN_ROWS - scanned);
        const rows = await fetchRound(prisma, where, effTake);
        rounds += 1;
        if (rows.length === 0) {
            lastOverflow = false;
            break;
        }
        scanned += rows.length;
        // §4: compute the section window once per section per request batch.
        const windowBySection = new Map();
        for (const row of rows) {
            if (row.catalogSection && !windowBySection.has(row.catalogSection.id)) {
                windowBySection.set(row.catalogSection.id, sectionWindowOpen(row.catalogSection, nowMin));
            }
        }
        // Examine fetched rows in order, emitting eligible ones until the
        // page is exact. lastConsumed tracks the LAST EXAMINED row — the
        // cursor never skips an unexamined row, so §4 page exactness holds
        // with any take size. When the page fills mid-fetch the remaining
        // fetched rows stay UNEXAMINED (cursor rests before them — the next
        // page re-fetches them; correctness over re-examination cost).
        const emittedBefore = emitted.length;
        let examinedAll = true;
        for (const row of rows) {
            if (emitted.length >= params.limit) { examinedAll = false; break; }
            lastConsumed = row;
            if (row.catalogSection && !windowBySection.get(row.catalogSection.id)) continue;
            emitted.push(row);
        }
        // Overflow truth: more source may exist when the fetch hit its take
        // cap, or we stopped examining with fetched rows still behind the
        // cursor. A short fetch (< take, fully examined) is real exhaustion.
        lastOverflow = !examinedAll || rows.length === effTake;
        if (!lastOverflow) break; // source exhausted under the where-clause
        if (emitted.length >= params.limit) break;
        // Grow after a zero-emit round (re-walk closed candidates faster);
        // reset after a productive round (cheap tail fetches).
        take = emitted.length === emittedBefore
            ? Math.min(take * 2, MAX_ROUND_TAKE)
            : Math.min(params.limit - emitted.length + 1, MAX_ROUND_TAKE);
    }

    const hasMore = lastOverflow && Boolean(lastConsumed);

    // §4: the DTO reports the same batch-computed window value used by the
    // filter — one evaluation per section per request.
    const windowOpenBySection = new Map();
    for (const row of emitted) {
        if (row.catalogSection && !windowOpenBySection.has(row.catalogSection.id)) {
            windowOpenBySection.set(row.catalogSection.id, sectionWindowOpen(row.catalogSection, nowMin));
        }
    }

    // Batch price resolution through the price service (same eligibility
    // decision as the single resolver). A row whose price raced away between
    // the candidate query and this resolution is DROPPED — never a fallback
    // to priceUsdc, an estimate, or a conversion.
    const priceMap = await priceService.resolveEffectiveGhsPrices(
        prisma, emitted.map((r) => r.id));
    const items = [];
    for (const row of emitted) {
        const priceRow = priceMap.get(row.id);
        if (!priceRow) {
            logger.warn(`[DiscoveryFeed] product ${row.id} passed the price predicate but resolved no eligible GHS price — excluding (no fallback)`);
            continue;
        }
        try {
            items.push(buildItemDto(row, priceRow, windowOpenBySection));
        } catch (err) {
            if (err instanceof priceService.BusinessPriceError) {
                logger.warn(`[DiscoveryFeed] product ${row.id} excluded — corrupt variant/modifier GHS configuration (${err.code ?? err.message})`);
                continue; // fail closed per identity: never a 500, never a partial DTO
            }
            throw err;
        }
    }

    return {
        items,
        nextCursor: hasMore ? encodeCursor(lastConsumed) : null,
        cache: { maxAgeSec: CACHE_TTL_SECONDS },
    };
}

function cursorKeyOf(row) {
    if (!row) return null;
    return { totalOrders: row.totalOrders, createdAt: row.createdAt, id: row.id };
}

module.exports = {
    searchDiscoveryItems,
    parseParams,
    DiscoveryParamError,
    invalidateDiscoveryFeedCache,
    // test surface
    _internal: {
        sectionWindowOpen,
        parseHHMM,
        encodeCursor,
        decodeCursor,
        buildWhere,
        serializeVariantGhs,
        parseParams,
        VALID_CATEGORIES,
    },
};
