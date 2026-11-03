'use strict';

/**
 * NATIVE-GHS WITHDRAWAL LEG (issue #389, Agent A).
 * =============================================================================
 * The customer's GHS never round-trips through USDC. A GHS-only payout debits
 * `user.nativeGhsBalance` (exact pesewas) against the SAME provider float the
 * collections leg credits (`fiat:momo:ghs`), reserves the required GHS through
 * the established P5-D fiat-liquidity authority (one atomic claim, no second
 * float), and rides the EXISTING withdrawal state machine: canonical
 * TransactionHistory row, Withdrawal reconciliation mirror, FinancialOperation
 * claim committed inside the same economic transaction, post-commit dispatch
 * with persisted evidence, once-only reversal, and hold-and-reconcile for
 * unknown outcomes.
 *
 * HONEST NON-GOALS
 *   • No FX anywhere in a GHS-only payout. The only rate in this module belongs
 *     to an explicit, quoted, consented USDC→GHS shortfall conversion.
 *   • No new ledger, no new idempotency registry, no second payout state
 *     machine, no client-side financial arithmetic.
 *   • Legacy USDC-denominated withdrawals are untouched (this module is only
 *     reachable behind GlobalSettings.nativeGhsWithdrawalEnabled === true).
 *
 * AUTHORITY FLAG: GlobalSettings."nativeGhsWithdrawalEnabled" (default FALSE,
 * installed by infra/install-native-ghs-withdrawal-overlay.js).
 */

const { Prisma } = require('@prisma/client');
const logger = require('../../src/config/logger');
const ledger = require('../../services/ledgerService');
const nativeGhsWallet = require('./nativeGhsWalletService');
const fiatLiquidity = require('./fiatLiquidityService');
const quotes = require('./transactionQuoteService');
const { recordReconciliationException } = require('../../services/reconciliationExceptionService');
const { QUOTE_PURPOSE } = require('./ghsFundingPlanner');

const SETTLEMENT_CURRENCY = 'GHS_NATIVE';
const DISPATCH_PROVIDER = 'MOOLRE_DISBURSEMENT';
const DISPATCH_RAIL = 'MOMO';
const LEDGER_KEY_PREFIX = 'ledger:wallet:withdrawal-ghs:';
const FUNDING_LEDGER_KEY_PREFIX = 'ledger:wallet:withdrawal-ghs-funding:';
const REVERSAL_KEY_PREFIX = 'ledger:reversal:withdrawal-ghs:';
const FUNDING_REVERSAL_KEY_PREFIX = 'ledger:reversal:withdrawal-ghs-funding:';
const REVERSAL_MARKER = 'nativeGhsWithdrawalReversal';

// v1 fee policy (issue #389 / #382 open question 4): the Moolre MoMo payout
// fee is 0, so the recipient receives EXACTLY amountGhs and totalDebitGhs
// equals amountGhs. The policy is EXPLICIT and itemised in the response and in
// metadata — never inferred from provider facts, never silently changed.
const GHS_NATIVE_FEE_POLICY = Object.freeze({
  code: 'ZERO_FEE_V1',
  feeGhs: '0.00',
  note: 'Moolre MoMo payout fee is zero on the current contract; the recipient receives exactly amountGhs.',
});

class NativeGhsWithdrawalError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NativeGhsWithdrawalError';
    this.code = code || 'NATIVE_GHS_WITHDRAWAL_ERROR';
  }
}

/** Fail-closed rollout read: absent row / absent column / error => disabled. */
async function isNativeGhsWithdrawalEnabled(db) {
  try {
    const row = await db.globalSettings.findUnique({
      where: { id: 1 },
      select: { nativeGhsWithdrawalEnabled: true },
    });
    return row?.nativeGhsWithdrawalEnabled === true;
  } catch (err) {
    logger.warn({ err: err.message }, '[nativeGhsWithdrawal] flag read failed — treating as DISABLED');
    return false;
  }
}

function toExactPesewa(value, field = 'amountGhs') {
  if (value === null || value === undefined || value === '') {
    throw new NativeGhsWithdrawalError(`${field} is required`, 'GHS_AMOUNT_REQUIRED');
  }
  let d;
  try {
    d = new Prisma.Decimal(String(value));
  } catch (_) {
    throw new NativeGhsWithdrawalError(`${field} is not a decimal amount`, 'GHS_AMOUNT_INVALID');
  }
  if (!d.isFinite() || d.lessThanOrEqualTo(0)) {
    // Dust guard analog of #380: a zero payout can never be dispatched.
    throw new NativeGhsWithdrawalError(`${field} must be greater than zero`, 'GHS_AMOUNT_INVALID');
  }
  if (!d.equals(d.toDecimalPlaces(2))) {
    throw new NativeGhsWithdrawalError(
      `${field} must be an exact 2-dp GHS amount (pesewa precision)`,
      'GHS_AMOUNT_PRECISION'
    );
  }
  return d;
}

/**
 * The single economic leg for a native-GHS payout, in ONE database
 * transaction: [optional quoted USDC→GHS shortfall funding] → native GHS debit
 * (CAS floor) → canonical TransactionHistory + Withdrawal mirror → P5-D GHS
 * liquidity claim → FinancialOperation claim (COMMITTED before any provider
 * I/O). Any throw rolls back every part.
 */
async function processNativeGhsWithdrawal(prisma, userId, args, opts = {}) {
  const {
    amountGhs,
    destination,
    network = null,
    reference,
    quoteId = null,
    // 'MOMO' (default, unchanged) or 'BANK' — an EXPLICIT typed destination.
    // The rail is never inferred from the destination string.
    destinationType = 'MOMO',
    beneficiaryId = null,
  } = args;
  if (!reference) throw new NativeGhsWithdrawalError('reference is required', 'REFERENCE_REQUIRED');
  const recipientGhs = toExactPesewa(amountGhs);
  const feeGhs = new Prisma.Decimal(GHS_NATIVE_FEE_POLICY.feeGhs);
  const totalDebitGhs = recipientGhs.plus(feeGhs);

  // The P5-D fiat-liquidity authority is REQUIRED: the legacy SystemFiatPool
  // is a USDC scalar and cannot denominate a GHS payout. Fail closed rather
  // than reserve against a unit-less pool.
  const authorityOn = await fiatLiquidity.isAuthorityEnabled(prisma).catch(() => false);
  if (!authorityOn) {
    throw new NativeGhsWithdrawalError(
      'Native-GHS payouts require the P5-D fiat-liquidity authority. Governance is unresolved — nothing was reserved.',
      'NATIVE_GHS_LIQUIDITY_AUTHORITY_REQUIRED'
    );
  }

  return prisma.$transaction(async (tx) => {
    // ── optional, quoted, consented USDC→GHS shortfall funding ─────────────
    let funding = null;
    if (quoteId) {
      const consumed = await quotes.consumeTransactionQuote({
        prisma: tx,
        quoteId,
        userId,
        purpose: QUOTE_PURPOSE,
      });
      const shortfallGhs = new Prisma.Decimal(consumed.amountGhs);
      // The quote carries an EXACT 12dp USDC quotient; the USDC liability
      // authority is 8dp (ledger scale). Round ONCE, here, at the debit
      // authority — never re-derive the rate.
      const usdcDebit = new Prisma.Decimal(consumed.usdcAmount)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
      const rate = new Prisma.Decimal(consumed.rateGhsPerUsdc);
      if (!shortfallGhs.equals(shortfallGhs.toDecimalPlaces(2)) || shortfallGhs.lessThanOrEqualTo(0)) {
        throw new NativeGhsWithdrawalError('quote shortfall is not exact pesewas', 'NATIVE_GHS_QUOTE_INVALID');
      }
      if (usdcDebit.lessThan(0)) {
        throw new NativeGhsWithdrawalError('quote USDC amount is invalid', 'NATIVE_GHS_QUOTE_INVALID');
      }
      // USDC CAS debit — one atomic claim, no negative balance.
      const debited = await tx.user.updateMany({
        where: { id: userId, availableBalance: { gte: usdcDebit } },
        data: { availableBalance: { decrement: usdcDebit } },
      });
      if (debited.count !== 1) {
        throw new NativeGhsWithdrawalError(
          'Insufficient USDC to fund the GHS shortfall — nothing was converted or reserved.',
          'USDC_INSUFFICIENT_BALANCE'
        );
      }
      // Explicit ASSET_CONVERSION: every leg balances inside its own asset.
      // USDC: customer liability → conversion clearing.
      // GHS : provider float        → customer GHS liability (the funded GHS).
      await ledger.post(tx, {
        idempotencyKey: `${FUNDING_LEDGER_KEY_PREFIX}${reference}`,
        entryType: 'ASSET_CONVERSION',
        description: `GHS shortfall funding for withdrawal ${reference}`,
        userId,
        reference,
        relatedEntity: 'transactionHistory',
        conversion: {
          identity: `withdrawal-ghs-funding:${reference}`,
          rate,
          quoteReference: String(quoteId),
        },
        lines: [
          { account: `user:${userId}:liability`, debit: usdcDebit },
          { account: 'clearing:conversion', credit: usdcDebit },
          { account: 'fiat:momo:ghs', debit: shortfallGhs },
          { account: `ghs:user:${userId}:liability`, credit: shortfallGhs },
        ],
        metadata: { settlementCurrency: SETTLEMENT_CURRENCY, quoteId: String(quoteId) },
      });
      // Projection bump in the SAME transaction: the ledger credit above and
      // the spendable-balance authority must move together (that is exactly
      // what creditNativeGhs does on the collections leg).
      await tx.user.update({
        where: { id: userId },
        data: { nativeGhsBalance: { increment: shortfallGhs } },
      });
      funding = {
        mode: 'USDC_SHORTFALL_FUNDED',
        quoteId: String(quoteId),
        shortfallGhs: shortfallGhs.toFixed(2),
        usdcDebitedExact: usdcDebit.toFixed(8),
        rateGhsPerUsdcExact: rate.toFixed(8),
      };
    }

    // ── native GHS debit: CAS floor, exact pesewas, same provider float ────
    const debit = await nativeGhsWallet.debitNativeGhs({
      tx,
      userId,
      amountGhs: totalDebitGhs,
      idempotencyKey: `${LEDGER_KEY_PREFIX}${reference}`,
      description: `Native GHS withdrawal ${reference}`,
      reference,
      relatedEntity: 'transactionHistory',
      metadata: {
        settlementCurrency: SETTLEMENT_CURRENCY,
        provider: DISPATCH_PROVIDER,
        rail: DISPATCH_RAIL,
        funding: funding ? funding.mode : 'GHS_ONLY',
      },
    });

    // ── canonical operation row + reconciliation mirror (same transaction) ─
    const txRecord = await tx.transactionHistory.create({
      data: {
        userId,
        type: 'WITHDRAWAL_FIAT',
        amountUsdc: new Prisma.Decimal(0), // no USDC moved; asset is explicit
        feeUsdc: new Prisma.Decimal(0),
        txHash: reference,
        status: 'PENDING',
        amountGhs: recipientGhs,
        settlementCurrency: SETTLEMENT_CURRENCY,
        metadata: {
          settlementCurrency: SETTLEMENT_CURRENCY,
          asset: 'GHS',
          amountGhs: recipientGhs.toFixed(2),
          payoutGhs: recipientGhs.toFixed(2),
          totalDebitGhs: totalDebitGhs.toFixed(2),
          feePolicy: GHS_NATIVE_FEE_POLICY,
          provider: DISPATCH_PROVIDER,
          rail: DISPATCH_RAIL,
          network,
          destination,
          funding,
          ledgerReserved: true,
          economicsDeferred: false,
        },
      },
      select: { id: true, status: true },
    });

    const withdrawalRows = await tx.$queryRawUnsafe(
      'INSERT INTO "Withdrawal" ' +
      '("userId", "amount", "amountGhs", "settlementCurrency", "payoutMethod", "network", "destination", "status", "transactionHistoryId", "createdAt", "updatedAt") ' +
      'VALUES ($1, 0, $2::numeric, $3, $4, $5, $6, $7, $8, now(), now()) ' +
      'RETURNING "id", "userId", "amountGhs", "settlementCurrency", "status"',
      userId,
      recipientGhs.toFixed(2),
      SETTLEMENT_CURRENCY,
      destinationType === 'BANK' ? 'BANK' : DISPATCH_RAIL,
      network,
      destination,
      'PENDING',
      txRecord.id
    );
    const withdrawalRecord = withdrawalRows?.[0] ?? null;
    if (!withdrawalRecord) {
      throw new NativeGhsWithdrawalError('Withdrawal mirror insert returned no row', 'WITHDRAWAL_MIRROR_MISSING');
    }

    // ── P5-D GHS liquidity claim: ONE atomic reservation boundary ──────────
    const reservation = await fiatLiquidity.reserveForPayout(tx, {
      reference,
      amountGhs: recipientGhs,
      provider: DISPATCH_PROVIDER,
      rail: destinationType === 'BANK' ? 'BANK' : DISPATCH_RAIL,
      destination,
      relatedTransactionId: txRecord.id,
    });

    const balances = await tx.user.findUnique({
      where: { id: userId },
      select: { nativeGhsBalance: true, availableBalance: true },
    });

    const facts = {
      reference,
      withdrawalRecord,
      txRecord,
      recipientGhsExact: recipientGhs.toFixed(2),
      totalDebitGhsExact: totalDebitGhs.toFixed(2),
      feeGhsExact: feeGhs.toFixed(2),
      nativeGhsBalanceExact: new Prisma.Decimal(balances?.nativeGhsBalance ?? debit.nativeGhsBalanceExact).toFixed(8),
      usdcBalanceExact: new Prisma.Decimal(balances?.availableBalance ?? 0).toFixed(8),
      funding,
      reservationReference: reservation?.reservation?.reference ?? reference,
    };

    if (typeof opts.commitOperationClaimInTransaction === 'function') {
      await opts.commitOperationClaimInTransaction(tx, facts);
    }
    return facts;
  }, { timeout: 20000 });
}

/**
 * Post-commit dispatch. Reuses the SAME canonical claim (TransactionHistory
 * PENDING→DISPATCHING, mutually exclusive with the worker's PENDING→PROCESSING
 * and the admin's PENDING→REJECTED), the SAME dispatcher seam and the SAME
 * evidence/ownership bookkeeping as the USDC leg.
 */
async function dispatchNativeGhsWithdrawal(prisma, {
  reference,
  amountGhsExact,
  destination,
  network = null,
  dispatcher,
  payerMessage,
  payeeNote,
}) {
  if (!reference) throw new NativeGhsWithdrawalError('reference is required', 'REFERENCE_REQUIRED');
  if (!dispatcher || typeof dispatcher.initiateTransfer !== 'function') {
    return { dispatched: false, reason: 'DISPATCHER_UNAVAILABLE' };
  }
  const amount = toExactPesewa(amountGhsExact);

  const row = await prisma.transactionHistory.findUnique({
    where: { txHash: reference },
    select: { id: true, status: true, settlementCurrency: true, type: true },
  });
  if (!row || row.type !== 'WITHDRAWAL_FIAT' || row.settlementCurrency !== SETTLEMENT_CURRENCY) {
    return { dispatched: false, reason: 'NOT_A_NATIVE_GHS_WITHDRAWAL' };
  }
  // The canonical TransactionHistory status is the TransactionStatus ENUM
  // (PENDING until a terminal outcome). The DISPATCH CLAIM lives on the
  // Withdrawal mirror's String status — exactly like the fiat payout path:
  // PENDING -> DISPATCHING is the single-winner dispatch authority, and the
  // worker (-> PROCESSING) and admin (-> REJECTED) compete on the same row.
  const claim = await prisma.withdrawal.updateMany({
    where: { transactionHistoryId: row.id, status: 'PENDING' },
    data: { status: 'DISPATCHING' },
  });
  if (claim.count !== 1) return { dispatched: false, reason: 'DISPATCH_CLAIM_LOST' };
  const canonical = await prisma.transactionHistory.findUnique({ where: { id: row.id }, select: { status: true } });
  if (canonical?.status !== 'PENDING') {
    // A terminal/interim canonical outcome already exists — never dispatch.
    return { dispatched: false, reason: 'DISPATCH_CLAIM_LOST', status: canonical?.status };
  }

  let outbound;
  try {
    outbound = await dispatcher.initiateTransfer({
      referenceId: reference,
      amountGhs: Number(amount.toFixed(2)),
      recipientPhone: destination,
      externalId: reference,
      network: network || undefined,
      payerMessage: payerMessage || `Azaman withdrawal ref ${reference}`,
      payeeNote: payeeNote || `Withdrawal ${reference}`,
    });
  } catch (err) {
    // No accepted provider bytes: DEFINITIVE pre-dispatch failure → reverse once.
    const reversal = await reverseNativeGhsWithdrawal(prisma, {
      reference,
      reason: `provider_rejected:${err?.code || err?.name || 'DISPATCH_ERROR'}`,
    });
    return { dispatched: false, reason: 'PROVIDER_REJECTED', reversed: reversal.reversed, failure: err?.message };
  }

  const providerRef = outbound?.reference || outbound?.transactionId || outbound?.providerRef || null;
  const providerName = outbound?.provider || outbound?.message || null;
  if (providerRef) {
    await prisma.transactionHistory.updateMany({
      where: { id: row.id },
      data: { providerRef: String(providerRef) },
    });
  }
  await prisma.$executeRawUnsafe(
    'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || $2::jsonb WHERE "id" = $1',
    row.id,
    JSON.stringify({
      dispatch: {
        acceptedAt: new Date().toISOString(),
        providerRef: providerRef ? String(providerRef) : null,
        provider: providerName ? String(providerName) : null,
        idempotency: 'canonical-reference',
      },
    })
  );
  try {
    await prisma.$transaction(async (tx) => {
      await fiatLiquidity.markReservationInTransit(tx, { reference, providerRef });
    });
  } catch (err) {
    // Evidence already persisted; IN_TRANSIT bookkeeping is repairable by the
    // reconciliation sweep — never auto-refund a dispatched payout.
    logger.error({ reference, err: err.message }, '[nativeGhsWithdrawal] IN_TRANSIT transition failed after dispatch');
  }
  return { dispatched: true, providerRef, provider: providerName };
}

/**
 * BANK payout dispatch through the INJECTED provider port (Agent B owns the
 * adapter; this module owns the state machine). Same single-winner claim,
 * same reversal authority, same evidence — only the provider call differs.
 */
async function dispatchNaturalGhsBankWithdrawal(prisma, {
  reference,
  amountGhsExact,
  bank,
  port,
  narration,
}) {
  if (!reference) throw new NativeGhsWithdrawalError('reference is required', 'REFERENCE_REQUIRED');
  if (!port || typeof port.initiateBankTransfer !== 'function') {
    return { dispatched: false, reason: 'BANK_PORT_UNAVAILABLE' };
  }
  if (!bank || !bank.accountNumber || !bank.bankCode) {
    return { dispatched: false, reason: 'BANK_DESTINATION_INCOMPLETE' };
  }
  const amount = toExactPesewa(amountGhsExact);
  const row = await prisma.transactionHistory.findUnique({
    where: { txHash: reference },
    select: { id: true, type: true, settlementCurrency: true },
  });
  if (!row || row.type !== 'WITHDRAWAL_FIAT' || row.settlementCurrency !== SETTLEMENT_CURRENCY) {
    return { dispatched: false, reason: 'NOT_A_NATIVE_GHS_WITHDRAWAL' };
  }
  const claim = await prisma.withdrawal.updateMany({
    where: { transactionHistoryId: row.id, status: 'PENDING', payoutMethod: 'BANK' },
    data: { status: 'DISPATCHING' },
  });
  if (claim.count !== 1) return { dispatched: false, reason: 'DISPATCH_CLAIM_LOST' };

  let outbound;
  try {
    outbound = await port.initiateBankTransfer({
      referenceId: reference,
      externalId: reference,
      amountGhs: amount.toFixed(2),
      bankCode: bank.bankCode,
      accountNumber: bank.accountNumber,
      accountName: bank.accountName || null,
      narration: narration || `Azaman payout ${reference}`,
    });
  } catch (err) {
    // No accepted provider bytes: definitive pre-dispatch failure → reverse once.
    const reversal = await reverseNativeGhsWithdrawal(prisma, { reference, reason: err.message });
    return { dispatched: false, reason: 'PROVIDER_REJECTED', error: err.message, reversal };
  }
  const providerRef = outbound?.providerRef || outbound?.transactionId || null;
  await prisma.$executeRawUnsafe(
    'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || $2::jsonb WHERE "id" = $1',
    row.id,
    JSON.stringify({ dispatch: { acceptedAt: new Date().toISOString(), rail: 'BANK', providerRef, idempotency: 'canonical-reference' } })
  );
  try {
    await prisma.$transaction(async (tx) => {
      await fiatLiquidity.markReservationInTransit(tx, { reference, providerRef });
    });
  } catch (err) {
    logger.error({ reference, err: err.message }, '[nativeGhsWithdrawal] BANK IN_TRANSIT transition failed after dispatch');
  }
  return { dispatched: true, providerRef, rail: 'BANK' };
}

/**
 * ONCE-ONLY reversal for a payout that provably never left (no accepted
 * provider bytes). Mirrors the collections-leg marker discipline: a raw jsonb
 * CAS stamps the canonical row before any money moves, so a replay or a
 * concurrent authority can never reverse twice.
 */
async function reverseNativeGhsWithdrawal(prisma, { reference, reason }) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.transactionHistory.findUnique({
      where: { txHash: reference },
      select: { id: true, userId: true, status: true, metadata: true, amountGhs: true, settlementCurrency: true },
    });
    if (!row || row.settlementCurrency !== SETTLEMENT_CURRENCY) {
      return { reversed: false, reason: 'NOT_A_NATIVE_GHS_WITHDRAWAL' };
    }
    if (row.status !== 'PENDING') {
      return { reversed: false, reason: 'NOT_REVERSIBLE_IN_STATE', status: row.status };
    }
    const mirror = await tx.withdrawal.findFirst({
      where: { transactionHistoryId: row.id },
      select: { id: true, status: true },
    });
    if (mirror && !['PENDING', 'DISPATCHING'].includes(mirror.status)) {
      return { reversed: false, reason: 'NOT_REVERSIBLE_IN_STATE', status: mirror.status };
    }
    const stamped = await tx.$executeRawUnsafe(
      'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, jsonb_build_object(\'at\', now(), \'reason\', $3::text)) ' +
      'WHERE "id" = $1 AND "metadata"->>$2 IS NULL RETURNING "id"',
      row.id,
      REVERSAL_MARKER,
      String(reason ?? 'definitive_failure')
    );
    if (!stamped) return { reversed: false, reason: 'ALREADY_REVERSED_OR_RACED' };

    const amountGhs = row.amountGhs ? new Prisma.Decimal(row.amountGhs) : null;
    if (!amountGhs) {
      // Without the authoritative amount the reversal cannot be exact — the
      // stamp rolls back and the row parks for reconciliation.
      throw new NativeGhsWithdrawalError('reversal amount missing', 'NATIVE_GHS_REVERSAL_AMOUNT_MISSING');
    }
    await nativeGhsWallet.creditNativeGhs({
      tx,
      userId: row.userId,
      amountGhs,
      idempotencyKey: `${REVERSAL_KEY_PREFIX}${reference}`,
      description: `Native GHS withdrawal reversal ${reference}`,
      reference,
      relatedEntity: 'transactionHistory',
      relatedEntityId: row.id,
      metadata: { settlementCurrency: SETTLEMENT_CURRENCY, reversalReason: String(reason ?? 'definitive_failure') },
    });

    // Funded shortfall → the customer's USDC must come back exactly once.
    const funding = row.metadata?.funding;
    if (funding && funding.mode === 'USDC_SHORTFALL_FUNDED' && funding.usdcDebitedExact) {
      const usdc = new Prisma.Decimal(funding.usdcDebitedExact);
      const shortfall = new Prisma.Decimal(funding.shortfallGhs);
      const rate = new Prisma.Decimal(funding.rateGhsPerUsdcExact ?? 0);
      await tx.user.update({ where: { id: row.userId }, data: { availableBalance: { increment: usdc } } });
      await ledger.post(tx, {
        idempotencyKey: `${FUNDING_REVERSAL_KEY_PREFIX}${reference}`,
        entryType: 'ASSET_CONVERSION',
        description: `GHS shortfall funding reversal ${reference}`,
        userId: row.userId,
        reference,
        relatedEntity: 'transactionHistory',
        conversion: { identity: `withdrawal-ghs-funding:${reference}`, rate, quoteReference: funding.quoteId ?? null },
        lines: [
          { account: 'clearing:conversion', debit: usdc },
          { account: `user:${row.userId}:liability`, credit: usdc },
          { account: `ghs:user:${row.userId}:liability`, debit: shortfall },
          { account: 'fiat:momo:ghs', credit: shortfall },
        ],
        metadata: { settlementCurrency: SETTLEMENT_CURRENCY, reversal: true },
      });
    }

    try {
      await fiatLiquidity.releaseReservation(tx, { reference, reason: String(reason ?? 'definitive_failure') });
    } catch (err) {
      logger.warn({ reference, err: err.message }, '[nativeGhsWithdrawal] reservation release failed during reversal');
    }

    await tx.transactionHistory.updateMany({ where: { id: row.id }, data: { status: 'FAILED' } });
    await tx.withdrawal.updateMany({ where: { transactionHistoryId: row.id }, data: { status: 'FAILED' } });
    return { reversed: true, amountGhs: amountGhs.toFixed(2) };
  });
}

/**
 * Evidence sweep: a committed native-GHS withdrawal must have its exact ledger
 * posting (and, while unresolved, its liquidity reservation). Missing evidence
 * is FLAGGED, never silently corrected.
 */
async function reconcileNativeGhsWithdrawals(prisma, { since, take = 500 } = {}) {
  const rows = await prisma.transactionHistory.findMany({
    where: {
      type: 'WITHDRAWAL_FIAT',
      settlementCurrency: SETTLEMENT_CURRENCY,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: { id: true, txHash: true, userId: true, status: true },
    take,
  });
  const flagged = [];
  for (const row of rows) {
    if (!row.txHash) continue;
    // eslint-disable-next-line no-await-in-loop
    const posted = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `${LEDGER_KEY_PREFIX}${row.txHash}` },
    });
    if (posted) continue;
    // eslint-disable-next-line no-await-in-loop
    await recordReconciliationException(prisma, {
      entityType: 'TRANSACTION',
      entityId: row.txHash,
      reference: row.txHash,
      reason: 'NATIVE_GHS_WITHDRAWAL_LEDGER_MISSING',
      details: {
        settlementCurrency: SETTLEMENT_CURRENCY,
        expectedLedgerIdempotencyKey: `${LEDGER_KEY_PREFIX}${row.txHash}`,
        status: row.status,
        userId: row.userId,
      },
    });
    flagged.push(row.txHash);
  }
  return { scanned: rows.length, flagged };
}

module.exports = {
  SETTLEMENT_CURRENCY,
  DISPATCH_PROVIDER,
  DISPATCH_RAIL,
  GHS_NATIVE_FEE_POLICY,
  NativeGhsWithdrawalError,
  isNativeGhsWithdrawalEnabled,
  toExactPesewa,
  processNativeGhsWithdrawal,
  dispatchNativeGhsWithdrawal,
  dispatchNaturalGhsBankWithdrawal,
  reverseNativeGhsWithdrawal,
  reconcileNativeGhsWithdrawals,
};
