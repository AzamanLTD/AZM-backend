'use strict';

// FX-unavailable transaction gate middleware (FX-balance workstream).
//
// PRODUCT POLICY (enforced server-side, never by disabled frontend buttons):
// when the CURRENT canonical USDC/GHS rate is not fresh/valid, USDC-enabled
// transaction actions are UNAVAILABLE. A saved/demo fallback rate is NEVER
// transaction authorization — it exists for display only.
//
// The gate delegates to the ONE canonical freshness authority
// (transactionQuoteService.getFreshServerRateGhsPerUsdc, 271C): fail-closed
// on NULL/invalid/future/stale lastExternalSync or an unusable rate value.
// Freshness is recomputed AT REQUEST TIME — an operation that started while
// a rate was fresh can never settle later against a cached verdict.
//
// Refusal contract:
//   • HTTP 503 with success=false, a stable code (RATE_STALE /
//     RATE_UNAVAILABLE), retryable=true and the honest display hint — no
//     client-side retry storm can turn a stale oracle green.
//   • SIDE-EFFECT SAFE BY ORDERING: mount this middleware BEFORE idempotency
//     (and before any controller) so a refused request never claims an
//     idempotency key, never debits/credits/reserves anything and never
//     dispatches to a provider. The controllers' own gates re-validate
//     inside the financial transaction for defense in depth.
//
// Scope discipline: mount ONLY on USDC-enabled transaction routes. Read
// models (balance/valuation/oracle), auth, native-GHS-only paths and
// provider WEBHOOKS (settlement completions of already-started operations)
// are deliberately not gated — see docs/native-ghs-fx-audit.md for the full
// route inventory and documented exceptions.

const { getFreshServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');

// `when` (optional): a predicate (req) => boolean evaluated BEFORE the
// gate. Use it to scope the gate to the request's genuine FX dependence
// (e.g. only the MoMo/GHS payout destinations of /api/wallet/withdraw) —
// USDC-native paths on the same route stay enabled, per the shared
// contract's "actions that do not depend on USDC/FX stay enabled" rule.
function requireFreshFxRate({ when } = {}) {
    return async (req, res, next) => {
        try {
            if (typeof when === 'function' && !when(req)) {
                return next(); // this request's money path is FX-independent
            }
            const prisma = req.app.get('prisma');
            if (!prisma) {
                // Fail closed on infrastructure ambiguity — a missing
                // database handle can never become an open gate.
                return res.status(503).json({
                    success: false,
                    code: 'RATE_UNAVAILABLE',
                    message: 'Exchange rate is temporarily unavailable. Please retry shortly.',
                    retryable: true,
                    usdcTransactionGate: 'CLOSED',
                });
            }

            // Recomputed at request time, server-side. A saved/demo fallback
            // rate is never consulted by this authority.
            const fresh = await getFreshServerRateGhsPerUsdc({ prisma });
            req.freshFxRate = fresh; // exact rate + provenance for controllers
            return next();
        } catch (err) {
            const code = err?.code === 'RATE_STALE' ? 'RATE_STALE' : 'RATE_UNAVAILABLE';
            return res.status(err?.statusCode || 503).json({
                success: false,
                code,
                message:
                    err?.message ||
                    'Exchange rate is temporarily unavailable. Please retry shortly.',
                retryable: true,
                // Honest hint: the saved-rate display fallback (if any) is
                // display-only and does NOT re-open the gate.
                usdcTransactionGate: 'CLOSED',
                savedRateIsDisplayOnly: true,
            });
        }
    };
}

module.exports = { requireFreshFxRate };
