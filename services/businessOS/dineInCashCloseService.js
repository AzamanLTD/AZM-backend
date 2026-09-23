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
const { computeTaxLines } = require('../../utils/invoiceMath');

const SERIALIZABLE_RETRY_LIMIT = 3;
const SERIALIZABLE_BACKOFF_MS = 10;
const isSerializableConflict = (error) => error?.code === 'P2034';
const waitForRetry = (attempt) => new Promise((resolve) => setTimeout(resolve, SERIALIZABLE_BACKOFF_MS * (2 ** attempt)));

const fail = (code, message = code) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

// Exact money parsing: finite, non-negative, 6-decimal canonical rounding.
// NaN/Infinity/negative/oversized inputs fail closed.
const parseMoney = (value, field, { required = false } = {}) => {
    if (value === null || value === undefined || value === '') {
        if (required) throw fail('INVALID_INPUT', `${field} is required.`);
        return 0;
    }
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) throw fail('INVALID_INPUT', `${field} must be a finite number.`);
    if (n < 0) throw fail('INVALID_INPUT', `${field} cannot be negative.`);
    if (Math.abs(n) > 1e9) throw fail('INVALID_INPUT', `${field} is unreasonably large.`);
    return Math.round(n * 1e6) / 1e6;
};

const fingerprintOf = ({ businessProfileId, actorId, tabId, tip, cash }) =>
    crypto.createHash('sha256').update(JSON.stringify({
        businessProfileId: String(businessProfileId),
        actorId: Number(actorId),
        tabId: String(tabId),
        tip,
        cash,
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
    _replayResult(tab) {
        const subtotal = Number(tab.subtotalUsdc || 0);
        const taxTotal = Number(tab.taxTotalUsdc || 0);
        const tip = Number(tab.tipUsdc || 0);
        const grandTotal = Number(tab.grandTotalUsdc || 0);
        const cash = tab.cashReceived == null ? null : Number(tab.cashReceived);
        return {
            tab,
            duplicate: true,
            subtotal,
            taxTotal,
            tip,
            grandTotal,
            change: cash == null ? 0 : Math.round((cash - grandTotal) * 1e6) / 1e6,
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
                    const subtotal = Math.round(tab.items.reduce((sum, item) => sum + Number(item.lineTotalUsdc), 0) * 1e6) / 1e6;

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
                    const taxTotal = taxResult.taxTotal;
                    const grandTotal = Math.round((subtotal + taxTotal + tip) * 1e6) / 1e6;

                    if (cash != null && cash < grandTotal) {
                        throw fail('INSUFFICIENT_CASH', 'Insufficient cash received.');
                    }
                    const change = cash == null ? 0 : Math.round((cash - grandTotal) * 1e6) / 1e6;

                    // CAS: exactly one OPEN -> PAID transition can win.
                    const claimed = await tx.dineInTab.updateMany({
                        where: { id: tabId, businessProfileId, status: 'OPEN' },
                        data: {
                            status: 'PAID',
                            closedAt: new Date(),
                            subtotalUsdc: subtotal,
                            taxTotalUsdc: taxTotal,
                            tipUsdc: tip,
                            grandTotalUsdc: grandTotal,
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
                            amount: grandTotal,
                            amountGhs: grandTotal,
                            sourceType: 'DINE_IN_CASH',
                            sourceId: tab.id,
                            metadata: {
                                tabId: tab.id,
                                tip,
                                subtotal,
                                taxTotal,
                                taxLines: taxResult.taxLines,
                                paymentMethod: 'CASH',
                                ...(cash != null ? { cashReceived: cash, cashChange: change } : {}),
                                ...(fingerprint ? { dineInCashCloseFingerprint: fingerprint } : {}),
                            },
                        },
                    });

                    const closed = await tx.dineInTab.findUnique({ where: { id: tabId } });
                    return { tab: closed, duplicate: false, subtotal, taxTotal, tip, grandTotal, change };
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
