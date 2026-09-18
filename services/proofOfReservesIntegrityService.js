// services/proofOfReservesIntegrityService.js
// =============================================================================
// PROOF OF RESERVES — §P.3 custody-accounting rewrite (2026-09-17).
//
// The reserve numerator is EXACTLY the sum of accepted, fresh, account-balance
// custody evidence over ELIGIBLE custody accounts (registry-authority deposit
// addresses + the configured master hot wallet, native Polygon USDC only).
// The synthetic SystemMasterCrypto / SystemHotWallet singletons contribute
// ZERO authoritative reserve assets — they are legacy display mirrors and are
// exposed only as clearly-labeled non-authoritative display values.
//
// The liability side (§P.4 wave-3 DENOMINATOR AUTHORITY):
//   customer — the materialized per-user liability projections (available +
//              escrow + dispute + vendor-unallocated), ledger-reconciled by
//              the reconciliation read model. CURRENT STATE, never derived
//              from historical flow totals.
//   restricted — persisted RestrictedObligation rows for PENDING EXTERNAL
//              operations (the same reservation that moves the amount OUT of
//              the customer projection). Counted EXACTLY ONCE.
//   effective — customer + restricted: THE denominator. Every output field
//              (isFullyBacked, reserveRatio, coverage, attestation,
//              totalLiabilities, snapshot columns, breakdown) derives from
//              this ONE value.
//   flows     — classifyUsdcLiabilityFlows (X/Y/Z): RECONCILIATION /
//              DIAGNOSTIC EVIDENCE ONLY. X is compared against the effective
//              denominator (signed exact difference): X > effective is an
//              explicit classification failure (UNATTESTABLE, fail closed);
//              effective > X leaves an exact unclassified exposure (INCOMPLETE);
//              equal is COMPLETE. Flows are NEVER the liability authority —
//              a pending withdrawal reservation legitimately drops the
//              customer projection below the historical flow total.
//   A  eligibleReserveTotal          — evidence-backed eligible custody assets.
//
// Invariant target: REAL USDC ASSETS >= ALL CUSTOMER USDC LIABILITIES +
// RESTRICTED OBLIGATIONS. Restricted obligations are persisted and
// authoritative (§P.4); while ANY source family is not, the boundary is
// explicit (null + available=false), never zero-invented.
//
// Fail-closed: with no accepted fresh evidence the snapshot records
// EVIDENCE_UNAVAILABLE and is NOT fully backed. The previous reserve value is
// never presented as current.
//
// Per-user Merkle commitments are UNCHANGED (same leaf mechanism over the
// same four balance fields) — existing proofs stay valid.
// =============================================================================
const crypto = require('crypto');
const { Prisma, PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;
// Accepted balance evidence older than this window is STALE: it must not
// feed the reserve numerator (fail-closed, not "keep last known value").
const EVIDENCE_FRESHNESS_MS = parseInt(process.env.CUSTODY_EVIDENCE_MAX_AGE_MINUTES || '15', 10) * 60 * 1000;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const money = value => Number.parseFloat(value?.toString?.() || '0');

// ── Merkle machinery (unchanged — existing per-user proofs stay valid) ──────
function merkleRootFromHashes(hashes) {
    if (!hashes.length) return '0'.repeat(64);
    let layer = [...hashes];
    while (layer.length > 1) {
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            next.push(sha256(layer[i] + (i + 1 < layer.length ? layer[i + 1] : layer[i])));
        }
        layer = next;
    }
    return layer[0];
}

function merkleProofFromHashes(hashes, index) {
    const proof = [];
    let layer = [...hashes];
    let idx = index;
    while (layer.length > 1) {
        const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
        proof.push({
            position: idx % 2 === 0 ? 'right' : 'left',
            hash: siblingIndex < layer.length ? layer[siblingIndex] : layer[idx],
        });
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            next.push(sha256(layer[i] + (i + 1 < layer.length ? layer[i + 1] : layer[i])));
        }
        layer = next;
        idx = Math.floor(idx / 2);
    }
    return proof;
}

function verifyMerkleProof(leafHash, proof, root) {
    let hash = leafHash;
    for (const step of proof) {
        hash = step.position === 'right' ? sha256(hash + step.hash) : sha256(step.hash + hash);
    }
    return hash === root;
}

// ── Pure coverage/report composition (regression-testable, exact) ───────────
/**
 * Compose the liability/reserve report from exact Decimal components.
 * Pure: no DB, no floats. Every component is a Prisma.Decimal or null.
 *
 * §P.4-wave-3 DENOMINATOR AUTHORITY (canonical invariant):
 *
 *   REAL USDC ASSETS >= CUSTOMER USDC LIABILITIES + RESTRICTED OBLIGATIONS
 *
 * The denominator is defined ONCE here and every output field derives from
 * the SAME value:
 *   customerLiabilityTotal      — AUTHORITATIVE current customer liability:
 *     the materialized per-user liability projections (available + escrow +
 *     dispute + vendor-unallocated), which the reconciliation read model
 *     enforces against the authoritative ledger for every ledger-active
 *     user. This is a CURRENT STATE authority — it is never derived from
 *     historical TransactionHistory flow totals.
 *   restrictedObligationsTotal — pending EXTERNAL operation reservations
 *     (provider payout / on-chain withdrawal), persisted as
 *     RestrictedObligation rows in the same transaction as the ledger
 *     reservation that moves the amount OUT of the customer's projection.
 *     Counted here EXACTLY ONCE, as the separately modeled restricted
 *     component. Internal escrow/dispute/vendor reclassifications stay
 *     INSIDE customerLiabilityTotal (they are customer liability buckets)
 *     and are never added here (no double counting).
 *   effectiveObligationTotal    — customer + restricted: THE denominator,
 *     null while restricted obligations are not authoritatively modeled
 *     (fail closed: the unknown part is NEVER invented as zero).
 *
 * isFullyBacked requires ALL of:
 *   effective denominator known (restricted modeled)
 *   A >= effectiveObligationTotal
 *   evidence healthy (fresh accepted balance evidence on every eligible account)
 *   liabilityAttestation COMPLETE (flow reconciliation exact — see below)
 *
 * FLOW CLASSIFICATION IS RECONCILIATION/DIAGNOSTIC EVIDENCE ONLY. It is
 * NEVER the liability authority: after a pending withdrawal reservation
 * the historical flows legitimately still total the pre-reservation amount
 * while the customer projection has already dropped. Flow divergence is
 * therefore compared against the EFFECTIVE denominator, not the bare
 * customer pool:
 *   flowReconciliationDifference = X_flows − effectiveObligationTotal (signed)
 *   difference > 0  → flows claim MORE than the authority covers:
 *                     LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION —
 *                     UNATTESTABLE, fail closed (the pre-wave-3 code
 *                     mis-fired this exact check against the bare mixed
 *                     pool for every legitimate pending reservation).
 *   difference < 0  → the authority holds liability the flows do not
 *                     explain (unclassified exposure Z, exact signed) —
 *                     INCOMPLETE, never silently dropped.
 *   difference == 0 → exactly reconciled — COMPLETE.
 *   flows unavailable (classification invalid) → UNATTESTABLE, fail closed.
 */
function composeLiabilityReport({
    customerLiabilityTotal,     // Decimal — AUTHORITATIVE customer liability (ledger-reconciled projections)
    restrictedObligationsTotal, // Decimal | null — pending EXTERNAL operations, counted exactly once
    flowLiabilityTotal,         // Decimal | null — X_flows (diagnostic evidence only)
    flowClassificationStatus,   // 'OK' | 'NEGATIVE_LIABILITY_FLOW' | null
    eligibleReserveTotal,       // A (Decimal)
    evidenceHealthy,
    evidenceStatus,
}) {
    const zero = new Prisma.Decimal(0);
    const A = eligibleReserveTotal || zero;
    const customer = customerLiabilityTotal || zero;
    const restrictedKnown = restrictedObligationsTotal != null;
    const R = restrictedObligationsTotal || zero;
    // THE denominator — defined once, used by every output field below.
    const effective = restrictedKnown ? customer.plus(R) : null;
    const effectiveKnown = effective != null;

    // Flow reconciliation — DIAGNOSTIC EVIDENCE ONLY (see doc above). When
    // restricted is unknown the comparison base degrades to the customer
    // pool alone, but that state already fails closed on the unknown
    // restricted component.
    const flowsAvailable = flowLiabilityTotal != null;
    const flowBase = effectiveKnown ? effective : customer;
    const flowDifference = flowsAvailable ? flowLiabilityTotal.minus(flowBase) : null;
    const flowsExceedAuthority = flowsAvailable && flowDifference.gt(zero);
    // EXACT SIGNED exposure, never clamped, never reinterpreted. null when
    // the flows are unavailable or over-classified — the exposure is NOT
    // knowable from an inconsistent classification, never a false zero.
    const Z = (flowsAvailable && !flowsExceedAuthority)
        ? (flowDifference.lt(zero) ? flowDifference.neg() : zero)
        : null;

    const liabilityAttestation = (!flowsAvailable || flowsExceedAuthority)
        ? 'UNATTESTABLE'
        : (Z.isZero() ? 'COMPLETE' : 'INCOMPLETE');
    const classificationFailure = flowsExceedAuthority
        ? 'LIABILITY_FLOW_EXCEEDS_EFFECTIVE_OBLIGATION'
        : null;

    const healthy = Boolean(evidenceHealthy);
    const isFullyBacked = effectiveKnown
        && healthy
        && liabilityAttestation === 'COMPLETE'
        && (effective.isZero() ? A.gte(zero) : A.gte(effective));

    // reserveRatioPercent = A / effectiveObligationTotal * 100 — the SAME
    // denominator as isFullyBacked/totalLiabilities/coverage. 100 when the
    // effective denominator is exactly zero, 0 only while the denominator
    // is unknown (restricted unmodeled). The ratio is display-only; the
    // exact comparisons above are the authority.
    let reserveRatioPercent;
    if (!effectiveKnown) {
        reserveRatioPercent = new Prisma.Decimal(0); // denominator unknown
    } else if (effective.gt(zero)) {
        reserveRatioPercent = A.div(effective).mul(100).toDecimalPlaces(4);
    } else {
        reserveRatioPercent = new Prisma.Decimal(100);
    }

    return {
        // Explicit authority statement — consumers never have to guess.
        liabilityAuthority: 'MATERIALIZED_USER_PROJECTIONS_LEDGER_RECONCILED',
        // THE denominator (null = restricted unmodeled, fail closed).
        effectiveObligationTotal: effective,
        customerLiabilityTotal: customer,
        restrictedObligationsTotal: restrictedObligationsTotal ?? null,
        restrictedObligationsAvailable: restrictedKnown,
        restrictedObligationsKnown: restrictedKnown,
        // Diagnostic evidence — NOT the liability authority.
        flowLiabilityTotal: flowsAvailable ? flowLiabilityTotal : null,
        flowClassificationStatus: flowClassificationStatus ?? null,
        flowReconciliationDifference: flowDifference,
        classificationFailure,
        unclassifiedExposure: Z,
        eligibleReserveTotal: A,
        coverageOfTotalUsdcObligation: (effectiveKnown && effective.gt(zero)) ? A.div(effective) : null,
        liabilityAttestation,
        evidenceStatus,
        isFullyBacked,
        reserveRatioPercent,
    };
}

/**
 * LEGACY compatibility surface ONLY — the pre-§P.3 synthetic formula.
 * The fiat pool is still excluded from the crypto numerator, but these
 * "reserves" are synthetic display mirrors, NOT custody evidence. Retained so
 * the old regression test keeps guarding the currency boundary; the
 * authoritative coverage is composeLiabilityReport above.
 */
function calculateReserveCoverage({ systemCrypto = 0, hotWallet = 0, fiatPool = 0, liabilities = 0 }) {
    const totalReserves = money(systemCrypto) + money(hotWallet);
    const reserveRatio = liabilities > 0 ? totalReserves / money(liabilities) : 1;
    return {
        totalReserves,
        reserveRatio,
        fiatPool: money(fiatPool),
        authoritative: false, // explicit: synthetic display values only
    };
}

// ── Exact liability state ───────────────────────────────────────────────────
async function loadLiabilityState(db) {
    const users = await db.user.findMany({
        where: { isDeleted: false },
        select: {
            id: true,
            availableBalance: true,
            escrowLockedBalance: true,
            vendorUnallocatedBalance: true,
            disputeEscrowBalance: true,
        },
        orderBy: { id: 'asc' },
    });

    // EXACT mixed-pool total — Prisma.Decimal sums, never floats.
    const zero = new Prisma.Decimal(0);
    const sum4 = (users, field) => users.reduce(
        (acc, u) => acc.plus(new Prisma.Decimal(u[field] ?? 0)), zero);
    const totalAvailable = sum4(users, 'availableBalance');
    const totalEscrow = sum4(users, 'escrowLockedBalance');
    const totalVendorUnallocated = sum4(users, 'vendorUnallocatedBalance');
    const totalDisputeEscrow = sum4(users, 'disputeEscrowBalance');
    const mixedPoolTotal = totalAvailable.plus(totalEscrow).plus(totalVendorUnallocated).plus(totalDisputeEscrow);

    return {
        users,
        totalAvailable, totalEscrow, totalVendorUnallocated, totalDisputeEscrow,
        mixedPoolTotal,
    };
}

// ── Snapshot creation ───────────────────────────────────────────────────────
/**
 * Create a §P.3 custody-accounting PoR snapshot.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.balanceProvider] — injectable TATUM_V3_TOKEN_BALANCE
 *        provider (tests). Default: the real Tatum adapter; when TATUM_API_KEY
 *        is absent the snapshot records EVIDENCE_UNAVAILABLE (fail-closed).
 */
async function createSnapshot({ balanceProvider } = {}) {
    const custodyAccounting = require('./custodyAccountingService');
    const custodyExecution = require('./tatumCustodyExecutionService');
    let provider = balanceProvider || null;
    if (!provider) {
        if (!process.env.TATUM_API_KEY) {
            provider = null; // fail-closed: EVIDENCE_UNAVAILABLE below
        } else {
            const { createTatumTokenBalanceProvider } = require('./custodyEvidenceProvider');
            provider = createTatumTokenBalanceProvider({});
        }
    }

    const canonical = custodyExecution.CANONICAL;

    // 1. Liability state (exact, outside the write transaction).
    const state = await loadLiabilityState(prisma);
    let flows = null;
    let flowsError = null;
    try {
        flows = await custodyAccounting.classifyUsdcLiabilityFlows(prisma);
    } catch (err) {
        flowsError = err.message; // classification itself failed → UNATTESTABLE
        logger.error({ err: flowsError }, '[proofOfReserves] liability flow classification failed');
    }

    // 2. Custody account set: mirror the ACTIVE §P.1 registry + hot wallet.
    const cfg = custodyExecution.getConfig();
    const hotWalletAddress = cfg.hotWalletAddress || null;
    const activeRegistryRows = await prisma.walletAddress.findMany({
        where: {
            status: 'ACTIVE',
            network: canonical.network,
            asset: canonical.asset,
            contractAddress: canonical.contractAddress,
        },
    });
    for (const row of activeRegistryRows) {
        await prisma.$transaction(async (tx) => {
            await custodyAccounting.ensureDepositAccount(tx, { walletAddress: row });
        });
    }
    if (hotWalletAddress) {
        await prisma.$transaction(async (tx) => {
            await custodyAccounting.ensureHotWalletAccount(tx, {
                address: hotWalletAddress,
                network: canonical.network,
                asset: canonical.asset,
                contractAddress: canonical.contractAddress,
            });
        });
    }

    // 3. Eligible accounts (registry-authority validation + retirement sync).
    const eligibleAccounts = await custodyAccounting.syncAndListEligibleAccounts(prisma, {
        hotWalletAddress,
        hotWalletContractAddress: canonical.contractAddress,
    });

    // 4. Observe balances — evidence rows recorded even on the read path, so
    //    every snapshot documents exactly what it saw. Fail-closed per account.
    const accepted = [];
    const missing = [];
    const rejectedObservations = [];
    let totalReserveBaseUnits = 0n;
    for (const account of eligibleAccounts) {
        if (!provider) { missing.push({ accountId: account.id, tier: account.tier, reason: 'PROVIDER_UNAVAILABLE' }); continue; }
        let observation;
        try {
            observation = await custodyAccounting.observeAccountBalance(prisma, { account, provider });
        } catch (err) {
            logger.warn({ err: err.message, accountId: account.id }, '[proofOfReserves] balance observation failed');
            missing.push({ accountId: account.id, tier: account.tier, reason: 'OBSERVATION_ERROR' });
            continue;
        }
        if (observation.recorded || observation.idempotent) {
            const evidence = observation.evidence;
            const fresh = await custodyAccounting.getFreshAcceptedEvidence(prisma, {
                custodyAccountId: account.id,
                maxAgeMs: EVIDENCE_FRESHNESS_MS,
            });
            if (fresh) {
                accepted.push({ accountId: account.id, tier: account.tier, evidenceId: fresh.id, balanceBaseUnits: fresh.balanceBaseUnits });
                totalReserveBaseUnits += BigInt(fresh.balanceBaseUnits);
            } else {
                missing.push({ accountId: account.id, tier: account.tier, reason: 'STALE_EVIDENCE' });
            }
        } else if (observation.reason) {
            rejectedObservations.push({ accountId: account.id, tier: account.tier, reason: observation.reason });
            missing.push({ accountId: account.id, tier: account.tier, reason: observation.reason });
        } else {
            missing.push({ accountId: account.id, tier: account.tier, reason: 'NO_EVIDENCE' });
        }
    }

    const eligibleReserveTotal = custodyAccounting.decimalFromBaseUnits(totalReserveBaseUnits, canonical.decimals);
    const evidenceStatus = eligibleAccounts.length === 0
        ? 'EVIDENCE_UNAVAILABLE'
        : (missing.length === 0 ? 'HEALTHY' : (accepted.length === 0 ? 'EVIDENCE_UNAVAILABLE' : 'PARTIAL'));

    // 5. Compose the honest report (exact Decimals).
    // §P.4 AUTHORITATIVE RESTRICTED OBLIGATIONS: the denominator now has a
    // persisted authoritative source (RestrictedObligation rows created/
    // released in the same transactions as the ledger reservations).
    // `complete` is true ONLY when every required source family is
    // authoritative. While ANY family (escrow/dispute/vendor) is still
    // unmodelled, the denominator is incomplete and the total is reported as
    // null — the fully-backed claim stays impossible (fail closed, the
    // unknown part is NEVER invented as zero).
    const restricted = await require('./restrictedObligationService').authoritativeTotals(prisma, { asset: 'USDC' });
    // §P.4 wave-3 DENOMINATOR AUTHORITY: the current customer liability is
    // the materialized projection population (loadLiabilityState), NEVER
    // the historical TransactionHistory flow totals — flows are passed as
    // reconciliation/diagnostic evidence only (see composeLiabilityReport).
    const report = composeLiabilityReport({
        customerLiabilityTotal: state.mixedPoolTotal,
        restrictedObligationsTotal: restricted.complete ? restricted.total : null,
        flowLiabilityTotal: flows ? flows.usdcLiabilityTotal : null,
        flowClassificationStatus: flows ? flows.liabilityClassificationStatus : null,
        eligibleReserveTotal,
        evidenceHealthy: evidenceStatus === 'HEALTHY',
        evidenceStatus,
    });

    const byTier = {};
    for (const item of accepted) {
        byTier[item.tier] = (byTier[item.tier] || { accounts: 0, balanceBaseUnits: 0n });
        byTier[item.tier].accounts += 1;
        byTier[item.tier].balanceBaseUnits += BigInt(item.balanceBaseUnits);
    }
    const byTierDecimal = Object.fromEntries(Object.entries(byTier).map(([tier, v]) => [
        tier,
        { accounts: v.accounts, balance: custodyAccounting.decimalStringFromBaseUnits(v.balanceBaseUnits, canonical.decimals) },
    ]));

    // 6. Persist the snapshot + unchanged per-user leaves (one transaction).
    return prisma.$transaction(async (tx) => {
        const salt = crypto.randomBytes(16).toString('hex');
        const leaves = state.users.map(u => ({
            userId: u.id,
            availableBalance: u.availableBalance.toString(),
            escrowLockedBalance: u.escrowLockedBalance.toString(),
            vendorUnallocatedBalance: u.vendorUnallocatedBalance.toString(),
            disputeEscrowBalance: u.disputeEscrowBalance.toString(),
            leafHash: sha256(`${u.id}|${u.availableBalance}|${u.escrowLockedBalance}|${u.vendorUnallocatedBalance}|${u.disputeEscrowBalance}|${salt}`),
        }));
        const root = merkleRootFromHashes(leaves.map(l => l.leafHash));

        const [systemMasterCrypto, systemHotWallet, systemFiatPool] = await Promise.all([
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
            tx.systemHotWallet.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
        ]);

        const snapshot = await tx.proofOfReservesSnapshot.create({
            data: {
                // Legacy fields keep their historical shape (compatibility
                // only); their §P.3 semantics are documented in breakdown.
                // §P.4 wave-3: totalLiabilities IS THE DENOMINATOR — the
                // effective obligation (customer + restricted) whenever the
                // restricted component is modeled; the bare customer pool
                // only as an explicitly-flagged incomplete fallback.
                totalLiabilities: report.effectiveObligationTotal ?? state.mixedPoolTotal,
                totalReserves: report.eligibleReserveTotal, // evidence-backed custody assets
                reserveRatio: report.reserveRatioPercent,   // A/effective*100 — SAME denominator as totalLiabilities
                isFullyBacked: report.isFullyBacked,
                userCount: leaves.length,
                merkleRoot: root,
                salt,
                breakdown: {
                    version: '§P.3',
                    liabilities: {
                        available: state.totalAvailable.toString(),
                        escrow: state.totalEscrow.toString(),
                        vendorUnallocated: state.totalVendorUnallocated.toString(),
                        disputeEscrow: state.totalDisputeEscrow.toString(),
                        mixedPoolTotal: state.mixedPoolTotal.toString(),
                        mixedPoolDenomination: 'UNQUALIFIED — not USDC by construction',
                    },
                    usdcObligation: {
                        // §P.4 wave-3: the DENOMINATOR authority is the
                        // materialized projection population + restricted
                        // rows. Everything under flowReconciliation is
                        // DIAGNOSTIC EVIDENCE ONLY — never the authority.
                        authority: report.liabilityAuthority,
                        effectiveObligationTotal: report.effectiveObligationTotal != null
                            ? report.effectiveObligationTotal.toString()
                            : null,
                        customerLiabilityTotal: report.customerLiabilityTotal.toString(),
                        restrictedObligationsTotal: report.restrictedObligationsTotal != null
                            ? report.restrictedObligationsTotal.toString()
                            : null,
                        liabilityAttestation: report.liabilityAttestation,
                        classificationFailure: report.classificationFailure,
                        unclassifiedExposure: report.unclassifiedExposure != null
                            ? report.unclassifiedExposure.toString()
                            : null,
                        // Flow reconciliation diagnostics (signed exact).
                        flowLiabilityTotal: report.flowLiabilityTotal != null
                            ? report.flowLiabilityTotal.toString()
                            : null,
                        flowReconciliationDifference: report.flowReconciliationDifference != null
                            ? report.flowReconciliationDifference.toString()
                            : null,
                        classificationStatus: flows ? flows.liabilityClassificationStatus : null,
                        components: flows ? {
                            usdcCredits: flows.usdcCredits.toString(),
                            usdcDebits: flows.usdcDebits.toString(),
                            verifiedDepositsTotal: flows.verifiedDepositsTotal.toString(),
                            cryptoWithdrawalsNet: flows.cryptoWithdrawalsNet.toString(),
                            fiatWithdrawalsNet: flows.fiatWithdrawalsNet.toString(),
                        } : null,
                        flowsError: flowsError || null,
                    },
                    reserves: {
                        currency: 'USDC',
                        network: canonical.network,
                        eligibleReserveTotal: report.eligibleReserveTotal.toString(),
                        evidenceStatus: report.evidenceStatus,
                        restrictedObligationsTotal: report.restrictedObligationsTotal != null
                            ? report.restrictedObligationsTotal.toString()
                            : null,
                        restrictedObligationsAvailable: report.restrictedObligationsAvailable,
                        // Per-family observability: EXACTLY the obligation-row
                        // families join the denominator; internal
                        // reclassification families are reported for
                        // observability but counted ONCE inside the customer
                        // liability, never added again here.
                        restrictedObligationFamilies: Object.fromEntries(
                            Object.entries(restricted.families).map(([family, v]) => [family, {
                                representation: v.representation,
                                includedInDenominator: v.includedInDenominator,
                                activeTotal: v.activeTotal.toString(),
                                ledgerReclassificationTotal: v.ledgerReclassificationTotal != null
                                    ? v.ledgerReclassificationTotal.toString() : null,
                            }])
                        ),
                        byTier: byTierDecimal,
                        legacySynthetic: {
                            note: 'NON-AUTHORITATIVE display mirrors — contribute ZERO reserve assets',
                            systemMasterCrypto: new Prisma.Decimal(systemMasterCrypto?.balance ?? 0).toString(),
                            systemHotWallet: new Prisma.Decimal(systemHotWallet?.balance ?? 0).toString(),
                            fiatPoolGhs: new Prisma.Decimal(systemFiatPool?.balance ?? 0).toString(),
                        },
                    },
                    coverage: {
                        // Same denominator as the invariant (effective).
                        ofTotalUsdcObligation: report.coverageOfTotalUsdcObligation ? report.coverageOfTotalUsdcObligation.toString() : null,
                    },
                    invariant: {
                        target: 'REAL USDC ASSETS >= ALL CUSTOMER USDC LIABILITIES + RESTRICTED OBLIGATIONS',
                        satisfied: report.isFullyBacked,
                        restrictedObligationsModeled: restricted.complete,
                        // THE denominator — the exact value the invariant
                        // compares A against (null while restricted is
                        // unmodeled: fail closed).
                        effectiveObligationTotal: report.effectiveObligationTotal != null
                            ? report.effectiveObligationTotal.toString()
                            : null,
                        reserveShortfall: (report.effectiveObligationTotal != null
                            && report.eligibleReserveTotal.lt(report.effectiveObligationTotal))
                            ? report.effectiveObligationTotal.minus(report.eligibleReserveTotal).toString()
                            : '0',
                        // Ordered, mutually exclusive reason the invariant
                        // is NOT satisfied — one exact code, never a guess.
                        blockedBy: report.isFullyBacked
                            ? null
                            : (!report.restrictedObligationsKnown
                                ? 'RESTRICTED_OBLIGATIONS_UNKNOWN'
                                : (report.classificationFailure
                                    ? report.classificationFailure
                                    : (report.liabilityAttestation === 'INCOMPLETE'
                                        ? 'UNCLASSIFIED_FLOW_EXPOSURE'
                                        : (report.evidenceStatus !== 'HEALTHY'
                                            ? report.evidenceStatus
                                            : 'INSUFFICIENT_RESERVES')))),
                    },
                },
                // §P.3 additive columns.
                // §P.4 wave-3: usdcLiabilityTotal IS THE DENOMINATOR — the
                // effective obligation, consistent with totalLiabilities,
                // reserveRatio, coverage and the invariant payload. null
                // only while the restricted component is unmodeled (fail
                // closed — never a flow total, never a false zero).
                usdcLiabilityTotal: report.effectiveObligationTotal,
                // Y — evidence-linked flow subset, DIAGNOSTIC ONLY.
                evidenceLinkedLiabilityTotal: flows ? flows.evidenceLinkedUsdcObligation : null,
                unclassifiedExposure: report.unclassifiedExposure,
                eligibleReserveTotal: report.eligibleReserveTotal,
                restrictedObligationsTotal: report.restrictedObligationsTotal,
                restrictedObligationsAvailable: report.restrictedObligationsAvailable,
                liabilityAttestation: report.liabilityAttestation,
                evidenceStatus: report.evidenceStatus,
                custodyAccountCount: eligibleAccounts.length,
                acceptedEvidenceCount: accepted.length,
                missingEvidenceCount: missing.length,
                evidenceSummary: { accepted, missing, rejectedObservations, freshnessWindowMs: EVIDENCE_FRESHNESS_MS },
                assetIdentity: {
                    network: canonical.network,
                    asset: canonical.asset,
                    contractAddress: canonical.contractAddress,
                    decimals: canonical.decimals,
                },
                liabilityBreakdown: {
                    authority: report.liabilityAuthority,
                    effectiveObligationTotal: report.effectiveObligationTotal != null
                        ? report.effectiveObligationTotal.toString() : null,
                    customerLiabilityTotal: report.customerLiabilityTotal.toString(),
                    restrictedObligationsTotal: report.restrictedObligationsTotal != null
                        ? report.restrictedObligationsTotal.toString() : null,
                    eligibleReserveTotal: report.eligibleReserveTotal.toString(),
                    coverageOfTotalUsdcObligation: report.coverageOfTotalUsdcObligation
                        ? report.coverageOfTotalUsdcObligation.toString() : null,
                    flowLiabilityTotal: report.flowLiabilityTotal != null
                        ? report.flowLiabilityTotal.toString() : null,
                    flowReconciliationDifference: report.flowReconciliationDifference != null
                        ? report.flowReconciliationDifference.toString() : null,
                    unclassifiedExposure: report.unclassifiedExposure != null
                        ? report.unclassifiedExposure.toString() : null,
                    classificationFailure: report.classificationFailure,
                },
            },
        });
        for (const leaf of leaves) {
            await tx.$executeRaw`INSERT INTO "ProofOfReservesLeaf" ("snapshotId", "userId", "availableBalance", "escrowLockedBalance", "vendorUnallocatedBalance", "disputeEscrowBalance", "leafHash") VALUES (${snapshot.id}::int, ${leaf.userId}::int, ${leaf.availableBalance}::numeric, ${leaf.escrowLockedBalance}::numeric, ${leaf.vendorUnallocatedBalance}::numeric, ${leaf.disputeEscrowBalance}::numeric, ${leaf.leafHash})`;
        }
        return { snapshot, root, report };
    }, { isolationLevel: 'Serializable' });
}

// ── Public read surfaces ────────────────────────────────────────────────────
async function getLatestSnapshot() {
    const snapshot = await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!snapshot) return null;
    const base = {
        timestamp: snapshot.createdAt.toISOString(),
        totalLiabilities: snapshot.totalLiabilities.toString(),
        totalReserves: snapshot.totalReserves.toString(),
        reserveRatio: snapshot.reserveRatio.toString(),
        isFullyBacked: snapshot.isFullyBacked,
        userCount: snapshot.userCount,
        merkleRoot: snapshot.merkleRoot,
        breakdown: snapshot.breakdown,
    };
    // §P.3 additive fields (null for legacy snapshot rows — explicit, never
    // backfilled with invented values).
    if (snapshot.usdcLiabilityTotal != null) {
        base.usdcLiabilityTotal = snapshot.usdcLiabilityTotal != null ? snapshot.usdcLiabilityTotal.toString() : null;
        base.evidenceLinkedLiabilityTotal = (snapshot.evidenceLinkedLiabilityTotal ?? null)?.toString?.() ?? null;
        base.unclassifiedExposure = snapshot.unclassifiedExposure?.toString() ?? null;
        base.eligibleReserveTotal = snapshot.eligibleReserveTotal?.toString() ?? null;
        base.restrictedObligationsTotal = snapshot.restrictedObligationsTotal?.toString?.() ?? null;
        base.liabilityAttestation = snapshot.liabilityAttestation;
        base.evidenceStatus = snapshot.evidenceStatus;
        base.custodyAccountCount = snapshot.custodyAccountCount;
        base.acceptedEvidenceCount = snapshot.acceptedEvidenceCount;
        base.missingEvidenceCount = snapshot.missingEvidenceCount;
        base.assetIdentity = snapshot.assetIdentity;
        base.liabilityBreakdown = snapshot.liabilityBreakdown;
    } else {
        base.usdcLiabilityTotal = null;
        base.liabilityAttestation = 'UNATTESTABLE';
        base.evidenceStatus = 'EVIDENCE_UNAVAILABLE';
    }
    return base;
}

async function verifyUser(userId, snapshotId) {
    const snapshot = snapshotId
        ? await prisma.proofOfReservesSnapshot.findUnique({ where: { id: Number(snapshotId) } })
        : await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!snapshot) return null;
    const rows = await prisma.$queryRaw`SELECT "userId", "availableBalance", "escrowLockedBalance", "vendorUnallocatedBalance", "disputeEscrowBalance", "leafHash" FROM "ProofOfReservesLeaf" WHERE "snapshotId" = ${snapshot.id} ORDER BY "userId" ASC`;
    const index = rows.findIndex(row => Number(row.userId) === Number(userId));
    if (index < 0) return { snapshot, verified: false, reason: 'USER_NOT_IN_SNAPSHOT' };
    const proof = merkleProofFromHashes(rows.map(r => r.leafHash), index);
    return {
        snapshot,
        verified: verifyMerkleProof(rows[index].leafHash, proof, snapshot.merkleRoot),
        proof,
        yourBalance: {
            available: rows[index].availableBalance.toString(),
            escrow: rows[index].escrowLockedBalance.toString(),
            vendorUnallocated: rows[index].vendorUnallocatedBalance.toString(),
            disputeEscrow: rows[index].disputeEscrowBalance.toString(),
        },
    };
}

async function getIntegrityReport() {
    const latest = await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    // EXACT trial balance: Decimal sums, exact equality (no epsilon).
    const journal = await prisma.journalEntry.aggregate({ _sum: { debit: true, credit: true } });
    const zero = new Prisma.Decimal(0);
    const totalDebit = journal._sum.debit || zero;
    const totalCredit = journal._sum.credit || zero;
    const difference = totalDebit.minus(totalCredit).abs();
    const journalBalanced = difference.isZero();
    if (!latest) {
        return { status: 'NO_SNAPSHOT', snapshot: null, journal: { balanced: journalBalanced, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), difference: difference.toString() } };
    }
    const countRows = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "ProofOfReservesLeaf" WHERE "snapshotId" = ${latest.id}`;
    const leafCount = Number(countRows[0]?.count || 0);
    const coverage = latest.userCount === 0 ? 1 : leafCount / latest.userCount;
    const ageMs = Date.now() - latest.createdAt.getTime();
    const stale = ageMs > MAX_SNAPSHOT_AGE_MS;
    const fullyBacked = latest.isFullyBacked;
    const status = coverage === 1 && journalBalanced && fullyBacked && !stale ? 'HEALTHY' : 'EXCEPTION';
    return {
        status,
        snapshot: {
            id: latest.id,
            createdAt: latest.createdAt,
            ageMs,
            stale,
            totalLiabilities: latest.totalLiabilities.toString(),
            totalReserves: latest.totalReserves.toString(),
            reserveRatio: latest.reserveRatio.toString(),
            isFullyBacked: fullyBacked,
            userCount: latest.userCount,
            leafCount,
            leafCoverage: coverage,
            merkleRoot: latest.merkleRoot,
            usdcLiabilityTotal: latest.usdcLiabilityTotal != null ? latest.usdcLiabilityTotal.toString() : null,
            evidenceLinkedLiabilityTotal: latest.evidenceLinkedLiabilityTotal != null ? latest.evidenceLinkedLiabilityTotal.toString() : null,
            unclassifiedExposure: latest.unclassifiedExposure != null ? latest.unclassifiedExposure.toString() : null,
            eligibleReserveTotal: latest.eligibleReserveTotal != null ? latest.eligibleReserveTotal.toString() : null,
            liabilityAttestation: latest.liabilityAttestation,
            evidenceStatus: latest.evidenceStatus,
            custodyAccountCount: latest.custodyAccountCount,
            acceptedEvidenceCount: latest.acceptedEvidenceCount,
            missingEvidenceCount: latest.missingEvidenceCount,
            assetIdentity: latest.assetIdentity,
        },
        journal: { balanced: journalBalanced, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), difference: difference.toString() },
    };
}

module.exports = {
    createSnapshot,
    getLatestSnapshot,
    verifyUser,
    getIntegrityReport,
    composeLiabilityReport,
    calculateReserveCoverage,
    merkleRootFromHashes,
    merkleProofFromHashes,
    verifyMerkleProof,
    sha256,
    EVIDENCE_FRESHNESS_MS,
    MAX_SNAPSHOT_AGE_MS,
};
