/**
 * Shared ONCE-settlement core for settled Moolre collections (r15 R15-B).
 * =========================================================================
 * Both the mounted P01 webhook (evidence source: provider callback) and the
 * status-query recovery path (evidence source: POST /open/transact/status,
 * moolreCollectionRecoveryService) settle a deposit through THIS EXACT
 * transaction — exactly one implementation of the deposit's economic
 * transition, so the two authority surfaces can never diverge:
 *
 *   quote consumption → route gate → exact-pesewa amount match →
 *   PENDING→COMPLETED database CAS claim (single winner) → customer credit →
 *   Model B settlement / §P.4 ledger posting → liquidity receipt.
 *
 * Exactly-once is enforced by the TransactionHistory CAS claim: whichever
 * surface commits first wins; every other attempt fails closed and rolls
 * back with zero economic effect. The durable evidence identity is shared
 * (event:moolre-collection:<externalref>): a callback racing a status query
 * converges on the SAME observation; materially different observations fail
 * closed as contradictory evidence.
 *
 * The body below is the verbatim r13-audited webhook transaction
 * (moolreQuoteDepositController.webhook); the webhook now calls this module.
 */
const { Prisma } = require('@prisma/client');
const routePolicy = require('./routePolicyService');
const logger = require('../../src/config/logger');
const {
    consumeTransactionQuote,
} = require('./transactionQuoteService');
const fiatLiquidity = require('./fiatLiquidityService');
const modelBSettlement = require('../../services/modelBSettlementService');
const ledger = require('../../services/ledgerService'); // §P.4 authoritative ledger

class ProviderRefContradictionError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ProviderRefContradictionError';
        this.code = code || 'PROVIDER_REF_CONTRADICTION';
    }
}

/**
 * Reconcile the durable provider evidence's providerRef with the
 * TransactionHistory initiation stamp BEFORE any settlement mutation
 * (verbatim r13/r14 webhook semantics):
 *   * event NULL + TH ref   → enrich the observation (r11 substrate CAS)
 *   * event ref + TH NULL   → stamp TransactionHistory (CAS on NULL)
 *   * both present, differ  → CONTRADICTION — fail closed, NOTHING settles
 *   * equal (or both NULL)  → converged — settle on the shared identity
 * Throws ProviderRefContradictionError (or the substrate's
 * ConflictingEvidenceError) on contradiction.
 */
async function reconcileSettlementProviderRef(prisma, { deposit, providerEvent }) {
    const eventRef = providerEvent.providerRef ?? null;
    const thRefNow = (await prisma.transactionHistory.findUnique({
        where: { id: deposit.id },
        select: { providerRef: true },
    }))?.providerRef ?? null;
    if (eventRef != null && thRefNow != null && eventRef !== thRefNow) {
        throw new ProviderRefContradictionError(
            'Durable provider evidence and the initiation record carry different provider references for this deposit — settlement blocked for reconciliation.',
            'PROVIDER_REF_CONTRADICTION',
        );
    }
    if (eventRef == null && thRefNow != null) {
        try {
            await fiatLiquidity.enrichProviderEventRefByDedupKey(prisma, providerEvent.dedupKey, thRefNow);
        } catch (reconcileErr) {
            if (reconcileErr instanceof fiatLiquidity.ConflictingEvidenceError) {
                throw new ProviderRefContradictionError(reconcileErr.message, 'CONTRADICTORY_PROVIDER_EVIDENCE');
            }
            throw reconcileErr;
        }
        return thRefNow;
    }
    if (eventRef != null && thRefNow == null) {
        await prisma.transactionHistory.updateMany({
            where: { id: deposit.id, providerRef: null },
            data: { providerRef: eventRef },
        });
        return eventRef;
    }
    return eventRef;
}

/**
 * Settle ONE settled Moolre collection exactly once.
 *
 * @param prisma           caller-owned PrismaClient (the caller owns the
 *                         transaction boundary — this function runs its own
 *                         atomic $transaction)
 * @param deposit          the TransactionHistory deposit row (id, userId,
 *                         metadata) — status must still be PENDING; the CAS
 *                         claim inside is the single-winner authority
 * @param quoteId          the deposit's bound quote (metadata.quoteId)
 * @param settledGhs       EXACT Prisma.Decimal of the collected GHS
 * @param providerEvent    the COMMITTED FiatProviderEvent observation backing
 *                         this settlement (its dedupKey is the receipt's
 *                         evidence identity)
 * @param settlementProviderRef the converged provider ref identity
 * @param payerMsisdn      payer identity when the surface observed one
 * @param providerData     the raw provider payload (metadata.providerData)
 * @param evidenceSource   'moolre_webhook' | 'moolre_status_query' (recorded
 *                         in the receipt evidence for the audit trail)
 */
async function settleMoolreDeposit(prisma, {
    deposit, quoteId, settledGhs, providerEvent, settlementProviderRef,
    payerMsisdn = null, providerData = null, evidenceSource,
}) {
    if (!quoteId) {
        throw new Error('Deposit is missing its transaction quote.');
    }
    if (evidenceSource !== 'moolre_webhook' && evidenceSource !== 'moolre_status_query') {
        throw new Error(`[moolreDepositSettlement] unknown evidence source ${evidenceSource}`);
    }
    const externalRef = providerEvent.relatedReference ?? deposit.txHash;
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);
    // §P.5-E: OFF (default) keeps the §P.4 clearing:conversion bridge; ON
    // settles the purchase through authoritative inventory (Model B).
    const modelBOn = await modelBSettlement.isModelBSettlementEnabled(prisma);

    const result = await prisma.$transaction(async (tx) => {
    const quote = await consumeTransactionQuote({
      prisma: tx,
      quoteId,
      userId: deposit.userId,
      purpose: 'deposit',
    });

    // §P.5-C settlement binding: this surface's authenticated provider
    // identity is the Moolre HMAC. A quote whose selected route may not
    // settle via Moolre fails closed BEFORE any mutation. Quotes from the
    // generic aggregator's OTP-confirmed MoMo rails legitimately settle
    // here (their settlementSurfaces include MOOLRE_WEBHOOK); historical
    // quotes without a selected route also still settle.
    routePolicy.assertSettlementRouteAllowed({ quote, settlementSurface: 'MOOLRE_WEBHOOK' });

    // ── §P.5-D/r10: the GHS settlement comparison runs on EXACT decimals —
    // the webhook amount never touches JS Number. §P.5-E Model B authority:
    // exact pesewa equality against the quote — 99.99/100.01 against a
    // 100.00 quote fail closed BEFORE any mutation. The ±0.01 tolerance is
    // the flag-OFF legacy affordance only (audit r1), now EXACT: uniformly
    // one-pesewa-inclusive at every magnitude, where the old float boundary
    // accepted/rejected the same delta depending on binary rounding
    // accidents.
    // §P.5-E audit r13 (§2): the GHS comparison and EVERY authoritative
    // write below consume the quote's EXACT persisted strings — the legacy
    // Number fields stay presentation-only. Number() silently destroys the
    // 12dp USDC tail at magnitude and made the Model B exact-quote binding
    // fail closed on VALID quotes.
    const quotedGhs = new Prisma.Decimal(quote.amountGhsExact ?? quote.amountGhs); // exact 2dp persisted quote amount
    const quotedUsdcExact = quote.usdcAmountExact ?? String(quote.usdcAmount); // exact 12dp persisted quote amount
    // the committed ledger authority: the persisted 12dp quote projected ONCE
    // at 8dp HALF_UP — exactly the projection Model B re-derives
    const settledUsdcLedger = new Prisma.Decimal(quotedUsdcExact).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    if (modelBOn
      ? settledGhs.toFixed(2) !== quotedGhs.toFixed(2)
      : settledGhs.sub(quotedGhs).abs().greaterThan('0.01')) {
      throw new Error('Settled GHS amount does not match the transaction quote');
    }

    const user = await tx.user.findUnique({ where: { id: deposit.userId } });
    if (!user) throw new Error('User no longer exists for this deposit.');

    // ── §P.5-E audit r5 (state-machine CAS) ──────────────────────────
    // The PENDING → COMPLETED claim is made by the DATABASE's conditional
    // update, NOT by the `deposit.status === 'PENDING'` pre-read (the caller's stale row) —
    // that read happened OUTSIDE this transaction and is stale by the time
    // we claim. A competing failure callback (PENDING → FAILED) that
    // committed in between leaves this update matching ZERO rows; we fail
    // closed and the entire settlement transaction (quote consumption,
    // customer credit, ledger posting, Model B settlement, liquidity
    // receipt) rolls back. A terminal FAILED deposit can never be
    // resurrected to COMPLETED.
    const claimed = await tx.transactionHistory.updateMany({
      where: { id: deposit.id, status: 'PENDING' },
      data: {
        status: 'COMPLETED',
        amountUsdc: settledUsdcLedger,
        payerMsisdn: payerMsisdn ?? (providerData?.payer || null),
        metadata: {
          ...(deposit.metadata || {}),
          settledAmountGhs: settledGhs.toFixed(2), // exact decimal string — never a collapsed float
          settledAt: new Date().toISOString(),
          settledRoute: quote.selectedRoute || null,
          settledRoutePolicyVersion: quote.routePolicyVersion || null,
          providerData: providerData ?? null,
        },
      },
    });
    if (claimed.count !== 1) {
      throw new Error('Deposit is no longer PENDING — a concurrent state transition won; refusing to settle');
    }
    // Read AFTER the claim, inside the claiming transaction: the exact
    // 8dp amount PostgreSQL stored. The conditional update above is the
    // state-machine claim authority — this read can never observe a
    // different state.
    const updatedTx = await tx.transactionHistory.findUnique({ where: { id: deposit.id } });

    // §P.5-E audit r13 (§2): the balance increment is the EXACT 8dp ledger
    // projection of the persisted 12dp quote — never a lossy JS Number
    // that PostgreSQL would have to re-round.
    await tx.user.update({
      where: { id: deposit.userId },
      data: { availableBalance: { increment: settledUsdcLedger } },
    });

    // §P.4 AUTHORITATIVE ACCOUNTING — same caller transaction as the
    // projection credit + TransactionHistory settlement:
    //   D clearing:conversion   — explicit temporary clearing (§P.5 later)
    //   C user:{id}:liability    — customer liability increases
    //
    // §P.5-E: the flag ON path settles Model B instead — FIFO inventory
    // lot claim, GHS asset accounting (fiat:momo:ghs / equity:treasury:ghs),
    // COGS realization, treasury-stake-funded customer liability and the
    // durable realized-economics record — clearing:conversion is NOT
    // touched (docs/p5e-model-b-settlement.md §2.4).
    if (modelBOn) {
      await modelBSettlement.settleDepositFromInventory(tx, {
        reference: externalRef,
        transactionHistoryId: deposit.id,
        userId: deposit.userId,
        quoteId,
        // §P.5-E audit r13 (§2): the Model B quote binding receives the
        // EXACT persisted 12dp authority — the primitive re-verifies it
        // against the persisted quote row and fails closed on ANY lossy
        // caller projection.
        quotedGhs: quote.amountGhsExact ?? quote.amountGhs,
        quotedRateGhsPerUsdc: quote.rateGhsPerUsdcExact ?? quote.rateGhsPerUsdc,
        quotedUsdc: quotedUsdcExact,
        settledGhs,
        settledUsdc: updatedTx.amountUsdc, // exact Decimal(20,8) — the ledger authority
        selectedRoute: quote.selectedRoute || null,
        routeProviderRail: quote.routeProviderRail || null,
        routePolicyVersion: quote.routePolicyVersion || null,
        provider: 'MOOLRE',
        // §r13 (§4/§7): the reconciled provider identity — never a stale
        // pre-evidence read
        providerRef: settlementProviderRef,
        // §P.5-D/P.5-E: the identity of the observation this settlement is
        // backed by — the RETURNED committed event row's dedupKey, never a
        // re-invented key (a materially different later observation lives on
        // its own row and can never masquerade as this evidence).
        evidenceDedupKey: providerEvent.dedupKey,
      });
    } else {
    await ledger.post(tx, {
      idempotencyKey: `ledger:deposit:fiat:${externalRef}`,
      entryType: 'DEPOSIT',
      description: 'Fiat-settled USDC deposit credited (Moolre/aggregator settlement)',
      reference: externalRef,
      userId: deposit.userId,
      relatedEntity: 'transactionHistory',
      relatedEntityId: deposit.id,
      metadata: { source: 'moolre', quoteId, amountGhs: settledGhs, selectedRoute: quote.selectedRoute || null, routeProviderRail: quote.routeProviderRail || null },
      // Post EXACTLY what the settled TransactionHistory row records
      // (Decimal(20,8)) — quote.usdcAmount is numeric(30,12) and its JS
      // float form can carry >8 decimals, which the ledger's exactness
      // guard correctly refuses. The ledger and the canonical row can
      // never disagree.
      lines: [
        { account: 'clearing:conversion', debit: updatedTx.amountUsdc },
        { account: `user:${deposit.userId}:liability`, credit: updatedTx.amountUsdc },
      ],
    });
    }

    // §P.5-D (flag ON): the settled, quote-matched Moolre collection —
    // rail-gated by the providerRef proof — IS the evidence that creates
    // AVAILABLE GHS liquidity, in the SAME transaction as the deposit CAS
    // claim. Unmatched or unverified evidence NEVER lands AVAILABLE
    // (docs §3.1, invariant 1).
    if (liquidityAuthorityOn) {
      await fiatLiquidity.recordReceipt(tx, {
        provider: 'MOOLRE',
        rail: quote.routeProviderRail || null,
        providerRef: settlementProviderRef ?? null,
        dedupKey: `receipt:moolre-collection:${externalRef}`,
        amountGhs: settledGhs,
        route: quote.selectedRoute || null,
        reference: externalRef,
        relatedTransactionId: deposit.id,
        eventDedupKey: providerEvent.dedupKey,
        // §L (r14): the receipt names the deposit's OWN quote — the
        // evidence chain re-proves the r13 metadata binding.
        quoteId,
        evidence: {
          source: 'moolre_collection',
          quoteId,
          providerRef: settlementProviderRef,
          payer: payerMsisdn ?? (providerData?.payer || null),
          settledAt: new Date().toISOString(),
        },
      });
    }

    return { updatedTx, quote, newBalance: Number(user.availableBalance) + Number(quote.usdcAmount) };
    });
    return result;
}

module.exports = {
    settleMoolreDeposit,
    reconcileSettlementProviderRef,
    ProviderRefContradictionError,
};
