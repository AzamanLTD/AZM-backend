'use strict';

// FX-dependent authorization gate (FX-balance workstream).
//
// ARCHITECTURE CONTRACT (AZM-Planning #75 — route-specific FX policy):
// a fresh canonical GHS/USDC rate is required ONLY where the
// authorization itself needs GHS conversion, applies a GHS-valued limit,
// or executes a route-specific GHS quote. A same-asset USDC movement
// (USDC-to-USDC transfer, escrow funding, vault/savings-USDC deposits,
// on-chain crypto dispatch, checkout of USDC-priced goods, ...) does NOT
// become unavailable because the separate combined GHS display valuation
// cannot be refreshed. The display value of an asset is not the amount of
// the asset held — availability of same-asset actions is never hostage to
// the display oracle.
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
//   • SIDE-EFFECT SAFE BY ORDERING: mount this middleware BEFORE the replay guard
//     (and before any controller) so a refused request never claims an
//     replay key, never debits/credits/reserves anything and never
//     dispatches to a provider. The controllers' own gates re-validate
//     inside the financial transaction for defense in depth.
//
// Ordering contract (enforced by the mounted route stacks and pinned by
// tests): authentication / ban guard / required 2FA run BEFORE this gate;
// this gate runs BEFORE the replay guard and before any controller. An
// unauthenticated request must never learn the gate's state, and a refused
// request never claims a replay key.
//
// SCOPE SELECTION — a CLOSED enum, not a lambda. A mount site picks one of
// the reviewed classifications below; there is no way for a call site to
// pass an arbitrary predicate that could soften the freshness check itself.
//   • (default)            — mount on a route whose authorization converts
//                            GHS, applies a GHS-valued limit, or executes a
//                            GHS quote (see docs/native-ghs-fx-audit.md
//                            §4.1 for the per-route inventory + evidence).
//   • 'MOMO_PAYOUT_DESTINATION' — mount on a route that is FX-dependent
//                            ONLY for MoMo phone destinations (the GHS
//                            payout quote); crypto/external-wallet
//                            destinations are same-asset USDC dispatches
//                            and pass through unconditionally. The
//                            destination predicate is built in, tested,
//                            and never caller-supplied.
//
// Settlement protection (unchanged): read models, auth,
// settlement/lifecycle routes (decline, satisfy, cancel, refund, expiry —
// completions/reversals of ALREADY-AUTHORIZED operations) and provider
// WEBHOOKS are deliberately not gated — a rate refusal can never block
// settlement.

const { getFreshServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');

// Destination resolution for the MoMo-destination classification. The
// wallet-withdraw destination space is exactly: Binance Pay IDs, TRC20
// addresses (T..., 34 chars), EVM addresses (0x..., 42 chars), and MoMo
// phone numbers — resolved through the SAME authoritative contract
// (services/payoutDestinationClassification.js) the controller's
// payout-method dispatch uses. A resolved MOMO destination authorizes a
// GHS payout (FX-dependent); every other RESOLVED destination is
// same-asset USDC. An UNRESOLVABLE destination (numeric without an
// explicit destinationType, format mismatch, unknown format) is refused
// HERE with the SAME code and message the controller would produce —
// the gate and the dispatch can never disagree, and an ambiguous request
// can never slip past the gate into the controller (owner-approved
// destinationType contract, 2026-10-27).
function _resolvePayoutDestination(req) {
    const {
        resolvePayoutDestination,
        payoutDestinationRefusal,
    } = require('../services/payoutDestinationClassification');
    const result = resolvePayoutDestination(
        req.body?.destination,
        req.body?.destinationType,
        req.body?.networkPref
    );
    return { result, refusal: result.status === 'RESOLVED' ? null : payoutDestinationRefusal(result) };
}

const SCOPE_ENUM = Object.freeze({
    ALWAYS: 'ALWAYS',
    MOMO_PAYOUT_DESTINATION: 'MOMO_PAYOUT_DESTINATION',
});

function requireFreshFxRate({ when } = {}) {
    if (when !== undefined && !SCOPE_ENUM[when]) {
        throw new Error(
            `requireFreshFxRate: unknown scope '${when}' — use a reviewed classification (see docs/native-ghs-fx-audit.md §4.1)`
        );
    }
    const scope = when || SCOPE_ENUM.ALWAYS;
    // Named so the route-level stack-order pins can identify the gate
    // layer by signature (freshFxRate / usdcTransactionGate).
    async function freshFxRateGate(req, res, next) {
        // Destination-conditional classification: non-MoMo destinations are
        // same-asset USDC dispatches — never FX-gated (route-specific
        // contract, AZM-Planning #75). This branch does NOT touch the
        // freshness authority at all. An UNRESOLVABLE destination is
        // refused with the shared refusal contract BEFORE the replay guard —
        // same code and message the dispatcher produces (blocker A).
        if (scope === SCOPE_ENUM.MOMO_PAYOUT_DESTINATION) {
            const { result, refusal } = _resolvePayoutDestination(req);
            if (refusal) {
                return res.status(400).json({ success: false, code: refusal.code, message: refusal.message });
            }
            if (result.payoutMethod !== 'MOMO') {
                return next();
            }
            return _assertFresh(req, res, next);
        }
        return _assertFresh(req, res, next);
    }
    return freshFxRateGate;
}

async function _assertFresh(req, res, next) {
        try {
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
}

module.exports = { requireFreshFxRate, SCOPE_ENUM };
