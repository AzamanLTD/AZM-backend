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
// The liability side is DENOMINATION-HONEST. User.availableBalance is a mixed
// historical pool and is NEVER reinterpreted wholesale as USDC. The report
// separates:
//   X  usdcLiabilityTotal            — USDC-denominated customer obligation
//                                      net external flows from authoritative
//                                      TransactionHistory rows (crypto AND
//                                      fiat-settled-in-USDC credits).
//   Y  evidenceLinkedLiabilityTotal  — custody-evidence-backed subset
//                                      (transaction-evidence-verified deposit
//                                      movements minus evidence-gated crypto
//                                      payouts).
//   Z  unclassifiedExposure          — mixed-pool liability total minus X.
//                                      Z > 0 means the pool contains claims the
//                                      classification cannot explain; it forces
//                                      the attestation to INCOMPLETE and the
//                                      snapshot OUT of fully-backed status. It
//                                      is NEVER silently dropped.
//   A  eligibleReserveTotal          — evidence-backed eligible custody assets.
//
// Invariant target: REAL USDC ASSETS >= ALL CUSTOMER USDC LIABILITIES +
// RESTRICTED OBLIGATIONS. Restricted obligations have no authoritative
// persisted semantics yet — the boundary is explicit (null + available=false),
// never zero-invented.
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
 * Compose the §P.3 liability/reserve report from exact Decimal components.
 * Pure: no DB, no floats. Every component is a Prisma.Decimal or null.
 *
 * Fully backed requires ALL of:
 *   A >= X            (evidence-backed assets cover the classified obligation)
 *   Z === 0           (no unclassified exposure hiding in the mixed pool)
 *   evidenceHealthy   (every eligible account has fresh accepted evidence)
 * Restricted obligations are an explicit boundary (null = not yet modeled);
 * they are reported, never invented as zero, and do not silently relax the
 * invariant — closing that gap is §P.4+ work.
 */
function composeLiabilityReport({
    usdcLiabilityTotal,        // X (Decimal)
    evidenceLinkedTotal,       // Y signed (Decimal)
    mixedPoolLiabilityTotal,   // legacy mixed pool total (Decimal)
    eligibleReserveTotal,       // A (Decimal)
    restrictedObligationsTotal,// Decimal | null
    evidenceHealthy,
    evidenceStatus,
}) {
    const zero = new Prisma.Decimal(0);
    // A null X means the classification itself is invalid (e.g. negative flow
    // state) — it is NEVER reinterpreted as a valid zero; the attestation
    // goes UNATTESTABLE and X is reported as null, signed raw value aside.
    const Xvalid = usdcLiabilityTotal != null;
    const X = Xvalid ? usdcLiabilityTotal : zero; // computation guard only
    const A = eligibleReserveTotal || zero;
    const mixed = mixedPoolLiabilityTotal || zero;
    const Ysigned = evidenceLinkedTotal || zero;
    const Zraw = mixed.minus(X);
    const Z = Zraw.gt(zero) ? Zraw : zero;

    const coverageOfTotal = X.gt(zero) ? A.div(X) : null;
    const coverageOfEvidenceLinked = Ysigned.gt(zero) ? A.div(Ysigned) : null;

    // Attestation: COMPLETE only when nothing unexplained remains; INCOMPLETE
    // when unclassified exposure exists; UNATTESTABLE if the classification
    // itself could not be produced (caller passes null X).
    const liabilityAttestation = (usdcLiabilityTotal == null)
        ? 'UNATTESTABLE'
        : (Z.isZero() ? 'COMPLETE' : 'INCOMPLETE');

    const healthy = Boolean(evidenceHealthy);
    // FAIL CLOSED ON UNMODELED RESTRICTED OBLIGATIONS: the target invariant
    // is REAL ASSETS >= ALL LIABILITIES + RESTRICTED. While restricted
    // obligations are not authoritatively modeled (null), the complete
    // denominator is UNKNOWN — a fully-backed claim is impossible, no matter
    // how healthy the evidence or complete the classified liability is. The
    // null/false boundary is preserved; nothing is invented as zero.
    const restrictedKnown = restrictedObligationsTotal != null;
    const isFullyBacked = restrictedKnown
        && healthy
        && liabilityAttestation === 'COMPLETE'
        && (X.isZero() ? A.gte(zero) : A.gte(X));

    // Legacy percent fields (display only; exact comparisons above are the
    // authority). reserveRatioPercent = A/X*100, or 100 when X==0 and nothing
    // unexplained exists, or 0 when the denominator is unknown (Z>0, X==0).
    let reserveRatioPercent;
    if (!Xvalid) {
        // Invalid classification — the legacy non-nullable percent column gets
        // the same "denominator unknown → 0" value it already uses for Z>0,
        // X==0; the honest state (UNATTESTABLE, null coverage) lives in the
        // attestation and the §P.3 breakdown fields.
        reserveRatioPercent = new Prisma.Decimal(0);
    } else if (X.gt(zero)) {
        reserveRatioPercent = A.div(X).mul(100).toDecimalPlaces(4);
    } else if (Z.isZero()) {
        reserveRatioPercent = new Prisma.Decimal(100);
    } else {
        reserveRatioPercent = new Prisma.Decimal(0);
    }

    return {
        usdcLiabilityTotal: Xvalid ? usdcLiabilityTotal : null,
        evidenceLinkedLiabilityTotal: Ysigned,
        unclassifiedExposure: Z,
        mixedPoolLiabilityTotal: mixed,
        eligibleReserveTotal: A,
        restrictedObligationsTotal: restrictedObligationsTotal ?? null,
        restrictedObligationsAvailable: restrictedObligationsTotal != null,
        restrictedObligationsKnown: restrictedKnown,
        coverageOfTotalUsdcObligation: coverageOfTotal,
        coverageOfEvidenceLinkedSubset: coverageOfEvidenceLinked,
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
    const X = flows ? flows.usdcLiabilityTotal : null;
    const report = composeLiabilityReport({
        usdcLiabilityTotal: X,
        evidenceLinkedTotal: flows ? flows.evidenceLinkedUsdcObligation : null,
        mixedPoolLiabilityTotal: state.mixedPoolTotal,
        eligibleReserveTotal,
        restrictedObligationsTotal: null, // boundary: no authoritative semantics yet (§P.4+)
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
                totalLiabilities: state.mixedPoolTotal,   // mixed pool — unchanged population
                totalReserves: report.eligibleReserveTotal, // NEW meaning: evidence-backed custody assets
                reserveRatio: report.reserveRatioPercent,   // A/X*100 (exact-quantized display)
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
                        usdcLiabilityTotal: report.usdcLiabilityTotal ? report.usdcLiabilityTotal.toString() : null,
                        evidenceLinkedLiabilityTotal: report.evidenceLinkedLiabilityTotal ? report.evidenceLinkedLiabilityTotal.toString() : null,
                        unclassifiedExposure: report.unclassifiedExposure ? report.unclassifiedExposure.toString() : null,
                        liabilityAttestation: report.liabilityAttestation,
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
                        restrictedObligationsTotal: null,
                        restrictedObligationsAvailable: false,
                        byTier: byTierDecimal,
                        legacySynthetic: {
                            note: 'NON-AUTHORITATIVE display mirrors — contribute ZERO reserve assets',
                            systemMasterCrypto: new Prisma.Decimal(systemMasterCrypto?.balance ?? 0).toString(),
                            systemHotWallet: new Prisma.Decimal(systemHotWallet?.balance ?? 0).toString(),
                            fiatPoolGhs: new Prisma.Decimal(systemFiatPool?.balance ?? 0).toString(),
                        },
                    },
                    coverage: {
                        ofTotalUsdcObligation: report.coverageOfTotalUsdcObligation ? report.coverageOfTotalUsdcObligation.toString() : null,
                        ofEvidenceLinkedSubset: report.coverageOfEvidenceLinkedSubset ? report.coverageOfEvidenceLinkedSubset.toString() : null,
                    },
                    invariant: {
                        target: 'REAL USDC ASSETS >= ALL CUSTOMER USDC LIABILITIES + RESTRICTED OBLIGATIONS',
                        satisfied: report.isFullyBacked,
                        restrictedObligationsModeled: false,
                        // Why fully-backed is impossible right now: the restricted
                        // component of the denominator is not modeled (§P.4+).
                        blockedBy: report.isFullyBacked ? null : (report.restrictedObligationsKnown ? null : 'RESTRICTED_OBLIGATIONS_UNKNOWN'),
                    },
                },
                // §P.3 additive columns.
                usdcLiabilityTotal: report.usdcLiabilityTotal, // null = classification invalid, fail closed
                evidenceLinkedLiabilityTotal: report.evidenceLinkedLiabilityTotal,
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
                    usdcLiabilityTotal: report.usdcLiabilityTotal ? report.usdcLiabilityTotal.toString() : null,
                    evidenceLinkedLiabilityTotal: report.evidenceLinkedLiabilityTotal ? report.evidenceLinkedLiabilityTotal.toString() : null,
                    unclassifiedExposure: report.unclassifiedExposure ? report.unclassifiedExposure.toString() : null,
                    mixedPoolLiabilityTotal: state.mixedPoolTotal.toString(),
                    eligibleReserveTotal: report.eligibleReserveTotal.toString(),
                    coverageOfTotalUsdcObligation: report.coverageOfTotalUsdcObligation ? report.coverageOfTotalUsdcObligation.toString() : null,
                    coverageOfEvidenceLinkedSubset: report.coverageOfEvidenceLinkedSubset ? report.coverageOfEvidenceLinkedSubset.toString() : null,
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
