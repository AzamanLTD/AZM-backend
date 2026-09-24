// services/businessOS/dineInCashCloseService.js
// =============================================================================
// r35/P0 — canonical dine-in CASH CLOSE settlement authority.
//
// Replaces the legacy inline POST /api/business-os/pos/cash-close-tab, which:
//   • looked up idempotencyKey WITHOUT business scope (any business's key
//     returned that business's tab);
//   • read the OPEN tab then closed it with an unguarded update (concurrent
//     closes both succeeded, double-writing the ledger);
//   • wrote the BusinessLedgerEntry OUTSIDE the transaction, swallowing its
//     failure (PAID tab + missing financial record);
//   • accepted client-shaped tip/cash values through blind parseFloat.
//
// Contract (mirrors the canonical PosOrderService settlement boundary):
//   • one serializable transaction covers the idempotency claim, the
//     OPEN -> PAID CAS transition, and the BusinessLedgerEntry;
//   • totals are re-derived from the durable tab items (never the client);
//   • tax comes from the business's default tax preset — the same machinery
//     the invoice/POS settlement uses, replacing the hardcoded 5%;
//   • a business-scoped idempotency key replays the exact durable result;
//     the same key with a different request fails closed;
//   • a key that belongs to another business is refused, never replayed;
//   • two concurrent different keys against one OPEN tab produce exactly one
//     close — the loser gets an honest conflict;
//   • ledger failure rolls the tab closure back; nothing is swallowed.
// =============================================================================

'use strict';

const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { computeTaxLines } = require('../../utils/invoiceMath');
const ledger = require('../ledgerService');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
const isSerializableConflict = (error) => error?.code === 'P2034';
const waitForRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt)));

const fail = (code, message = code) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

// r37/P1 — STRICT EXACT-DECIMAL money parsing on the platform's ONE
// canonical parser (ledger.toExactDecimal — the same authority as every
// other financial path). This deliberately REJECTS what JS Number()
// accepted before:
//   • exponent notation        ('1e3' — the regex has no exponent form)
//   • whitespace padding       (' 5.50 ' — rejected before the canonical
//                              trim, so padded input can never slip through)
//   • >8 decimal places        ('0.123456789' — was silently rounded to 6dp,
//                              losing precision against Decimal(20,8) storage)
//   • NaN / Infinity / negative / oversized values
// The result is a Prisma.Decimal — Decimal(20,8) authority is preserved
// end-to-end through the transaction instead of a lossy JS float.
const parseMoney = (value, field, { required = false } = {}) => {
    if (value === null || value === undefined || value === '') {
        if (required) throw fail('INVALID_INPUT', `${field} is required.`);
        return new Prisma.Decimal(0);
    }
    if (typeof value === 'string' && value !== value.trim()) {
        throw fail('INVALID_INPUT', `${field}: whitespace-padded values are rejected.`);
    }
    let dec;
    try {
        dec = ledger.toExactDecimal(value, field);
    } catch (e) {
        throw fail('INVALID_INPUT',
            `${field} must be a finite non-negative exact decimal (<= 8 decimals, no exponent, no padding).`);
    }
    if (dec.gte(new Prisma.Decimal('1000000000'))) {
        throw fail('INVALID_INPUT', `${field} is unreasonably large.`);
    }
    return dec;
};

// Replay fingerprint over the EXACT 8-decimal canonical forms — tip/cash are
// now Prisma.Decimal, so the fingerprint pins the precise stored value rather
// than a lossy float rounding.
const fingerprintOf = ({ businessProfileId, actorId, tabId, tip, cash }) =>
    crypto.createHash('sha256').update(JSON.stringify({
        businessProfileId: String(businessProfileId),
        actorId: Number(actorId),
        tabId: String(tabId),
        tip: tip.toFixed(8),
        cash: cash == null ? null : cash.toFixed(8),
    })).digest('hex');

class DineInCashCloseService {
    constructor(prisma) { this.prisma = prisma; }

    // Idempotency replay lookup — keyed by the globally-unique tab column,
    // but authority is business-scoped: another business's key is a refusal,
    // never a replay, and a matching key with a different request fingerprint
    // is a conflict.
    async _findIdempotentClose(businessProfileId, idempotencyKey, fingerprint, client = this.prisma) {
        if (!idempotencyKey) return null;
        const tab = await client.dineInTab.findFirst({ where: { idempotencyKey } });
        if (!tab) return null;
        if (tab.businessProfileId !== businessProfileId) {
            throw fail('IDEMPOTENCY_KEY_FOREIGN', 'Idempotency key already belongs to another business.');
        }
        if (fingerprint) {
            const ledger = await client.businessLedgerEntry.findFirst({
                where: { sourceType: 'DINE_IN_CASH', sourceId: tab.id },
                select: { metadata: true },
            });
            const stored = ledger?.metadata?.dineInCashCloseFingerprint;
            if (stored && stored !== fingerprint) {
                throw fail('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency key already used for a different cash close.');
            }
        }
        return tab;
    }

    // Rebuild the exact durable response for a committed close.
    // r38/P1 — EXACT REPLAY: the replay must reproduce the committed
    // economic result bit-for-bit, including 7th/8th decimals. Change is
    // recomputed on Prisma.Decimal (the stored Decimal(20,8) authority) and
    // serialized EXACTLY like the original response (Number of the 8dp
    // fixed string), so a committed change of 0.00000001 replays as
    // 0.00000001 — never rounded to 0 through 6dp JS math.
    _replayResult(tab) {
        const dec = (v) => (v == null ? new Prisma.Decimal(0) : new Prisma.Decimal(v));
        const subtotalDec = dec(tab.subtotalUsdc);
        const taxTotalDec = dec(tab.taxTotalUsdc);
        const tipDec = dec(tab.tipUsdc);
        const grandTotalDec = dec(tab.grandTotalUsdc);
        const cashDec = tab.cashReceived == null ? null : dec(tab.cashReceived);
        const changeDec = cashDec == null ? new Prisma.Decimal(0) : cashDec.minus(grandTotalDec);
        return {
            tab,
            duplicate: true,
            subtotal: Number(subtotalDec.toFixed(8)),
            taxTotal: Number(taxTotalDec.toFixed(8)),
            tip: Number(tipDec.toFixed(8)),
            grandTotal: Number(grandTotalDec.toFixed(8)),
            change: Number(changeDec.toFixed(8)),
        };
    }

    async closeTab({ businessProfileId, actorId, tabId, cashReceived, tipAmount, idempotencyKey }) {
        if (!businessProfileId) throw fail('INVALID_INPUT', 'Business context required.');
        if (!actorId) throw fail('INVALID_INPUT', 'Authentication required.');
        if (!tabId || typeof tabId !== 'string') throw fail('INVALID_INPUT', 'Tab ID required.');
        if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 190)) {
            throw fail('INVALID_INPUT', 'Invalid idempotency key.');
        }
        const key = idempotencyKey ? idempotencyKey.trim() : null;
        const tip = parseMoney(tipAmount, 'tipAmount');
        const cash = cashReceived == null || cashReceived === '' ? null : parseMoney(cashReceived, 'cashReceived');

        const fingerprint = key ? fingerprintOf({ businessProfileId, actorId, tabId, tip, cash }) : null;

        // Fast-path replay of a committed close (exact durable result).
        const committed = await this._findIdempotentClose(businessProfileId, key, fingerprint);
        if (committed) return this._replayResult(committed);

        for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
            try {
                const result = await this.prisma.$transaction(async (tx) => {
                    // Re-check inside the transaction: a same-key contender may
                    // have committed between the fast-path lookup and now.
                    const txCommitted = await this._findIdempotentClose(businessProfileId, key, fingerprint, tx);
                    if (txCommitted) return this._replayResult(txCommitted);

                    const tab = await tx.dineInTab.findUnique({ where: { id: tabId }, include: { items: true } });
                    if (!tab || tab.businessProfileId !== businessProfileId) {
                        throw fail('TAB_NOT_FOUND', 'Open tab not found.');
                    }
                    if (tab.status !== 'OPEN') {
                        throw fail('TAB_ALREADY_CLOSED', `Tab is ${tab.status}, not OPEN.`);
                    }
                    if (tab.items.length === 0) throw fail('INVALID_INPUT', 'Cannot close an empty tab.');

                    // Totals from durable items only — never client input.
                    // r37: Decimal(20,8) authority end-to-end — no lossy
                    // JS-float rounding anywhere between parse, arithmetic,
                    // storage and the ledger row.
                    const subtotalDec = tab.items.reduce(
                        (sum, item) => sum.plus(new Prisma.Decimal(item.lineTotalUsdc)),
                        new Prisma.Decimal(0)
                    );
                    const subtotal = Number(subtotalDec.toFixed(8));

                    // Tax via the business's default preset — the same
                    // machinery as the invoice/POS settlement boundary.
                    const preset = tx.businessTaxPreset
                        ? await tx.businessTaxPreset.findFirst({
                            where: { businessProfileId, isDefault: true },
                            orderBy: { createdAt: 'asc' },
                            select: { name: true, type: true, value: true },
                        })
                        : null;
                    const taxResult = computeTaxLines(preset ? [preset] : [], subtotal);
                    const taxTotalDec = new Prisma.Decimal(String(taxResult.taxTotal));
                    const grandTotalDec = subtotalDec.plus(taxTotalDec).plus(tip);
                    const grandTotal = Number(grandTotalDec.toFixed(8));

                    if (cash != null && cash.lt(grandTotalDec)) {
                        throw fail('INSUFFICIENT_CASH', 'Insufficient cash received.');
                    }
                    const changeDec = cash == null ? new Prisma.Decimal(0) : cash.minus(grandTotalDec);
                    const change = Number(changeDec.toFixed(8));

                    // CAS: exactly one OPEN -> PAID transition can win.
                    const claimed = await tx.dineInTab.updateMany({
                        where: { id: tabId, businessProfileId, status: 'OPEN' },
                        data: {
                            status: 'PAID',
                            closedAt: new Date(),
                            subtotalUsdc: subtotalDec,
                            taxTotalUsdc: taxTotalDec,
                            tipUsdc: tip,
                            grandTotalUsdc: grandTotalDec,
                            paymentMethod: 'CASH',
                            idempotencyKey: key,
                            cashReceived: cash,
                        },
                    });
                    if (claimed.count !== 1) {
                        // A different-key contender closed the tab first.
                        // Converge on a same-key replay; otherwise conflict.
                        const current = await tx.dineInTab.findUnique({ where: { id: tabId } });
                        if (key && current?.idempotencyKey === key) return this._replayResult(current);
                        throw fail('TAB_ALREADY_CLOSED', 'Tab was closed by another request.');
                    }

                    // The financial record commits WITH the closure or not at all.
                    await tx.businessLedgerEntry.create({
                        data: {
                            businessProfileId,
                            type: 'INCOME',
                            category: 'DINE_IN',
                            description: `Dine-in cash close (${tab.id.substring(0, 8)})`,
                            amount: grandTotalDec, // Decimal — no float round-trip
                            amountGhs: grandTotalDec,
                            sourceType: 'DINE_IN_CASH',
                            sourceId: tab.id,
                            metadata: {
                                tabId: tab.id,
                                tip: tip.toFixed(8),
                                subtotal: subtotalDec.toFixed(8),
                                taxTotal: taxTotalDec.toFixed(8),
                                taxLines: taxResult.taxLines,
                                paymentMethod: 'CASH',
                                ...(cash != null ? { cashReceived: cash.toFixed(8), cashChange: changeDec.toFixed(8) } : {}),
                                ...(fingerprint ? { dineInCashCloseFingerprint: fingerprint } : {}),
                            },
                        },
                    });

                    const closed = await tx.dineInTab.findUnique({ where: { id: tabId } });
                    return {
                        tab: closed, duplicate: false, subtotal,
                        taxTotal: Number(taxTotalDec.toFixed(8)),
                        tip: Number(tip.toFixed(8)),
                        grandTotal, change,
                    };
                }, { isolationLevel: 'Serializable' });
                return result;
            } catch (error) {
                // Same-key concurrent duplicate: the winner's unique
                // idempotencyKey commit makes ours replay the durable result.
                if (error?.code === 'P2002' && key) {
                    const replay = await this._findIdempotentClose(businessProfileId, key, fingerprint);
                    if (replay) return this._replayResult(replay);
                }
                if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) throw error;
                await waitForRetry(attempt);
            }
        }
        throw new Error('Could not close dine-in tab after retries.');
    }
}

module.exports = { DineInCashCloseService };
