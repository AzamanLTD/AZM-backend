// src/services/payoutRiskGate.js
// =============================================================================
// ONE risk seam for every money-out route.
//
// Why this exists: the native-GHS payout route called the fraud engine with
// `action: 'WITHDRAWAL_GHS'` and then read `fraud.blocked`. The engine keys every
// rule off `tx.type` and answers with `allowed`, so NO rule ran and NO answer was
// read — the gate was decorative. The BANK route had no gate at all. Two callers
// with two different ideas of the contract is how that happens, so the contract
// now lives in one place.
//
// It is NOT a second fraud authority: it calls the same
// fraudDetectionService.evaluate() the rest of the platform uses.
//
// THREE OUTCOMES, all explicit:
//   ALLOW      — the authority answered and no BLOCK-severity rule fired.
//   BLOCK      — the authority answered and a BLOCK-severity rule fired (403).
//   UNAVAILABLE — the authority could not answer (503). A risk service that is
//                 down is not permission to pay out: the payout is refused
//                 BEFORE any debit, quote consumption or reservation, and the
//                 customer is told it is temporary. The old behaviour (log a
//                 warning, continue) turned an outage into a bypass.
// =============================================================================

const fraudService = require('../../services/fraudDetectionService');
const logger = require('../config/logger');

// Velocity counts EVERY withdrawal-shaped TransactionHistory type, not just the
// one this route writes. Native-GHS payouts and the older fiat path both land as
// WITHDRAWAL_FIAT today, and crypto withdrawals are withdrawals too: a customer
// must not be able to alternate rails to stay under the limit on each.
// (TransactionHistory.type is the TransactionType enum; a type that does not
// exist there can never match, so the list only holds real values.)
const WITHDRAWAL_VELOCITY_TYPES = ['WITHDRAWAL_FIAT', 'WITHDRAWAL_CRYPTO'];

function accountAgeHoursOf(user) {
    if (!user) return undefined;
    const created = user.createdAt || user.created_at;
    if (!created) return undefined;
    const ms = Date.now() - new Date(created).getTime();
    if (!Number.isFinite(ms)) return undefined;
    return ms / (1000 * 60 * 60);
}

/**
 * @returns {Promise<{ok:boolean, status?:number, code?:string, message?:string,
 *                    rules?:string[], riskScore?:number, decision?:object}>}
 */
async function evaluatePayoutRisk({
    userId,
    amount,
    asset = 'USDC',
    destination = null,
    rail = null,
    accountAgeHours = undefined,
    channel = 'PAYOUT',
    // The request-scoped client. The fraud authority must read through the SAME
    // client the caller uses, so a test (or a future read replica) can hand it a
    // specific one instead of a hidden module singleton.
    db = null,
} = {}) {
    const numeric = Number(amount);
    // The exact figure as the caller stated it. A float is fine for a rough
    // screen; it is NOT fine for deciding whether a GHS payout crosses a
    // configured threshold, so the exact value travels with it.
    const amountExact = amount === null || amount === undefined || amount === '' ? undefined : String(amount);
    let decision;
    try {
        decision = await fraudService.evaluate({
            userId,
            // The canonical type the engine understands. `asset` is what makes
            // the amount dimension asset-aware.
            type: 'WITHDRAWAL',
            asset: String(asset || 'USDC').toUpperCase(),
            amount: Number.isFinite(numeric) ? numeric : undefined,
            amountExact,
            destination: destination || undefined,
            rail: rail || undefined,
            accountAgeHours,
            velocityTypes: WITHDRAWAL_VELOCITY_TYPES,
            channel,
            // A money-out decision needs EVERY query behind it to have answered.
            // Best-effort mode reported an unreadable database as "zero risk".
            riskDataMode: 'FAIL_CLOSED',
            ...(db ? { db } : {}),
        });
    } catch (err) {
        // Three distinct unavailability classes, each refused the same way and
        // each distinguishable in the logs:
        //   RISK_DATA_UNAVAILABLE — a required risk query failed. "We could not
        //                           look" is NOT "nothing to see".
        //   RISK_POLICY_INVALID   — the configured GHS policy cannot be trusted.
        //   RISK_SERVICE_UNAVAILABLE — the authority itself is down.
        const code = err && err.code === 'RISK_DATA_UNAVAILABLE'
            ? 'RISK_DATA_UNAVAILABLE'
            : (err && err.code === 'RISK_POLICY_INVALID') || /GHS_RISK_AMOUNT_POLICY/.test(String(err && err.message))
                ? 'RISK_POLICY_INVALID'
                : 'RISK_SERVICE_UNAVAILABLE';
        logger.error({ err: err && err.message, code, userId, channel }, '[payoutRiskGate] risk authority unavailable');
        return {
            ok: false,
            status: 503,
            code,
            message: 'Security checks are temporarily unavailable, so this withdrawal was not started. Nothing was debited. Please try again shortly.',
            unavailable: true,
        };
    }

    const rules = (decision.triggeredRules || []).map((r) => r.id);
    if (decision.policyGaps && decision.policyGaps.length) {
        // A MISSING POLICY IS A REFUSAL. This used to log a warning and continue,
        // which meant a GHS payout was cleared on a risk dimension that was never
        // evaluated — the gate existed but the amount question was never asked.
        // The platform still has no approved GHS thresholds; until it does, the
        // native-GHS payout path stays closed rather than guessing.
        logger.error({ userId, channel, policyGaps: decision.policyGaps, missing: decision.amountPolicyMissing }, '[payoutRiskGate] GHS risk policy not configured — refusing');
        return {
            ok: false,
            status: 503,
            code: 'RISK_POLICY_UNCONFIGURED',
            message: 'GHS withdrawal security policy is not fully configured, so this withdrawal was not started. Nothing was debited.',
            policyGaps: decision.policyGaps,
            policyMissing: decision.amountPolicyMissing || [],
            decision,
        };
    }
    if (!decision.allowed) {
        logger.warn({ userId, channel, rules, riskScore: decision.riskScore }, '[payoutRiskGate] payout blocked by risk authority');
        return {
            ok: false,
            status: 403,
            code: 'FRAUD_BLOCKED',
            message: 'This withdrawal was blocked by security checks. Please contact support.',
            rules,
            riskScore: decision.riskScore,
        };
    }
    return { ok: true, decision, rules, riskScore: decision.riskScore };
}

module.exports = { evaluatePayoutRisk, accountAgeHoursOf, WITHDRAWAL_VELOCITY_TYPES };
