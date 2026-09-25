'use strict';

// =============================================================================
// §r40.4 — SERVER-OWNED RESTOCK INTENT (final-audit P1 redesign).
//
// The independent audit rejected client-derived restock identity on four
// grounds, all fixed by making the SERVER the authority:
//
//   1. (itemId, canonicalQuantity) → one UUID conflated two genuinely
//      distinct restocks of the same item and quantity. Intents are
//      OPERATION-level: every registered intent has its own identity.
//   2. clear-by-(item, qty) let a LATE SUCCESS of an old request delete a
//      NEWER intent's key. Resolution here is keyed by intent id only.
//   3. A client-side 24h TTL minted a fresh key for an operation that may
//      have committed 25h ago → duplicate execution. Intents have NO TTL:
//      they are durable until there is AUTHORITATIVE evidence of
//      resolution (execution observed + acknowledged, or explicit cancel).
//   4. localStorage-unavailable fallback silently proceeded without durable
//      retry identity. The identity now lives in PostgreSQL — browser
//      storage is only a cache, never the authority.
//
// The intent id doubles as the restock idempotency key: the client registers
// the intent BEFORE sending the restock, so after any browser/storage loss
// the unresolved list recovers the exact prior operation (with its stored
// execution result, if the request committed unseen).
//
// State machine (transitions guarded here, enforced by tests):
//
//   PENDING ──restock executes/replays──▶ EXECUTED ──client observed──▶ ACKNOWLEDGED
//      │
//      └──explicit operator cancel──▶ CANCELLED
//                                        │
//   CANCELLED ──restock actually committed──▶ EXECUTED   (truth wins: the
//                                        operator cancelled on a guess; a
//                                        committed financial operation must
//                                        resurface in the recovery list)
//   EXECUTED ──cancel──▶ FORBIDDEN (409): an executed operation can only be
//   acknowledged, never cancelled.
//
// RETENTION (§r40.5 P2 follow-up, deliberately deferred): resolved intents
// (ACKNOWLEDGED / CANCELLED) are retained forever as audit evidence — the
// operation identity and its exact registered payload stay queryable. The
// recovery query only ever selects UNRESOLVED statuses, so retention growth
// does not slow recovery, but the table itself grows without bound at high
// volume. A future archival/retention mechanism (e.g. move resolved rows
// older than a business-configured horizon to an archive table, keeping the
// last N resolved rows hot) is the recorded follow-up. There is deliberately
// NO client-side TTL and resolved intents are never deleted by the client.
//
// quantity is stored as the EXACT decimal string the operator submitted and
// is resent VERBATIM on retry: the restock fingerprint (v2) digests the raw
// string, so "12.50" and "12.5" are different fingerprints and a recovered
// retry must not drift the string.
// =============================================================================

const { Prisma } = require('@prisma/client');

// Same economic grammar as the restock service (§Wave-1B): plain decimal
// strings only — no exponents, signs, whitespace or JSON numbers. The restock
// endpoint accepts numbers for legacy clients, but intent registration is the
// NEW r40.4 contract and is strict from day one.
const DECIMAL_STRING = /^\d+(?:\.\d+)?$/;
const MAX_ECONOMIC_DP = 8;
const MAX_ECONOMIC_MAGNITUDE = '1000000000000'; // 1e12
const MIN_QUANTITY = '0.00000001'; // the restock service's own minimum

// Statuses: single source of truth.
const STATUS = {
    PENDING: 'PENDING',
    EXECUTED: 'EXECUTED',
    CANCELLED: 'CANCELLED',
    ACKNOWLEDGED: 'ACKNOWLEDGED',
};
// Everything the recovery list must still surface to the operator.
const UNRESOLVED = [STATUS.PENDING, STATUS.EXECUTED];

function intentError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

// Validates and returns the EXACT quantity string (verbatim, no
// canonicalization drift) or throws a RESTOCK_INTENT_* error.
function assertQuantityString(quantity) {
    if (typeof quantity !== 'string' || !DECIMAL_STRING.test(quantity)) {
        throw intentError('RESTOCK_INTENT_INVALID_QUANTITY',
            'Quantity must be a plain decimal string (e.g. "12.5") — it is stored and resent verbatim.');
    }
    if (quantity.length > 64) {
        throw intentError('RESTOCK_INTENT_INVALID_QUANTITY', 'Quantity string is too long.');
    }
    const d = new Prisma.Decimal(quantity);
    if (d.decimalPlaces() > MAX_ECONOMIC_DP) {
        throw intentError('RESTOCK_INTENT_INVALID_QUANTITY', 'Quantity allows at most 8 decimal places.');
    }
    if (d.lessThan(MIN_QUANTITY)) {
        throw intentError('RESTOCK_INTENT_INVALID_QUANTITY', 'Quantity must be at least 0.00000001.');
    }
    if (d.greaterThan(MAX_ECONOMIC_MAGNITUDE)) {
        throw intentError('RESTOCK_INTENT_INVALID_QUANTITY', 'Quantity is out of range.');
    }
    return quantity;
}

class InventoryRestockIntentService {
    constructor(prisma) { this.prisma = prisma; }

    // Register a NEW restock operation. Operation-level identity: calling
    // this twice for the same item/quantity creates two DISTINCT intents —
    // two genuinely separate purchases, exactly as the backend's restock
    // idempotency contract intends.
    async createIntent({ businessProfileId, userId, itemId, quantity }) {
        if (!businessProfileId) throw intentError('BUSINESS_CONTEXT_REQUIRED', 'Business context required.');
        if (typeof userId !== 'number') throw intentError('AUTHENTICATION_REQUIRED', 'Authentication required.', 401);
        if (typeof itemId !== 'string' || !itemId) throw intentError('RESTOCK_INTENT_ITEM_REQUIRED', 'Item is required.');
        const qty = assertQuantityString(quantity);

        const item = await this.prisma.inventoryItem.findFirst({
            where: { id: itemId, businessProfileId },
            select: { id: true, name: true, unit: true },
        });
        if (!item) throw intentError('RESTOCK_ITEM_NOT_FOUND', 'Item not found.', 404);

        const intent = await this.prisma.inventoryRestockIntent.create({
            data: { businessProfileId, itemId, quantity: qty, createdBy: userId },
        });
        return intent;
    }

    // The recovery list: every operation whose outcome the client has not
    // OBSERVED (never executed, or executed but unacknowledged). No TTL —
    // unresolved intents stay resolvable for as long as it takes.
    async listUnresolved({ businessProfileId }) {
        return this.prisma.inventoryRestockIntent.findMany({
            where: { businessProfileId, status: { in: UNRESOLVED } },
            orderBy: { createdAt: 'asc' },
        });
    }

    // The restock service calls this after the operation executes or
    // replays — authoritative evidence of execution, stored with the result
    // so a browser that lost the response can recover the outcome. Allowed
    // from PENDING (normal) and CANCELLED (the operator cancelled on a
    // guess, but the request had already committed — truth wins). An
    // ACKNOWLEDGED intent is never touched again; an already-EXECUTED
    // intent keeps its FIRST executedAt (idempotent re-mark).
    async markExecuted({ businessProfileId, id, result }, tx = this.prisma) {
        if (typeof id !== 'string' || !id) return; // keys outside the intent namespace: not our record
        await tx.inventoryRestockIntent.updateMany({
            where: { id, businessProfileId, status: { in: [STATUS.PENDING, STATUS.CANCELLED] } },
            data: { status: STATUS.EXECUTED, executionResult: result ?? undefined, executedAt: new Date() },
        });
    }

    // Client OBSERVED the outcome. Only valid for EXECUTED intents.
    async acknowledge({ businessProfileId, id }) {
        const intent = await this._get({ businessProfileId, id });
        if (intent.status === STATUS.ACKNOWLEDGED) return intent; // idempotent re-ack
        if (intent.status !== STATUS.EXECUTED) {
            throw intentError('RESTOCK_INTENT_NOT_EXECUTED',
                'Only an executed intent can be acknowledged.', 409);
        }
        return this.prisma.inventoryRestockIntent.update({
            where: { id: intent.id },
            data: { status: STATUS.ACKNOWLEDGED, acknowledgedAt: new Date() },
        });
    }

    // Explicit operator cancel — ONLY while no execution has been observed.
    // An EXECUTED intent refuses cancellation: the restock already happened;
    // the operator must acknowledge it instead (the recovery list says so).
    //
    // §r40.5 — CONDITIONAL STATE TRANSITION (final-audit P1). The previous
    // read-then-act form (SELECT the intent, check PENDING, then UPDATE
    // unconditionally) left a race: cancel could read PENDING while a
    // concurrent restock committed PENDING → EXECUTED, and cancel's stale
    // update then overwrote EXECUTED with CANCELLED — violating the
    // documented invariant that an executed restock can never become
    // cancelled. The row itself is now the ONLY authority: a single
    // conditional UPDATE wins only while the committed status is still
    // PENDING (PostgreSQL re-checks the WHERE clause on the newest row
    // version after any row-lock wait), and the affected-row count
    // classifies the outcome. No preceding SELECT is the authority.
    async cancel({ businessProfileId, id }) {
        if (typeof id !== 'string' || !id) throw intentError('RESTOCK_INTENT_NOT_FOUND', 'Restock intent not found.', 404);
        const won = await this.prisma.inventoryRestockIntent.updateMany({
            where: { id, businessProfileId, status: STATUS.PENDING },
            data: { status: STATUS.CANCELLED },
        });
        if (won.count === 1) return this._get({ businessProfileId, id });
        // The transition lost (or was already decided). Classify from the
        // COMMITTED state — never from a pre-read snapshot.
        const intent = await this.prisma.inventoryRestockIntent.findFirst({ where: { id, businessProfileId } });
        if (!intent) throw intentError('RESTOCK_INTENT_NOT_FOUND', 'Restock intent not found.', 404);
        if (intent.status === STATUS.CANCELLED) return intent; // idempotent re-cancel
        // EXECUTED (or already ACKNOWLEDGED): truth wins — the restock
        // actually happened and can only be acknowledged, never cancelled.
        throw intentError('RESTOCK_INTENT_ALREADY_EXECUTED',
            'This restock already executed — it can only be acknowledged, not cancelled.', 409);
    }

    async _get({ businessProfileId, id }) {
        if (typeof id !== 'string' || !id) throw intentError('RESTOCK_INTENT_NOT_FOUND', 'Restock intent not found.', 404);
        const intent = await this.prisma.inventoryRestockIntent.findFirst({ where: { id, businessProfileId } });
        if (!intent) throw intentError('RESTOCK_INTENT_NOT_FOUND', 'Restock intent not found.', 404);
        return intent;
    }
}

module.exports = {
    InventoryRestockIntentService,
    STATUS,
    UNRESOLVED_STATUSES: UNRESOLVED,
    assertQuantityString,
};
