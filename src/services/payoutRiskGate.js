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
} = {}) {
    const numeric = Number(amount);
    let decision;
    try {
        decision = await fraudService.evaluate({
            userId,
            // The canonical type the engine understands. `asset` is what makes
            // the amount dimension asset-aware.
            type: 'WITHDRAWAL',
            asset: String(asset || 'USDC').toUpperCase(),
            amount: Number.isFinite(numeric) ? numeric : undefined,
            destination: destination || undefined,
            rail: rail || undefined,
            accountAgeHours,
            velocityTypes: WITHDRAWAL_VELOCITY_TYPES,
            channel,
        });
    } catch (err) {
        // Includes a malformed GHS_RISK_AMOUNT_POLICY: a gate we cannot trust
        // must not silently pass.
        const policyInvalid = /GHS_RISK_AMOUNT_POLICY/.test(String(err && err.message));
        logger.error({ err: err && err.message, userId, channel }, '[payoutRiskGate] risk authority unavailable');
        return {
            ok: false,
            status: 503,
            code: policyInvalid ? 'RISK_POLICY_INVALID' : 'RISK_SERVICE_UNAVAILABLE',
            message: 'Security checks are temporarily unavailable, so this withdrawal was not started. Nothing was debited. Please try again shortly.',
            unavailable: true,
        };
    }

    const rules = (decision.triggeredRules || []).map((r) => r.id);
    if (decision.policyGaps && decision.policyGaps.length) {
        // Visible, never fatal on its own: the platform has no approved GHS
        // amount thresholds yet. Recorded so it cannot be mistaken for a pass.
        logger.warn({ userId, channel, policyGaps: decision.policyGaps }, '[payoutRiskGate] risk policy gaps (amount dimension not evaluated)');
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
