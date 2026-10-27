'use strict';

// Balance-valuation service (FX-balance workstream).
//
// THE authoritative read model for the Home balance card and every money
// surface. It exposes, as DISTINCT concepts (never conflated):
//
//   • nativeGhsAvailable  — REAL GHS owed to the customer (User.nativeGhsBalance,
//                            projected by ghs:user:{id}:liability).
//   • availableUsdc       — REAL liquid USDC held (User.availableBalance).
//   • usdcEquivalent       — the DISPLAY estimate of the GHS headline in
//                            USDC (nativeGhs / displayRate). It is NOT the
//                            quantity of USDC held and NOT a combined
//                            (GHS + USDC×rate) aggregate.
//   • locked/restricted buckets and non-cash AZM points, each labelled with
//     its native unit — never summed across currencies.
//   • the rate situation: CURRENT (fresh canonical), SAVED_FALLBACK (last
//     validated observation, display-only), DEMO_FALLBACK (demo seed,
//     display-only, demo environments), or UNAVAILABLE.
//   • usdcTransactionGate — whether USDC-enabled transaction actions are
//     allowed (fresh canonical rate ONLY; a saved/demo rate NEVER opens it).
//
// Valuation semantics (GHS-first contract, owner-corrected 2026-10-27):
//
//   nativeGhsAvailable  — THE GHS HEADLINE. The authoritative native-GHS
//                          wallet balance ONLY. It is never combined with
//                          USDC value, and it never varies with the FX rate
//                          or with the USDC actually held.
//   availableUsdc       — REAL liquid USDC held, reported SEPARATELY. It is
//                          never summed into the GHS headline and never
//                          reinterpreted into GHS here.
//   usdcEquivalent       — the ESTIMATED USDC equivalent OF THE GHS HEADLINE:
//                          nativeGhsAvailable / displayRateGhsPerUsdc.
//                          It is an estimate of the GHS balance's worth in
//                          USDC — NOT the quantity of USDC held, and NOT a
//                          combined (GHS + USDC×rate) valuation.
//
// The valuation is a READ: an FX revaluation changes only the displayed
// estimate — it never mutates stored balances and never writes anything.
//
// Honesty rules:
//   • Missing FX rate must NOT make a valid GHS balance unavailable:
//     nativeGhsAvailable is always reported in full; a missing rate only
//     nulls the usdcEquivalent estimate (status FX_UNAVAILABLE). The
//     headline never depends on FX.
//   • The headline is invariant to actual USDC held: it is the native-GHS
//     wallet balance alone, whatever the USDC position is.
//   • Every Decimal financial quantity is serialized as BOTH an exact string
//     (`*Exact`) and a JS number projection for presentation only.

const { Prisma } = require('@prisma/client');
const { getFreshServerRateGhsPerUsdc } = require('./transactionQuoteService');
const { getSavedRateForDisplay, FX_SAVED_RATE_PAIR } = require('./fxRateSnapshotService');

const VALUATION_PAIR = FX_SAVED_RATE_PAIR;

// Susu cycles whose PAID contributions are committed (locked) for the
// contributor. PAID_OUT/DEFAULTED cycles have already settled.
const SUSU_COMMITTED_CYCLE_STATUSES = ['COLLECTING', 'COLLECTING_GRACE'];
const SAVINGS_ACTIVE_STATUSES = ['ACTIVE', 'PAUSED'];
const VAULT_ACTIVE_STATUSES = ['ACTIVE', 'COMPLETED'];

const RATE_BASIS = {
    CURRENT: 'CURRENT',              // fresh canonical external observation
    SAVED_FALLBACK: 'SAVED_FALLBACK', // last validated observation, display-only
    DEMO_FALLBACK: 'DEMO_FALLBACK',  // demo seed, display-only, demo environments
    UNAVAILABLE: 'UNAVAILABLE',      // no eligible rate at all
};

const VALUATION_STATUS = {
    CURRENT: 'CURRENT',
    SAVED_FALLBACK: 'SAVED_FALLBACK',
    DEMO_FALLBACK: 'DEMO_FALLBACK',
    FX_UNAVAILABLE: 'FX_UNAVAILABLE', // estimate unavailable; GHS headline stays fully valid
};

class BalanceValuationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BalanceValuationError';
    }
}

const _dec = (v) => (v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v ?? 0));

function _money(exact) {
    return {
        exact: exact.toFixed(8),
        value: Number(exact),
    };
}

/**
 * Build the authoritative balance valuation for a user. READ-ONLY.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {number} args.userId
 * @param {Date}  [args.now]   clock override for tests
 */
async function buildBalanceValuation({ prisma, userId, now = new Date() }) {
    if (!prisma) throw new BalanceValuationError('prisma client is required');
    if (!Number.isInteger(userId)) throw new BalanceValuationError('userId must be an integer');

    // ── Underlying assets + projection buckets, one read each ────────────
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            nativeGhsBalance: true,
            availableBalance: true,
            vendorUnallocatedBalance: true,
            escrowLockedBalance: true,
            disputeEscrowBalance: true,
            azmBalance: true,
        },
    });
    if (!user) throw new BalanceValuationError(`user ${userId} not found`);

    const nativeGhsAvailable = _dec(user.nativeGhsBalance);
    const availableUsdc = _dec(user.availableBalance);

    // Committed/locked buckets in their NATIVE units (never summed across
    // currencies; the frontend renders each with its explicit unit label).
    const [vaultLocks, savingsLocks, susuCommitted] = await Promise.all([
        prisma.vault.aggregate({
            where: { userId, status: { in: VAULT_ACTIVE_STATUSES } },
            _sum: { currentAmountUsdc: true },
        }),
        prisma.savingsGoal.aggregate({
            where: { userId, status: { in: SAVINGS_ACTIVE_STATUSES } },
            _sum: { currentAmountGhs: true },
        }),
        prisma.susuContribution.aggregate({
            where: {
                userId,
                status: 'PAID',
                cycle: { status: { in: SUSU_COMMITTED_CYCLE_STATUSES } },
            },
            _sum: { amountUsdc: true },
        }),
    ]);

    const lockedVaultsUsdc = _dec(vaultLocks._sum.currentAmountUsdc);
    const lockedSavingsGhs = _dec(savingsLocks._sum.currentAmountGhs);
    const committedSusuUsdc = _dec(susuCommitted._sum.amountUsdc);

    // ── Rate resolution, strictly in authority order ─────────────────────
    // 1. FRESH canonical external observation (transaction authority).
    // 2. Eligible SAVED validated observation (display-only fallback).
    // 3. Demo seed (display-only, demo/test environments).
    // 4. Nothing — honest unavailability.
    let rateStatus = RATE_BASIS.UNAVAILABLE;
    let displayRate = null;
    let currentRate = null;
    let savedRate = null;

    try {
        // 271C authority: fresh.rateGhsPerUsdcExact is the Decimal-native
        // authoritative rate; .rateGhsPerUsdc is its presentation projection.
        const fresh = await getFreshServerRateGhsPerUsdc({ prisma, now });
        const freshExact = fresh.rateGhsPerUsdcExact;
        if (!freshExact || !freshExact.isFinite() || !freshExact.greaterThan(0)) {
            throw new Error('fresh canonical rate is not a positive finite decimal');
        }
        currentRate = {
            rate: fresh.rateGhsPerUsdc,
            rateExact: freshExact.toFixed(8),
            isFresh: true,
            pair: VALUATION_PAIR,
            source: fresh.rateSource,
            observedAt: new Date(fresh.rateAsOf).toISOString(),
        };
        displayRate = freshExact;
        rateStatus = RATE_BASIS.CURRENT;
    } catch (err) {
        currentRate = null;
    }

    if (rateStatus !== RATE_BASIS.CURRENT) {
        savedRate = await getSavedRateForDisplay({ prisma, now });
        if (savedRate && savedRate.eligibleForDisplayFallback) {
            displayRate = _dec(savedRate.rateExact);
            rateStatus = savedRate.isDemoSeed ? RATE_BASIS.DEMO_FALLBACK : RATE_BASIS.SAVED_FALLBACK;
        } else {
            savedRate = null;
        }
    }

    // ── Valuation (GHS-first contract) ──────────────────────────────────
    // The GHS headline is nativeGhsAvailable ONLY — never combined with
    // USDC value (the former `nativeGhs + usdc×rate` aggregate is
    // REMOVED from the contract). usdcEquivalent is the estimated USDC
    // worth OF THAT GHS BALANCE: nativeGhs / displayRate. availableUsdc
    // (the real USDC held) stays a separate reported field.
    let availableUsdcEquivalent = null;
    let valuationStatus;

    if (displayRate) {
        availableUsdcEquivalent = nativeGhsAvailable.div(displayRate);
        valuationStatus =
            rateStatus === RATE_BASIS.CURRENT
                ? VALUATION_STATUS.CURRENT
                : rateStatus === RATE_BASIS.SAVED_FALLBACK
                    ? VALUATION_STATUS.SAVED_FALLBACK
                    : VALUATION_STATUS.DEMO_FALLBACK;
    } else {
        // Missing rate: the GHS headline REMAINS fully available and valid
        // (it is an authoritative stored balance, not an FX product). Only
        // the estimate goes null — never fabricated, never headline-blanking.
        valuationStatus = VALUATION_STATUS.FX_UNAVAILABLE;
    }

    // ── Transaction gate: fresh canonical rate ONLY, for FX-DEPENDENT
    // authorizations (route-specific contract, AZM-Planning #75) ─────────
    // A saved/demo rate NEVER opens the gate. This is the same 271C
    // authority the transaction routes enforce independently
    // (requireFreshFxRate middleware + each service's own gate call) — the
    // frontend disables nothing by itself; this field is the honest
    // mirror of that same authority, not a second one.
    //
    // SCOPE (review reconciliation): `usdcTransactionGateOpen` governs ONLY
    // the FX-dependent authorizations — the routes whose own math converts
    // GHS, applies a GHS-valued limit, or executes a GHS quote (fiat MoMo
    // withdrawal, cross-border susu contribution, savings-goal USDC⇄GHS
    // conversions, MoMo-destination wallet withdrawals). It does NOT imply
    // availability for same-asset USDC actions: those never consult this
    // gate (see `usdcNativeActionsAvailable` below and the per-route
    // inventory in docs/native-ghs-fx-audit.md §4.1). One boolean must not
    // be read as identical availability for every USDC-native action.
    const usdcTransactionGateOpen = rateStatus === RATE_BASIS.CURRENT;
    // Same-asset USDC movements (USDC→USDC transfers, escrow funding,
    // USDC vault/savings-goal deposits, on-chain crypto dispatch, USDC
    // checkout) are never FX-gated — availability is by construction
    // independent of the canonical rate. The explicit constant prevents
    // any consumer from misreading the gate boolean above as universal.
    const usdcNativeActionsAvailable = true;

    return {
        pair: VALUATION_PAIR,
        // Underlying real assets — DISTINCT concepts.
        nativeGhsAvailable: _money(nativeGhsAvailable),
        availableUsdc: _money(availableUsdc),
        usdcEquivalent: availableUsdcEquivalent
            ? _money(availableUsdcEquivalent)
            : null, // null = estimate unavailable; never fabricated. The GHS
                    // headline (nativeGhsAvailable) stays valid regardless.
        // Rate situation — the two concepts stay SEPARATE: a saved rate is
        // never labelled current/fresh.
        rateStatus,
        valuationStatus,
        currentRate,
        savedRate,
        displayRate: displayRate
            ? { basis: rateStatus, rate: Number(displayRate), rateExact: displayRate.toFixed(8) }
            : null,
        // Gate for FX-DEPENDENT USDC transaction actions only (see scope
        // note above — NOT a universal availability boolean).
        usdcTransactionGateOpen,
        // Same-asset USDC actions: always available, never FX-gated
        // (route-specific contract). Distinct, explicit, and additive so
        // no consumer can conflate the two availability concepts.
        usdcNativeActionsAvailable: usdcNativeActionsAvailable,
        usdcTransactionGateReason: usdcTransactionGateOpen
            ? 'FRESH_CANONICAL_RATE'
            : rateStatus === RATE_BASIS.SAVED_FALLBACK
                ? 'NO_FRESH_CANONICAL_RATE_SAVED_FALLBACK_DISPLAY_ONLY'
                : rateStatus === RATE_BASIS.DEMO_FALLBACK
                    ? 'NO_FRESH_CANONICAL_RATE_DEMO_FALLBACK_DISPLAY_ONLY'
                    : 'NO_FRESH_CANONICAL_RATE',
        // Locked / restricted / committed — each in its NATIVE unit.
        locked: {
            escrowUsdc: _money(_dec(user.escrowLockedBalance)),
            disputesUsdc: _money(_dec(user.disputeEscrowBalance)),
            vaultsUsdc: _money(lockedVaultsUsdc),
            savingsGhs: _money(lockedSavingsGhs),
            committedSusuUsdc: _money(committedSusuUsdc),
            // Vendor trading pool: restricted vendor-side funds, NOT part
            // of the immediately-withdrawable headline.
            vendorUnallocatedUsdc: _money(_dec(user.vendorUnallocatedBalance)),
        },
        // Non-cash loyalty points — excluded from every monetary total.
        nonCash: {
            azmPoints: _money(_dec(user.azmBalance)),
        },
        evaluatedAt: new Date(now).toISOString(),
    };
}

module.exports = {
    buildBalanceValuation,
    BalanceValuationError,
    RATE_BASIS,
    VALUATION_STATUS,
    VALUATION_PAIR,
};
