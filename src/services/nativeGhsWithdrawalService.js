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
const savedBankBeneficiaryService = require('./savedBankBeneficiaryService');
const nativeGhsWallet = require('./nativeGhsWalletService');
const fiatLiquidity = require('./fiatLiquidityService');
const quotes = require('./transactionQuoteService');
const { recordReconciliationException } = require('../../services/reconciliationExceptionService');
const { persistPayoutOwnership } = require('../../services/payoutProviderOwnership');
const { QUOTE_PURPOSE, QUOTE_IDENTITY_KIND } = require('./ghsFundingPlanner');
const { destinationIdentityOf, payoutIntentDigest } = require('./payoutIntent');

const SETTLEMENT_CURRENCY = 'GHS_NATIVE';
const DISPATCH_PROVIDER = 'MOOLRE_DISBURSEMENT';
const DISPATCH_RAIL = 'MOMO';
const LEDGER_KEY_PREFIX = 'ledger:wallet:withdrawal-ghs:';
const FUNDING_LEDGER_KEY_PREFIX = 'ledger:wallet:withdrawal-ghs-funding:';
// The conversion identity of the ORIGINAL funding posting. It is immutable and
// the reversal must never reuse it (the ledger is unique on conversionIdentity).
const FUNDING_CONVERSION_PREFIX = 'withdrawal-ghs-funding:';
const REVERSAL_KEY_PREFIX = 'ledger:reversal:withdrawal-ghs:';
const FUNDING_REVERSAL_KEY_PREFIX = 'ledger:reversal:withdrawal-ghs-funding:';
// The reversal is its OWN exchange, not a replay of the funding: the ledger
// enforces uniqueness of conversionIdentity, so reusing the funding identity
// would make every mixed-funded reversal fail (and the refund roll back).
const FUNDING_REVERSAL_CONVERSION_PREFIX = 'withdrawal-ghs-funding-reversal:';
const REVERSAL_MARKER = 'nativeGhsWithdrawalReversal';

// v1 fee policy (issue #389 / #382 open question 4): the Moolre MoMo payout
// fee is 0, so the recipient receives EXACTLY amountGhs and totalDebitGhs
// equals amountGhs. The policy is EXPLICIT and itemised in the response and in
// metadata — never inferred from provider facts, never silently changed.
// BANK rail fee policy: NONE agreed by default. Resolved at CALL time so the
// rail is enabled only by an explicit, visible configuration and never by an
// assumption baked into the module. Unset => the BANK leg refuses (see the
// guard in processNativeGhsWithdrawal) instead of inheriting the MoMo
// zero-fee contract, which is a different provider leg entirely.
/**
 * The MoMo payout fee policy — the OTHER rail's contract. The MoMo shortfall
 * plan and the MoMo payout must both read this, so a bank fee setting (or its
 * absence) can never move a MoMo quote.
 */
function momoPayoutFeePolicy() {
  return GHS_NATIVE_FEE_POLICY;
}

function bankPayoutFeePolicy() {
  const raw = process.env.BANK_PAYOUT_FEE_GHS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let fee;
  try {
    fee = new Prisma.Decimal(String(raw).trim());
  } catch (_) {
    return null;
  }
  if (!fee.isFinite() || fee.isNegative()) return null;
  // §P1-3 A NON-ZERO CUSTOMER FEE IS NOT SAFE YET. The debit includes the fee,
  // but a failed bank payout is refunded through reverseNativeGhsWithdrawal,
  // whose credit is the recipient amount. Charging a fee the reversal path does
  // not return would leave the customer short by exactly that fee whenever the
  // payout fails — and it is the failing payouts where the customer can least
  // afford to fund our unresolved policy. Until the fee payer and the refund
  // policy are explicitly approved, a non-zero fee must not enable the rail.
  // (Zero is a real policy and must be configured explicitly, which is why an
  // absent value still refuses: silence is not a fee agreement.)
  if (fee.greaterThan(0)) return null;
  return {
    code: 'BANK_FEE_V1',
    feeGhs: fee.toFixed(2),
    note: 'Configured zero-fee bank policy. The recipient receives exactly amountGhs and the debit equals the recipient amount.',
  };
}

const GHS_NATIVE_FEE_POLICY = Object.freeze({
  code: 'ZERO_FEE_V1',
  feeGhs: '0.00',
  note: 'Moolre MoMo payout fee is zero on the current contract; the recipient receives exactly amountGhs.',
});

class NativeGhsWithdrawalError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'NativeGhsWithdrawalError';
    this.code = code || 'NATIVE_GHS_WITHDRAWAL_ERROR';
    // Structured, non-secret context for the refusal (quoted vs current split,
    // etc.). Never carries an account number or a credential.
    this.details = details;
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
/**
 * §P1-4 THE ACCEPTANCE SNAPSHOT IS EVIDENCE, AND EVIDENCE IS SERVER-OWNED.
 *
 * A MoMo payout used to record nothing but the string the request carried: the
 * confirmation screen, the reconciliation surface and a dispute could not agree
 * on which number had been accepted, and nothing stated whether the payee name
 * had ever been checked by anyone. Verified and unverified were
 * indistinguishable, because neither was written down.
 *
 * This builds the record from server-side facts only. accountNameVerified is
 * false with an explicit reason because this rail performs no name lookup at
 * acceptance — the field states what happened, not what we wish had happened.
 */
function buildMomoDestinationSnapshot({ destination, network = null, capturedAt = new Date() } = {}) {
  const digits = String(destination ?? '').replace(/\D/g, '');
  const masked = digits.length >= 4 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : '****';
  return {
    destinationType: 'MOMO',
    network: network || null,
    destinationMasked: masked,
    destinationDigits: digits.length, // length only: enough to spot a truncated number
    accountNameVerified: false,
    verification: 'NOT_LOOKED_UP',
    capturedAt: new Date(capturedAt).toISOString(),
  };
}

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
    destinationSnapshot = null,
    beneficiaryId = null,
  } = args;
  if (!reference) throw new NativeGhsWithdrawalError('reference is required', 'REFERENCE_REQUIRED');
  const recipientGhs = toExactPesewa(amountGhs);
  // §9 FEE POLICY IS PER RAIL AND MUST BE EVIDENCED. ZERO_FEE_V1 is a MOBILE
  // MONEY contract: Moolre charges nothing on the MoMo payout leg. It says
  // nothing whatsoever about a BANK transfer, so inheriting it silently would
  // promise the customer a zero-fee bank payout that nobody has agreed to.
  // Until the bank fee is documented, the BANK rail refuses before any
  // mutation instead of running on an assumption.
  const feePolicy = destinationType === 'BANK' ? bankPayoutFeePolicy() : GHS_NATIVE_FEE_POLICY;
  if (!feePolicy) {
    const configured = String(process.env.BANK_PAYOUT_FEE_GHS ?? '').trim();
    if (configured !== '' && !/^0*(\.0+)?$/.test(configured)) {
      // §P1-3: a non-zero fee policy is configured but NOT approved, because the
      // reversal path does not refund the fee. Refuse as a policy gap, not as a
      // missing configuration, so nobody "fixes" it by zeroing the number they
      // were told to check.
      throw new NativeGhsWithdrawalError(
        'Bank payouts are not enabled with a non-zero customer fee: the refund policy for that fee has not been approved, so a failed payout could leave you short. Nothing was debited.',
        'BANK_FEE_POLICY_UNAPPROVED'
      );
    }
    throw new NativeGhsWithdrawalError(
      'Bank payouts are not enabled: the bank transfer fee has not been agreed with the provider, so the exact amount the recipient receives cannot be promised. Nothing was debited.',
      'BANK_FEE_POLICY_UNEVIDENCED'
    );
  }
  const feeGhs = new Prisma.Decimal(feePolicy.feeGhs);
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

      // §P1-2 THE QUOTE MUST NAME THIS PAYOUT. The quote's identity carries a
      // digest of the intent it was minted for (rail, exact recipient amount,
      // fee, payee identity). A quote minted for a different rail, payee or
      // amount is refused HERE, before any money moves — and because the
      // refusal throws inside the transaction, the CAS consumption is rolled
      // back and the customer's quote is not burned by an attempt that was
      // never theirs to spend.
      const quoteIntentDigest = payoutIntentDigest({
        rail: destinationType,
        recipientGhs,
        feeGhs,
        destinationIdentity: destinationIdentityOf({
          destinationType,
          destination,
          destinationSnapshot,
          beneficiaryId,
        }),
      });
      const expectedPrefix =
        `${QUOTE_IDENTITY_KIND}:${userId}:${shortfallGhs.toFixed(2).replace('.', '')}:${quoteIntentDigest}:`;
      if (!String(consumed.quoteIdentity || '').startsWith(expectedPrefix)) {
        throw new NativeGhsWithdrawalError(
          'This funding quote was issued for a different payout. Nothing was converted — request a quote for this payout and try again.',
          'NATIVE_GHS_QUOTE_INTENT_MISMATCH',
          {
            quoteId: String(quoteId),
            quoteIntentDigest: String(consumed.quoteIdentity || '').split(':')[3] || null,
            payoutIntentDigest: quoteIntentDigest,
            quotedShortfallGhs: shortfallGhs.toFixed(2),
            requestedRecipientGhs: recipientGhs.toFixed(2),
          }
        );
      }

      // §5.3 RECOMPUTE INSIDE THE AUTHORITATIVE TRANSACTION. The quote is a
      // snapshot of a shortfall that may no longer exist (the customer can
      // receive GHS between preview and confirmation) or may have grown (a
      // payout made in the meantime). Charging the quoted USDC for a stale
      // shortfall either overcharges the customer or funds the payout from
      // money that is not there. Any material change rolls the whole
      // transaction back — the quote is NOT consumed and no funds move.
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { nativeGhsBalance: true },
      });
      const currentNativeGhs = new Prisma.Decimal(current?.nativeGhsBalance ?? 0);
      const requiredNow = recipientGhs.plus(feeGhs);
      const recomputedShortfall = requiredNow.minus(currentNativeGhs).isNegative()
        ? new Prisma.Decimal(0)
        : requiredNow.minus(currentNativeGhs);
      if (!recomputedShortfall.equals(shortfallGhs)) {
        throw new NativeGhsWithdrawalError(
          `Your native GHS balance changed after this quote was issued, so the exact funding split no longer matches. Nothing was converted. Request a fresh quote to continue.`,
          'NATIVE_GHS_QUOTE_INTENT_CHANGED',
          {
            quotedShortfallGhs: shortfallGhs.toFixed(2),
            currentShortfallGhs: recomputedShortfall.toFixed(2),
            availableNativeGhs: currentNativeGhs.toFixed(2),
            requiredGhs: requiredNow.toFixed(2),
          }
        );
      }

      // The quote carries an EXACT 12dp USDC quotient; the USDC liability
      // authority is 8dp (ledger scale). Round ONCE, here, at the debit
      // authority — never re-derive the rate.
      const usdcDebit = new Prisma.Decimal(consumed.usdcAmount)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
      const rate = new Prisma.Decimal(consumed.rateGhsPerUsdc);
      if (!shortfallGhs.equals(shortfallGhs.toDecimalPlaces(2)) || shortfallGhs.lessThanOrEqualTo(0)) {
        throw new NativeGhsWithdrawalError('quote shortfall is not exact pesewas', 'NATIVE_GHS_QUOTE_INVALID');
      }
      // §5 A POSITIVE QUOTIENT CAN ROUND TO ZERO at 8dp. A zero (or negative)
      // debit must never fund a positive GHS shortfall: the customer would
      // receive GHS for no USDC. Refuse BEFORE any mutation or ledger post —
      // this is a typed refusal, not a floor invented out of thin air.
      if (!usdcDebit.isFinite() || usdcDebit.isNegative()) {
        throw new NativeGhsWithdrawalError('quote USDC amount is invalid', 'NATIVE_GHS_QUOTE_INVALID');
      }
      if (usdcDebit.isZero()) {
        throw new NativeGhsWithdrawalError(
          'This funding amount is too small to express in USDC at the quoted rate, so nothing was converted.',
          'NATIVE_GHS_USDC_DEBIT_ROUNDED_TO_ZERO',
          {
            quotedUsdcAmount: String(consumed.usdcAmount),
            roundedUsdcAmount: usdcDebit.toFixed(8),
            shortfallGhs: shortfallGhs.toFixed(2),
            rateGhsPerUsdcExact: new Prisma.Decimal(consumed.rateGhsPerUsdc).toFixed(8),
          }
        );
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
          identity: FUNDING_CONVERSION_PREFIX + String(reference),
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
        // The identity of the posting this evidence describes. Recorded, not
        // inferred later: the reversal has to prove WHICH conversion it inverts.
        conversionIdentity: FUNDING_CONVERSION_PREFIX + String(reference),
        ledgerIdempotencyKey: FUNDING_LEDGER_KEY_PREFIX + String(reference),
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
        rail: destinationType === 'BANK' ? 'BANK' : DISPATCH_RAIL,
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
          feeGhs: feeGhs.toFixed(2),
          feePolicy,
          provider: DISPATCH_PROVIDER,
          rail: destinationType === 'BANK' ? 'BANK' : DISPATCH_RAIL,
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

    // §6 IMMUTABLE DESTINATION SNAPSHOT: the exact bank destination that was
    // ACCEPTED is recorded in the same transaction that debits the customer.
    // The beneficiary row stays editable (nickname, primary, even the account
    // number), and an edited payee must never silently redirect a payout that
    // was already promised to the account shown on the confirmation screen.
    // The fingerprint is an HMAC, never the plaintext account number.
    if (destinationSnapshot) {
      // §P1-4 the key names the RAIL the evidence came from. Calling a MoMo
      // snapshot a "bankDestinationSnapshot" is the same class of lie as
      // claiming an unverified name was verified: a later reader believes the
      // label instead of the payload.
      const snapshotKey = destinationType === 'BANK' ? 'bankDestinationSnapshot' : 'momoDestinationSnapshot';
      await tx.$executeRawUnsafe(
        'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "txHash" = $1',
        reference,
        snapshotKey,
        JSON.stringify(destinationSnapshot)
      );
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
    const outcome = classifyProviderOutcome(err);
    if (REVERSIBLE_OUTCOMES.has(outcome)) {
      // The adapter PROVED no provider payout exists (typed outcome only).
      const reversal = await reverseNativeGhsWithdrawal(prisma, {
        reference,
        reason: `provider_rejected:${outcome}:${err?.code || err?.name || 'DISPATCH_ERROR'}`,
      });
      if (!reversal.reversed) {
        // Reversal could not complete atomically: funds stay held, the row
        // parks. Never report a refund that did not happen.
        await parkUncertainDispatch(prisma, { reference, outcome, error: err, rail: 'MOMO' });
        return { dispatched: false, reason: 'REVERSAL_PARKED', outcome, reversal, failure: err?.message };
      }
      return { dispatched: false, reason: 'PROVIDER_REJECTED', outcome, reversed: true, failure: err?.message };
    }
    // DUPLICATE_REFERENCE, UNKNOWN_OUTCOME and every untyped failure: the
    // provider may hold the payout. Keep funds reserved, keep the reference.
    await parkUncertainDispatch(prisma, { reference, outcome, error: err, rail: 'MOMO' });
    logger.warn({ reference, outcome, err: err?.message }, '[nativeGhsWithdrawal] dispatch outcome uncertain — funds held, no refund');
    return { dispatched: false, reason: 'PROVIDER_OUTCOME_UNCERTAIN', outcome, refunded: false, failure: err?.message };
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


// ── Provider outcome taxonomy (issue #389 P0) ───────────────────────────────
// An UNCERTAIN payout must never be refunded. Only two outcomes prove that no
// provider payout exists; everything else (timeout, reset, 5xx, malformed 2xx,
// duplicate reference, untyped exception) keeps the customer's funds held and
// parks the withdrawal for status-based reconciliation.
const PROVIDER_OUTCOME = Object.freeze({
  NOT_DISPATCHED: 'NOT_DISPATCHED',
  DEFINITIVE_REJECTION: 'DEFINITIVE_REJECTION',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  UNKNOWN_OUTCOME: 'UNKNOWN_OUTCOME',
});

// Outcomes that prove the provider cannot have initiated a payout.
const REVERSIBLE_OUTCOMES = new Set([
  PROVIDER_OUTCOME.NOT_DISPATCHED,
  PROVIDER_OUTCOME.DEFINITIVE_REJECTION,
]);

/**
 * Classify a dispatch failure from the adapter's TYPED field only. Message
 * substrings, HTTP status guesses and exception names are deliberately not
 * used: an unrecognised failure is uncertainty, not proof of non-delivery.
 */
function classifyProviderOutcome(error) {
  const raw = error?.providerOutcome ?? error?.outcome ?? null;
  const outcome = typeof raw === 'string' ? raw.trim().toUpperCase() : null;
  if (outcome && Object.prototype.hasOwnProperty.call(PROVIDER_OUTCOME, outcome)) return outcome;
  return PROVIDER_OUTCOME.UNKNOWN_OUTCOME;
}

/**
 * Durable record that a dispatch outcome is uncertain: the funds stay reserved,
 * the ORIGINAL reference is retained, and status lookup against that reference
 * is the only permitted resolution. Never a retry, failover or new reference.
 */
async function parkUncertainDispatch(prisma, { reference, outcome, error, rail = 'MOMO' }) {
  const row = await prisma.transactionHistory.findUnique({
    where: { txHash: reference },
    select: { id: true },
  });
  if (!row) return { parked: false, reason: 'TRANSACTION_NOT_FOUND' };
  await prisma.$executeRawUnsafe(
    'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "id" = $1',
    row.id,
    'dispatchException',
    JSON.stringify({
      code: outcome === PROVIDER_OUTCOME.DUPLICATE_REFERENCE
        ? 'PROVIDER_DUPLICATE_REFERENCE'
        : 'PROVIDER_OUTCOME_UNCERTAIN',
      outcome,
      rail,
      reference,
      errorCode: error?.code ?? error?.name ?? null,
      at: new Date().toISOString(),
      resolution: 'STATUS_LOOKUP_ORIGINAL_REFERENCE',
      refunded: false,
    })
  );
  return { parked: true, outcome };
}


// ── BANK dispatch observation decision (issue #389 P0-1) ────────────────────
// A resolved promise from initiateBankTransfer is NOT a provider acceptance.
// Agent B returns status:'UNRESOLVED' for timeouts, duplicate references and
// every malformed/inconclusive answer; it returns PENDING/SUCCESSFUL/FAILED
// only when the provider answered something it could parse. The decision below
// is therefore about the OBSERVATION, not about whether the HTTP call returned.
const BANK_PROVIDER_CANONICAL = 'MOOLRE_DISBURSEMENT';
const BANK_PAYOUT_FAILOVER_TAG = 'moolre';
const BANK_RAIL = 'BANK';
const BANK_OBSERVATION_STATUSES = new Set(['PENDING', 'SUCCESSFUL', 'FAILED', 'UNRESOLVED']);
const BANK_TERMINAL_OBSERVATIONS = new Set(['SUCCESSFUL', 'FAILED']);

/**
 * The individual provider fee fields, exactly as reported. Never summed, never
 * re-labelled as a customer fee, never substituted for a missing one: summing
 * them would invent a fee-payer, which is a policy decision nobody has made.
 */
function _providerFeeFacts(observation) {
  if (!observation || typeof observation !== 'object') return null;
  const facts = {};
  for (const [key, value] of Object.entries(observation)) {
    if (!/fee/i.test(key) || value === undefined) continue;
    facts[key] = value;
  }
  return Object.keys(facts).length ? facts : null;
}

function _sameExactGhs(a, b) {
  if (a == null || b == null) return false;
  try {
    return new Prisma.Decimal(String(a)).equals(new Prisma.Decimal(String(b)));
  } catch (err) {
    return false;
  }
}

/**
 * Decide what a returned bank-dispatch observation authorises.
 *
 * Returns { decision, reason, providerRef, externalId, amountGhsExact,
 *           observation } where decision is one of:
 *   ACCEPTED   — the provider holds the payout and reported it as in flight.
 *                Only this decision may move the reservation to IN_TRANSIT.
 *   UNRESOLVED — the provider may or may not hold the payout. Funds held, the
 *                ORIGINAL reference retained, reconciliation against that same
 *                reference. Never reported as a successful dispatch.
 *   PARKED     — contradictory or incomplete identity/reference/amount, or a
 *                terminal status returned at initiation. Nothing is settled or
 *                refunded here; the observation is retained and the established
 *                reconciliation authority decides after exact evidence binding.
 *
 * The caller's requested amount is NEVER substituted for a missing provider
 * amount, and a different echoed reference is NEVER adopted.
 */
function evaluateBankDispatchObservation(outbound, { reference, amountGhsExact }) {
  if (!outbound || typeof outbound !== 'object') {
    return { decision: 'PARKED', reason: 'DISPATCH_OBSERVATION_MISSING' };
  }
  const status = typeof outbound.status === 'string' ? outbound.status.toUpperCase() : null;
  if (!status || !BANK_OBSERVATION_STATUSES.has(status)) {
    return { decision: 'PARKED', reason: 'DISPATCH_STATUS_UNRECOGNISED', observation: outbound, observedStatus: status };
  }

  // Provider identity. A named identity that is not the bank provider, or no
  // identity at all, is not owner evidence — park rather than assume.
  const observedProvider = outbound.provider ? String(outbound.provider).toUpperCase() : null;
  if (!observedProvider) {
    return { decision: 'PARKED', reason: 'DISPATCH_PROVIDER_IDENTITY_MISSING', observation: outbound, observedStatus: status };
  }
  if (observedProvider !== BANK_PROVIDER_CANONICAL) {
    return {
      decision: 'PARKED',
      reason: 'DISPATCH_PROVIDER_IDENTITY_CONTRADICTION',
      observation: outbound,
      observedStatus: status,
      observedProvider,
    };
  }

  // Rail identity. The bank adapter reports rail:'BANK'; an UNRESOLVED answer
  // still carries it, so a contradiction here is a real contradiction.
  if (outbound.rail != null && String(outbound.rail).toUpperCase() !== BANK_RAIL) {
    return {
      decision: 'PARKED',
      reason: 'DISPATCH_RAIL_CONTRADICTION',
      observation: outbound,
      observedStatus: status,
      observedRail: String(outbound.rail),
    };
  }

  // `referenceId` is the adapter's LOCAL copy of what we asked for — it is not
  // provider evidence and can never establish acceptance on its own. A local
  // copy that contradicts us is still a contradiction, so it parks.
  if (outbound.referenceId != null && String(outbound.referenceId) !== String(reference)) {
    return {
      decision: 'PARKED',
      reason: 'DISPATCH_REFERENCE_MISMATCH',
      observation: outbound,
      observedStatus: status,
      observedReference: String(outbound.referenceId),
    };
  }

  if (status === 'UNRESOLVED') {
    return {
      decision: 'UNRESOLVED',
      reason: outbound.reason ? String(outbound.reason) : 'PROVIDER_OUTCOME_UNRESOLVED',
      observation: outbound,
      observedStatus: status,
      providerCode: outbound.providerCode ?? null,
    };
  }

  // The provider's OWN echo (Moolre's `externalref`) must be present and equal
  // to our Azaman reference before any non-UNRESOLVED observation can be
  // treated as evidence of acceptance. A locally copied referenceId is not an
  // echo: without the echoed externalref we cannot tell "the provider accepted
  // our payout" from "our adapter echoed our own request back".
  const providerEcho = outbound.externalId == null ? null : String(outbound.externalId).trim();
  if (!providerEcho) {
    return {
      decision: 'PARKED',
      reason: 'PROVIDER_ECHO_MISSING',
      observation: outbound,
      observedStatus: status,
      providerFeeFacts: _providerFeeFacts(outbound),
    };
  }
  if (providerEcho !== String(reference)) {
    return {
      decision: 'PARKED',
      reason: 'PROVIDER_ECHO_MISMATCH',
      observation: outbound,
      observedStatus: status,
      observedExternalId: providerEcho,
      providerFeeFacts: _providerFeeFacts(outbound),
    };
  }

  // Every non-UNRESOLVED observation must carry the exact payout amount. A
  // missing amount is not "the amount we asked for" — it is missing evidence.
  if (outbound.amountGhsExact == null || !_sameExactGhs(outbound.amountGhsExact, amountGhsExact)) {
    return {
      decision: 'PARKED',
      reason: outbound.amountGhsExact == null
        ? 'DISPATCH_AMOUNT_MISSING'
        : 'DISPATCH_AMOUNT_MISMATCH',
      observation: outbound,
      observedStatus: status,
      observedAmountGhs: outbound.amountGhsExact ?? null,
      requestedAmountGhs: amountGhsExact,
    };
  }

  if (BANK_TERMINAL_OBSERVATIONS.has(status)) {
    // A terminal answer at initiation is real information but NOT a settlement
    // authorisation: the canonical evidence binder plus the settlement
    // authority own that decision, after the observation is durably bound.
    return {
      decision: 'PARKED',
      reason: 'DISPATCH_TERMINAL_AT_INITIATION',
      observation: outbound,
      observedStatus: status,
      providerRef: outbound.providerRef ?? null,
      externalId: outbound.externalId ?? null,
      amountGhsExact: outbound.amountGhsExact,
    };
  }

  return {
    decision: 'ACCEPTED',
    reason: 'PROVIDER_ACCEPTED',
    observation: outbound,
    observedStatus: status,
    providerRef: outbound.providerRef ?? null,
    externalId: providerEcho,
    providerEchoAtInitiation: providerEcho,
    amountGhsExact: outbound.amountGhsExact,
    providerStatusRaw: outbound.providerStatusRaw ?? null,
    providerFeeFacts: _providerFeeFacts(outbound),
  };
}

/**
 * Durable operator evidence for a bank dispatch that did NOT produce an
 * accepted payout. These reasons are deliberately NOT in the admin
 * provably-not-dispatched set: the provider may hold the money, so the only
 * safe operator action is escalation/reconciliation on the original reference.
 */
async function recordBankDispatchPark(prisma, {
  reference, rowId, code, decision, observation, bank, amountGhsExact, extra = {},
}) {
  await prisma.$executeRawUnsafe(
    'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "id" = $1',
    rowId,
    'dispatchException',
    JSON.stringify({
      code,
      decision,
      rail: BANK_RAIL,
      reference,
      provider: BANK_PROVIDER_CANONICAL,
      observedStatus: observation?.status ?? null,
      providerRef: observation?.providerRef ?? null,
      externalId: observation?.externalId ?? null,
      observedAmountGhsExact: observation?.amountGhsExact ?? null,
      requestedAmountGhsExact: amountGhsExact,
      providerStatusRaw: observation?.providerStatusRaw ?? null,
      // individual fee fields, exactly as reported: never summed into a fee
      providerFeeFacts: _providerFeeFacts(observation),
      bankCode: bank?.bankCode ?? null,
      at: new Date().toISOString(),
      resolution: 'RECONCILE_ORIGINAL_REFERENCE',
      providerDispatched: false,
      refunded: false,
      ...extra,
    })
  );
  const mirror = await prisma.withdrawal.findFirst({
    where: { transactionHistoryId: rowId },
    select: { id: true },
  });
  if (mirror) {
    await recordReconciliationException(prisma, {
      entityType: 'WITHDRAWAL',
      entityId: String(mirror.id),
      reference,
      reason: code,
      details: {
        phase: 'POST_DISPATCH_UNRESOLVED',
        decision,
        settlementCurrency: SETTLEMENT_CURRENCY,
        rail: BANK_RAIL,
        provider: BANK_PROVIDER_CANONICAL,
        observedStatus: observation?.status ?? null,
        providerRef: observation?.providerRef ?? null,
        externalId: observation?.externalId ?? null,
        observedAmountGhsExact: observation?.amountGhsExact ?? null,
        requestedAmountGhsExact: amountGhsExact,
        bankCode: bank?.bankCode ?? null,
        ...extra,
      },
    });
  }
}

/**
 * BANK payout dispatch through the INJECTED provider port (Agent B owns the
 * adapter; this module owns the state machine). Same single-winner claim,
 * same reversal authority, same evidence — only the provider call differs.
 */

/**
 * §ADDENDUM: THE DESTINATION MUST BE PROVIDER-VALIDATED IMMEDIATELY BEFORE THE
 * TRANSFER POST.
 *
 * The route validates the payee at quote time and again at acceptance, and the
 * pre-dispatch block re-reads the STORED beneficiary and compares its
 * fingerprint. That comparison is a local integrity check on our own row — it
 * proves the account we are about to pay is the account we recorded, NOT that
 * the bank currently holds it. There is no owner-approved validation TTL, so
 * no freshness window is invented here: the only safe rule is a fresh enquiry
 * against the provider for the exact stored number and bank code.
 *
 * If the adapter cannot perform that enquiry (no capability, no method, a
 * throwing capability or a malformed answer) the BANK rail stays UNAVAILABLE:
 * we refuse rather than dispatch on the strength of the earlier timestamp.
 */
function bankRevalidationCapability(port) {
  // AGENT B'S PUBLISHED ADAPTER CONTRACT (#391 @ 31a81cf):
  //   capabilities().canValidateBankAccount === true
  //   validateBankAccount({ accountNumber, bankCode })
  // Anything else — a missing method, a missing capability, a throwing
  // capabilities() — means this rail cannot PROVE the destination is still
  // valid, so it must not dispatch.
  if (!port || typeof port.capabilities !== 'function' || typeof port.validateBankAccount !== 'function') {
    return false;
  }
  try {
    return port.capabilities()?.canValidateBankAccount === true;
  } catch (_) {
    return false;
  }
}

const EXPECTED_VALIDATION_PROVIDER = 'MOOLRE';

/**
 * One provider enquiry, bound to the SERVER-STORED destination.
 *
 * The stored beneficiary fingerprint and bank code establish WHICH account was
 * supplied to the provider. Moolre's documented validation response returns the
 * holder NAME; it does not echo the account number, so no account-number echo is
 * invented or expected here — the binding is the request we made.
 *
 * Returns { decision, accountName, providerValidatedAt, provider, error }:
 *   CONFIRMED     — provider answered valid:true for this exact request.
 *   NEGATIVE      — the adapter PROVED the account does not exist.
 *   NAME_MISMATCH — a different holder name than the accepted evidence.
 *   INCONCLUSIVE  — unavailable, timeout, malformed, unknown provider.
 */
async function enquiryBankDestination(port, { accountNumber, bankCode, expectedAccountName }) {
  if (typeof port?.validateBankAccount !== 'function') {
    return { decision: 'INCONCLUSIVE', error: { code: 'VALIDATION_METHOD_UNAVAILABLE' } };
  }
  let raw;
  try {
    raw = await port.validateBankAccount({ accountNumber, bankCode });
  } catch (err) {
    // A DOCUMENTED account-not-found is a definitive pre-dispatch negative only
    // when the adapter proves it refused a real enquiry: typed outcome, its own
    // code, and the "nothing was dispatched" evidence. Everything else — a
    // timeout, AVD05 provider-unavailable, an untyped throw — stays inconclusive.
    // The real #391 adapter (@31a81cf) proves it refused a real enquiry with
    // the typed triple below. It passes `refusalDocumented` into its error
    // constructor but never assigns it to the instance, so requiring it here
    // would make every genuine AVD02 answer look inconclusive — a strictly
    // worse outcome (funds held forever) than the documented refusal it is.
    const providerFamily = String(err?.provider || '');
    const definitive =
      err?.outcome === 'DEFINITIVE_REJECTION'
      && err?.code === 'ACCOUNT_NOT_FOUND'
      && err?.dispatchProven === true
      && (providerFamily === '' || /^MOOLRE/i.test(providerFamily));
    if (definitive) {
      return {
        decision: 'NEGATIVE',
        error: {
          code: 'PROVIDER_ACCOUNT_NOT_FOUND',
          provider: err?.provider ?? null,
          outcome: err?.outcome ?? null,
          dispatchProven: err?.dispatchProven === true,
          providerCode: err?.providerCode ?? null,
        },
        providerStatusRaw: 'ACCOUNT_NOT_FOUND',
      };
    }
    return {
      decision: 'INCONCLUSIVE',
      error: {
        code: err?.code || err?.name || 'VALIDATION_FAILED',
        provider: err?.provider ?? null,
        outcome: err?.outcome ?? null,
        message: String(err?.message || '').slice(0, 200),
      },
    };
  }
  if (!raw || typeof raw !== 'object') {
    return { decision: 'INCONCLUSIVE', error: { code: 'VALIDATION_RESPONSE_MALFORMED' } };
  }
  if (raw.valid !== true) {
    // valid:false without a documented refusal is not proof of anything.
    return {
      decision: 'INCONCLUSIVE',
      error: { code: 'VALIDATION_NOT_AFFIRMATIVE', valid: raw.valid ?? null },
      providerStatusRaw: raw.valid === false ? 'NOT_VALID' : null,
    };
  }
  const accountName = raw.accountName == null ? '' : String(raw.accountName).trim();
  if (!accountName) {
    return { decision: 'INCONCLUSIVE', error: { code: 'VALIDATION_NAME_MISSING' } };
  }
  // The configured provider only ever confirmed THIS bank: a response naming a
  // different bank code is not evidence about the destination being paid.
  const echoedBank = raw.bankCode == null ? null : String(raw.bankCode).trim();
  if (!echoedBank || echoedBank !== String(bankCode).trim()) {
    return {
      decision: 'NEGATIVE',
      error: { code: 'PROVIDER_BANK_CODE_MISMATCH' },
      echoedBankCode: echoedBank,
    };
  }
  const provider = raw.provider == null ? null : String(raw.provider).trim().toUpperCase();
  if (provider !== EXPECTED_VALIDATION_PROVIDER) {
    return { decision: 'INCONCLUSIVE', error: { code: 'VALIDATION_PROVIDER_UNEXPECTED', provider } };
  }
  const validatedAt = raw.validatedAt == null ? null : new Date(raw.validatedAt);
  if (!validatedAt || Number.isNaN(validatedAt.getTime())) {
    return { decision: 'INCONCLUSIVE', error: { code: 'VALIDATION_TIMESTAMP_INVALID' } };
  }
  if (expectedAccountName && accountName.toUpperCase() !== String(expectedAccountName).trim().toUpperCase()) {
    return {
      decision: 'NAME_MISMATCH',
      accountName,
      providerValidatedAt: validatedAt.toISOString(),
      provider,
      error: { code: 'PROVIDER_ACCOUNT_NAME_CHANGED', acceptedAccountName: expectedAccountName },
    };
  }
  return {
    decision: 'CONFIRMED',
    accountName,
    providerValidatedAt: validatedAt.toISOString(),
    provider,
    providerStatusRaw: 'VALID',
  };
}

/**
 * Durable pre-dispatch refusal evidence: a park that names itself as
 * PRE_DISPATCH so no operator is sent to poll a provider that was never called.
 */
async function recordPreDispatchRefusal(prisma, { reference, rowId, code, disposition, details }) {
  try {
    await prisma.$executeRawUnsafe(
      'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "id" = $1',
      rowId,
      'bankPreDispatchRefusal',
      JSON.stringify({ code, disposition, at: new Date().toISOString(), ...details })
    );
    const mirror = await prisma.withdrawal.findFirst({
      where: { transactionHistoryId: rowId },
      select: { id: true },
    });
    if (mirror) {
      await recordReconciliationException(prisma, {
        entityType: 'WITHDRAWAL',
        entityId: String(mirror.id),
        reference,
        reason: code,
        details: { disposition, ...details },
      });
    }
  } catch (err) {
    logger.error({ reference, err: err?.message }, '[nativeGhsWithdrawal] could not record pre-dispatch refusal');
  }
}

async function dispatchNaturalGhsBankWithdrawal(prisma, {
  reference,
  amountGhsExact,
  bank,
  port,
  payerMessage = null,
  payeeNote = null,
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
    select: { id: true, type: true, settlementCurrency: true, userId: true },
  });
  if (!row || row.type !== 'WITHDRAWAL_FIAT' || row.settlementCurrency !== SETTLEMENT_CURRENCY) {
    return { dispatched: false, reason: 'NOT_A_NATIVE_GHS_WITHDRAWAL' };
  }
  // The canonical TransactionHistory status is the TransactionStatus ENUM
  // (PENDING until a terminal outcome). The DISPATCH CLAIM lives on the
  // Withdrawal mirror's String status — exactly like the fiat payout path:
  // PENDING -> DISPATCHING is the single-winner dispatch authority, and the
  // worker (-> PROCESSING) and admin (-> REJECTED) compete on the same row.
  // §6 REVALIDATION BEFORE DISPATCH. Re-read the payer's saved beneficiary and
  // prove it still resolves to the account captured at acceptance. A changed
  // or deleted payee parks the payout for review — it is never sent to a
  // destination the customer did not confirm.
  const snapshotRow = await prisma.transactionHistory.findUnique({
    where: { txHash: reference },
    select: { metadata: true },
  });
  const snapshot = snapshotRow?.metadata?.bankDestinationSnapshot || null;
  if (snapshot) {
    let current = null;
    let revalidationError = null;
    try {
      current = await savedBankBeneficiaryService.revealForPayout(prisma, row.userId, snapshot.beneficiaryId);
    } catch (err) {
      // Benign for the comparison (current stays null => parked for review),
      // but the REASON is recorded: an operator must be able to tell a deleted
      // payee from an unreadable ciphertext.
      current = null;
      revalidationError = { code: err?.code || err?.name || 'REVEAL_FAILED', message: String(err?.message || '').slice(0, 200) };
    }
    const currentFingerprint = current ? savedBankBeneficiaryService.fingerprint(current.accountNumber) : null;
    if (!current || currentFingerprint !== snapshot.fingerprint || current.bankCode !== snapshot.bankCode) {
      // NOT parkUncertainDispatch: that helper records
      // STATUS_LOOKUP_ORIGINAL_REFERENCE, which would send an operator to poll
      // a provider that was never called. Nobody can look this up — the payee
      // itself has to be re-confirmed by the customer, so the row must leave
      // the retry set and land in the human review queue instead.
      await prisma.withdrawal.updateMany({
        where: { transactionHistoryId: row.id, status: 'PENDING' },
        data: { status: 'NEEDS_MANUAL_REVIEW' },
      });
      await prisma.$executeRawUnsafe(
        'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "txHash" = $1',
        reference,
        'bankDestinationRevalidation',
        JSON.stringify({
          code: 'BANK_DESTINATION_CHANGED',
          at: new Date().toISOString(),
          snapshotFingerprint: snapshot.fingerprint,
          currentFingerprint,
          revalidationError,
          snapshotBankCode: snapshot.bankCode,
          currentBankCode: current?.bankCode ?? null,
          refunded: false,
          resolution: 'PAYEE_MUST_BE_CONFIRMED',
          nextStep: 'Customer re-confirms the bank destination; RESUME re-runs every gate.',
        })
      );
      // Durable OPERATOR evidence, not just metadata. The admin review queue
      // derives an operator's allowed actions from ReconciliationException
      // rows; a park recorded only in metadata shows up as a row with no
      // reason and no option but ESCALATE — which for this park would send an
      // operator to poll a provider that was provably never called. The phase
      // is PRE_DISPATCH because this check runs BEFORE the dispatch claim.
      const mirror = await prisma.withdrawal.findFirst({
        where: { transactionHistoryId: row.id },
        select: { id: true },
      });
      if (mirror) {
        await recordReconciliationException(prisma, {
          entityType: 'WITHDRAWAL',
          entityId: String(mirror.id),
          reference,
          reason: 'BANK_DESTINATION_CHANGED',
          details: {
            phase: 'PRE_DISPATCH',
            settlementCurrency: SETTLEMENT_CURRENCY,
            resolution: 'PAYEE_MUST_BE_CONFIRMED',
            snapshotFingerprint: snapshot.fingerprint,
            currentFingerprint,
            snapshotBankCode: snapshot.bankCode,
            currentBankCode: current?.bankCode ?? null,
            revalidationError,
            providerDispatched: false,
            refunded: false,
          },
        });
      }
      return { dispatched: false, reason: 'BANK_DESTINATION_CHANGED' };
    }
  }
  // ── §ADDENDUM PRE-DISPATCH PROVIDER REVALIDATION ─────────────────────────
  //
  // Every check above is local: it proves the payee ROW still resolves to the
  // accepted fingerprint. None of it proves the BANK still holds that account
  // right now, and there is no approved validation TTL to lean on. So the
  // exact stored account number and bank code are put to the provider one last
  // time, immediately before the transfer post.
  //
  // A rail that cannot answer that question does not dispatch: "validated at
  // quote time" is a timestamp, not evidence.
  if (!bankRevalidationCapability(port)) {
    await recordPreDispatchRefusal(prisma, {
      reference,
      rowId: row.id,
      code: 'BANK_REVALIDATION_CAPABILITY_UNAVAILABLE',
      disposition: 'HELD_FOR_REVIEW',
      details: {
        phase: 'PRE_DISPATCH',
        reason: 'The bank rail cannot revalidate the stored account immediately before dispatch, so it is not available.',
        providerDispatched: false,
        refunded: false,
        resolution: 'RAIL_UNAVAILABLE',
      },
    });
    logger.warn(
      { reference, rail: BANK_RAIL },
      '[nativeGhsWithdrawal] BANK rail has no pre-dispatch account-enquiry capability — refusing to dispatch'
    );
    return {
      dispatched: false,
      reason: 'BANK_REVALIDATION_CAPABILITY_UNAVAILABLE',
      disposition: 'HELD_FOR_REVIEW',
      refunded: false,
    };
  }

  const enquiry = await enquiryBankDestination(port, {
    accountNumber: bank.accountNumber,
    bankCode: bank.bankCode,
    expectedAccountName: bank.accountName || bank.verifiedName || null,
  });
  // providerValidatedAt is the adapter's ISO string; normalise it to a Date once.
  const enquiryAt = enquiry.providerValidatedAt ? new Date(enquiry.providerValidatedAt) : new Date();
  if (enquiry.decision !== 'CONFIRMED') {
    // NOT a provider payout outcome: nothing was sent. A DEFINITIVE negative
    // (no such account / different bank) is safe to refund through the same
    // canonical reversal the MoMo leg uses, because no payout can exist. An
    // INCONCLUSIVE or NAME_MISMATCH answer is HELD: we cannot prove the payee
    // is wrong and we must never pay it, so a human reconciles.
    const refundable = enquiry.decision === 'NEGATIVE';
    const code = enquiry.decision === 'NEGATIVE'
      ? (enquiry.error?.code || 'PROVIDER_ACCOUNT_NOT_FOUND')
      : (enquiry.decision === 'NAME_MISMATCH'
        ? 'BANK_PROVIDER_ACCOUNT_NAME_MISMATCH'
        : 'BANK_PROVIDER_REVALIDATION_INCONCLUSIVE');
    let reversal = null;
    if (refundable) {
      reversal = await reverseNativeGhsWithdrawal(prisma, {
        reference,
        reason: `pre_dispatch_validation_negative:${code}`,
        allowedMirrorStatuses: ['PENDING'],
      });
    }
    await recordPreDispatchRefusal(prisma, {
      reference,
      rowId: row.id,
      code,
      disposition: refundable && reversal?.reversed ? 'REFUNDED_PRE_DISPATCH' : 'HELD_FOR_REVIEW',
      details: {
        phase: 'PRE_DISPATCH',
        decision: enquiry.decision,
        errorCode: enquiry.error?.code ?? null,
        echoedAccountNumber: enquiry.echoedAccountNumber ?? null,
        echoedBankCode: enquiry.echoedBankCode ?? null,
        providerStatusRaw: enquiry.providerStatusRaw ?? null,
        providerValidatedAt: enquiryAt.toISOString(),
        snapshotFingerprint: snapshot?.fingerprint ?? null,
        refundable,
        refunded: reversal?.reversed === true,
        providerDispatched: false,
        resolution: refundable && reversal?.reversed ? 'REFUNDED' : 'RECONCILE_MANUALLY',
      },
    });
    logger.warn(
      { reference, decision: enquiry.decision, code },
      '[nativeGhsWithdrawal] pre-dispatch account revalidation refused the BANK payout — no transfer was posted'
    );
    return {
      dispatched: false,
      reason: code,
      decision: enquiry.decision,
      disposition: refundable && reversal?.reversed ? 'REFUNDED_PRE_DISPATCH' : 'HELD_FOR_REVIEW',
      refunded: reversal?.reversed === true,
      providerDispatched: false,
    };
  }
  const providerValidatedAt = enquiryAt.toISOString();
  const providerValidatedName = enquiry.accountName;

  const claim = await prisma.withdrawal.updateMany({
    where: { transactionHistoryId: row.id, status: 'PENDING', payoutMethod: 'BANK' },
    data: { status: 'DISPATCHING' },
  });
  if (claim.count !== 1) return { dispatched: false, reason: 'DISPATCH_CLAIM_LOST' };

  let outbound;
  try {
    // EXACT provider contract (Agent B, services/moolreBankPayoutService.js).
    // The GHS amount is passed as the exact 2dp pesewa string — never a JS
    // float — and the external reference is the ORIGINAL Azaman reference so
    // the provider's idempotency key matches the one we can reconcile against.
    outbound = await port.initiateBankTransfer({
      referenceId: reference,
      amountGhsExact: amount.toFixed(2),
      recipientAccountNumber: bank.accountNumber,
      bankCode: bank.bankCode,
      payerMessage: payerMessage || `Azaman payout ${reference}`,
      payeeNote: payeeNote || `Withdrawal ${reference}`,
    });
  } catch (err) {
    const outcome = classifyProviderOutcome(err);
    if (REVERSIBLE_OUTCOMES.has(outcome)) {
      const reversal = await reverseNativeGhsWithdrawal(prisma, {
        reference,
        reason: `provider_rejected:${outcome}:${err?.code || err?.name || 'DISPATCH_ERROR'}`,
      });
      if (!reversal.reversed) {
        await parkUncertainDispatch(prisma, { reference, outcome, error: err, rail: 'BANK' });
        return { dispatched: false, reason: 'REVERSAL_PARKED', outcome, reversal, error: err.message };
      }
      return { dispatched: false, reason: 'PROVIDER_REJECTED', outcome, reversal, error: err.message };
    }
    await parkUncertainDispatch(prisma, { reference, outcome, error: err, rail: 'BANK' });
    logger.warn({ reference, outcome, err: err?.message }, '[nativeGhsWithdrawal] BANK dispatch outcome uncertain — funds held, no refund');
    return { dispatched: false, reason: 'PROVIDER_OUTCOME_UNCERTAIN', outcome, refunded: false, error: err.message };
  }
  // ── P0-1: the adapter's ANSWER decides, not the fact that it returned ────
  const verdict = evaluateBankDispatchObservation(outbound, {
    reference,
    amountGhsExact: amount.toFixed(2),
  });

  if (verdict.decision !== 'ACCEPTED') {
    const code = verdict.decision === 'UNRESOLVED'
      ? 'PROVIDER_DISPATCH_UNRESOLVED'
      : (verdict.reason === 'DISPATCH_TERMINAL_AT_INITIATION'
        ? 'PROVIDER_TERMINAL_AT_INITIATION'
        : 'DISPATCH_OBSERVATION_CONTRADICTION');
    await recordBankDispatchPark(prisma, {
      reference,
      rowId: row.id,
      code,
      decision: verdict.decision,
      observation: verdict.observation || null,
      bank,
      amountGhsExact: amount.toFixed(2),
      extra: { reason: verdict.reason, providerCode: verdict.providerCode ?? null },
    });
    // The reservation deliberately STAYS reserved: the provider may hold the
    // payout. Nothing here settles, refunds or claims an acceptance.
    logger.warn(
      { reference, decision: verdict.decision, reason: verdict.reason },
      '[nativeGhsWithdrawal] BANK dispatch not accepted by the provider answer — funds held, original reference retained'
    );
    return {
      dispatched: false,
      reason: code,
      decision: verdict.decision,
      detail: verdict.reason,
      providerRef: verdict.providerRef || null,
      refunded: false,
    };
  }

  const providerRef = verdict.providerRef || verdict.externalId || null;

  // Durable dispatch observation FIRST (owner recovery reads it), then the
  // canonical ownership write. Both use the repository's existing authorities.
  try {
    await fiatLiquidity.recordProviderEvent(prisma, {
      provider: BANK_PROVIDER_CANONICAL,
      rail: BANK_RAIL,
      direction: 'OUTBOUND',
      status: 'PENDING',
      providerRef,
      amountGhs: amount.toFixed(2),
      dedupKey: `event:payout-dispatch:${BANK_PROVIDER_CANONICAL}:${reference}`,
      relatedReference: reference,
      raw: {
        source: 'bank_dispatch_initiation',
        externalId: verdict.externalId ?? null,
        providerStatusRaw: outbound?.providerStatusRaw ?? null,
        bankCode: bank?.bankCode ?? null,
      },
    });
  } catch (err) {
    logger.error({ reference, err: err.message }, '[nativeGhsWithdrawal] BANK dispatch observation could not be persisted');
  }

  try {
    await persistPayoutOwnership(prisma, {
      reference,
      failoverTag: BANK_PAYOUT_FAILOVER_TAG,
      intendedProvider: BANK_PROVIDER_CANONICAL,
      providerRef,
    });
  } catch (err) {
    // The payout is already at the provider. Ownership bookkeeping is
    // repairable from the dispatch observation above — never auto-refund.
    logger.error({ reference, err: err.message }, '[nativeGhsWithdrawal] BANK payout ownership write failed after dispatch');
    try {
      const mirror = await prisma.withdrawal.findFirst({
        where: { transactionHistoryId: row.id },
        select: { id: true },
      });
      if (mirror) {
        await recordReconciliationException(prisma, {
          entityType: 'WITHDRAWAL',
          entityId: String(mirror.id),
          reference,
          reason: 'POST_DISPATCH_OWNERSHIP_WRITE_FAILED',
          details: {
            phase: 'POST_DISPATCH',
            provider: BANK_PROVIDER_CANONICAL,
            rail: BANK_RAIL,
            providerRef,
            error: String(err.message || '').slice(0, 200),
          },
        });
      }
    } catch (exceptionError) {
      logger.error({ reference, err: exceptionError.message }, '[nativeGhsWithdrawal] could not record BANK ownership failure');
    }
  }

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
        rail: BANK_RAIL,
        provider: BANK_PROVIDER_CANONICAL,
        providerRef,
        externalId: verdict.externalId ?? null,
        providerEchoAtInitiation: verdict.providerEchoAtInitiation ?? null,
        observedStatus: verdict.observedStatus,
        providerStatusRaw: verdict.providerStatusRaw ?? null,
        amountGhsExact: verdict.amountGhsExact,
        // §ADDENDUM: the provider's OWN validation moment, bound to the SAME
        // immutable destination the payout is bound to. A later reader can tell
        // which account+bank+name the provider confirmed for THIS dispatch.
        providerValidatedAt,
        providerValidatedAccountName: providerValidatedName,
        providerValidatedAccountFingerprint: snapshot?.fingerprint ?? null,
        providerValidatedBankCode: snapshot?.bankCode ?? bank.bankCode,
        providerFeeFacts: verdict.providerFeeFacts ?? null,
        idempotency: 'canonical-reference',
      },
    })
  );
  try {
    await prisma.$transaction(async (tx) => {
      await fiatLiquidity.markReservationInTransit(tx, { reference, providerRef });
    });
  } catch (err) {
    logger.error({ reference, err: err.message }, '[nativeGhsWithdrawal] BANK IN_TRANSIT transition failed after dispatch');
  }
  return { dispatched: true, providerRef, rail: BANK_RAIL };
}

/**
 * ONCE-ONLY reversal for a payout that provably never left (no accepted
 * provider bytes). Mirrors the collections-leg marker discipline: a raw jsonb
 * CAS stamps the canonical row before any money moves, so a replay or a
 * concurrent authority can never reverse twice.
 */
/**
 * Which mirror states a reversal may claim.
 *
 * The DEFAULT set is what the payout pipeline itself can still own: a row that
 * is queued or dispatched but not settled. Admin/review states are added by the
 * CALLER (see `allowedMirrorStatuses`), never by widening this set, because a
 * reversal has to stay comparable across every rail.
 *
 * The terminal set is a hard denylist: a payout recorded as paid is never
 * reversible through this path, whatever the caller asks for. Only the
 * reconciliation authority, holding provider evidence, may touch those.
 */
const REVERSIBLE_MIRROR_STATES = Object.freeze(['PENDING', 'DISPATCHING']);
const NON_REVERSIBLE_TERMINAL_STATES = Object.freeze(['COMPLETED', 'PAID_OUT', 'SUCCESS', 'SETTLED']);

function _exactDecimalOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const d = new Prisma.Decimal(String(value));
    return d.isFinite() ? d : null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the recorded funding evidence BEFORE reversing a penny of it.
 *
 * The metadata is EVIDENCE, not a trusted instruction: a missing, malformed,
 * non-positive or self-contradictory funding record must refuse the whole
 * reversal (and leave durable reconciliation evidence behind) rather than
 * inventing an amount. Every value used below is the recorded one — never a
 * recomputation from today's rate configuration or market price.
 */
function readFundingReversalEvidence(funding, { refundGhs }) {
  const fail = (why, details = {}) => {
    throw new NativeGhsWithdrawalError(
      `the recorded shortfall funding evidence cannot be reversed (${why})`,
      'NATIVE_GHS_FUNDING_EVIDENCE_INVALID',
      { reason: why, ...details }
    );
  };
  if (!funding || typeof funding !== 'object') fail('FUNDING_EVIDENCE_MISSING');
  if (funding.mode !== 'USDC_SHORTFALL_FUNDED') {
    fail('FUNDING_MODE_UNRECOGNISED', { mode: funding.mode == null ? null : String(funding.mode) });
  }
  const shortfall = _exactDecimalOrNull(funding.shortfallGhs);
  const usdc = _exactDecimalOrNull(funding.usdcDebitedExact);
  const rate = _exactDecimalOrNull(funding.rateGhsPerUsdcExact);
  if (!shortfall) fail('SHORTFALL_UNREADABLE', { recorded: funding.shortfallGhs == null ? null : String(funding.shortfallGhs) });
  if (!shortfall.greaterThan(0)) fail('SHORTFALL_NOT_POSITIVE', { recorded: shortfall.toFixed(8) });
  if (!shortfall.equals(shortfall.toDecimalPlaces(2))) fail('SHORTFALL_NOT_EXACT_PESEWAS', { recorded: shortfall.toFixed(8) });
  if (!usdc) fail('USDC_DEBIT_UNREADABLE', { recorded: funding.usdcDebitedExact == null ? null : String(funding.usdcDebitedExact) });
  if (!usdc.greaterThan(0)) fail('USDC_DEBIT_NOT_POSITIVE', { recorded: usdc.toFixed(8) });
  if (!usdc.equals(usdc.toDecimalPlaces(8))) fail('USDC_DEBIT_NOT_LEDGER_PRECISION', { recorded: usdc.toFixed(8) });
  if (!rate) fail('RATE_UNREADABLE', { recorded: funding.rateGhsPerUsdcExact == null ? null : String(funding.rateGhsPerUsdcExact) });
  if (!rate.greaterThan(0)) fail('RATE_NOT_POSITIVE', { recorded: rate.toFixed(8) });
  if (!rate.equals(rate.toDecimalPlaces(8))) fail('RATE_NOT_LEDGER_PRECISION', { recorded: rate.toFixed(8) });
  const quoteId = funding.quoteId == null ? '' : String(funding.quoteId).trim();
  if (!quoteId) fail('QUOTE_REFERENCE_MISSING');
  // Self-consistency. The funded GHS cannot exceed the GHS the refund restores,
  // and the two recorded amounts must describe the SAME conversion at the
  // recorded rate (8dp USDC rounding puts them within a pesewa of each other).
  const restoredGhs = refundGhs || null;
  if (restoredGhs && shortfall.greaterThan(restoredGhs)) {
    fail('SHORTFALL_EXCEEDS_REFUND', {
      shortfallGhs: shortfall.toFixed(2),
      refundGhs: restoredGhs.toFixed(2),
    });
  }
  const impliedGhs = usdc.times(rate);
  if (impliedGhs.minus(shortfall).abs().greaterThan(new Prisma.Decimal('0.01'))) {
    fail('FUNDING_EVIDENCE_INCONSISTENT', {
      shortfallGhs: shortfall.toFixed(2),
      usdcDebitedExact: usdc.toFixed(8),
      rateGhsPerUsdcExact: rate.toFixed(8),
      impliedGhsFromDebit: impliedGhs.toFixed(4),
    });
  }
  return { shortfall, usdc: usdc.toDecimalPlaces(8), rate, quoteId };
}

async function reverseNativeGhsWithdrawal(prisma, opts = {}) {
  const { reference, reason } = opts;
  try {
    return await _reverseNativeGhsWithdrawalTx(prisma, opts);
  } catch (err) {
    // Funding evidence that cannot be reversed is a reconciliation matter: the
    // transaction has already rolled back, so the evidence is written on its
    // own connection and the row stays held for a human decision.
    if (err && err.code === 'NATIVE_GHS_FUNDING_EVIDENCE_INVALID') {
      try {
        await recordReconciliationException(prisma, {
          entityType: 'TRANSACTION',
          entityId: String(reference),
          reference: String(reference),
          reason: 'NATIVE_GHS_FUNDING_EVIDENCE_INVALID',
          details: {
            stage: 'REVERSAL',
            settlementCurrency: SETTLEMENT_CURRENCY,
            ...(err.details && typeof err.details === 'object' ? err.details : {}),
          },
        });
      } catch (evidenceError) {
        logger.error(
          { reference, err: evidenceError?.message },
          '[nativeGhsWithdrawal] could not record invalid funding evidence'
        );
      }
    }
    throw err;
  }
}

async function _reverseNativeGhsWithdrawalTx(prisma, { reference, reason, allowedMirrorStatuses = [] }) {
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
    // §P1-1: one atomic boundary. The caller states which states it is willing
    // to claim (admin/review states included); a state outside that set is
    // REFUSED here, before any mutation, so a refusal can never leave a
    // half-applied claim behind for a later dispatcher to pick up.
    const claimable = new Set([
      ...REVERSIBLE_MIRROR_STATES,
      ...(Array.isArray(allowedMirrorStatuses) ? allowedMirrorStatuses : []),
    ]);
    if (mirror) {
      const mirrorStatus = String(mirror.status || '');
      if (NON_REVERSIBLE_TERMINAL_STATES.includes(mirrorStatus)) {
        // Already recorded as paid. Refusing here is the whole point: refunding
        // on top of a completed payout would pay the customer twice.
        return { reversed: false, reason: 'ALREADY_PAID_OR_COMPLETED', status: mirrorStatus };
      }
      if (!claimable.has(mirrorStatus)) {
        return { reversed: false, reason: 'NOT_REVERSIBLE_IN_STATE', status: mirrorStatus };
      }
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
    // §P1-3 THE REFUND IS THE DEBIT, NOT THE RECIPIENT AMOUNT. The withdrawal
    // debited recipient + fee. Refunding only the recipient leaves a failed
    // payout short by the fee. The fee actually charged is read from the
    // recorded metadata (never recomputed from today's configuration, which may
    // have changed since the debit) and defaults to zero for rows that carry no
    // fee evidence.
    let refundGhs = amountGhs;
    if (amountGhs) {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const recordedFee = meta.feeGhs !== undefined && meta.feeGhs !== null
        ? meta.feeGhs
        : (meta.feePolicy && meta.feePolicy.feeGhs !== undefined ? meta.feePolicy.feeGhs : 0);
      try {
        const fee = new Prisma.Decimal(String(recordedFee));
        if (fee.isFinite() && fee.greaterThanOrEqualTo(0)) refundGhs = amountGhs.plus(fee);
      } catch (_) {
        // Unreadable fee evidence: refund the recipient amount (the conservative
        // default) rather than inventing a refund figure.
      }
    }
    if (!amountGhs) {
      // Without the authoritative amount the reversal cannot be exact — the
      // stamp rolls back and the row parks for reconciliation.
      throw new NativeGhsWithdrawalError('reversal amount missing', 'NATIVE_GHS_REVERSAL_AMOUNT_MISSING');
    }
    await nativeGhsWallet.creditNativeGhs({
      tx,
      userId: row.userId,
      amountGhs: refundGhs,
      idempotencyKey: `${REVERSAL_KEY_PREFIX}${reference}`,
      description: `Native GHS withdrawal reversal ${reference}`,
      reference,
      relatedEntity: 'transactionHistory',
      relatedEntityId: row.id,
      metadata: { settlementCurrency: SETTLEMENT_CURRENCY, reversalReason: String(reason ?? 'definitive_failure') },
    });

    // ── Funded shortfall → the EXACT INVERSE of the original conversion ────
    //
    // Two defects lived here.
    //   (1) The reversal reused the funding conversion identity, and the ledger
    //       enforces uniqueness of conversionIdentity: every mixed-funded
    //       reversal threw and the refund rolled back with it.
    //   (2) The refund above credits the FULL debit to nativeGhsBalance, but
    //       part of that debit was never the customer's GHS — it was converted
    //       from USDC. Reversing the GHS ledger leg without decrementing the
    //       spendable projection left the wallet saying 50 while the liability
    //       account said 20.
    //
    // The refund is therefore split explicitly and in one atomic boundary:
    //   full debit → nativeGhsBalance (the payout debit reversed), then
    //   shortfall  → out of nativeGhsBalance and back into USDC.
    // Each leg is exact, and the reversal is its own exchange with its own
    // durable identity that names the original.
    const reversalReason = String(reason ?? 'definitive_failure');
    let fundingReversal = null;
    const recordedFunding = row.metadata?.funding;
    if (recordedFunding) {
      const evidence = readFundingReversalEvidence(recordedFunding, { refundGhs });
      const originalConversionIdentity = FUNDING_CONVERSION_PREFIX + String(reference);
      const reversalConversionIdentity = `${FUNDING_REVERSAL_CONVERSION_PREFIX}${reference}`;

      // 1. The customer's exact USDC debit comes back, at ledger precision.
      const restored = await tx.user.update({
        where: { id: row.userId },
        data: { availableBalance: { increment: evidence.usdc } },
        select: { availableBalance: true },
      });
      if (!restored) {
        throw new NativeGhsWithdrawalError(
          'the customer row could not be restored for the funding reversal',
          'NATIVE_GHS_FUNDING_REVERSAL_USDC_FAILED',
          { reference }
        );
      }

      // 2. Exact inverse posting, asset by asset, under its OWN identity and
      //    linked back to the funding exchange it reverses.
      await ledger.post(tx, {
        idempotencyKey: `${FUNDING_REVERSAL_KEY_PREFIX}${reference}`,
        entryType: 'ASSET_CONVERSION',
        description: `GHS shortfall funding reversal ${reference}`,
        userId: row.userId,
        reference,
        relatedEntity: 'transactionHistory',
        relatedEntityId: row.id,
        conversion: {
          identity: reversalConversionIdentity,
          rate: evidence.rate,
          quoteReference: evidence.quoteId,
        },
        lines: [
          { account: `user:${row.userId}:liability`, credit: evidence.usdc },
          { account: 'clearing:conversion', debit: evidence.usdc },
          { account: `ghs:user:${row.userId}:liability`, debit: evidence.shortfall },
          { account: 'fiat:momo:ghs', credit: evidence.shortfall },
        ],
        metadata: {
          settlementCurrency: SETTLEMENT_CURRENCY,
          reversal: true,
          reversalReason,
          reversesConversionIdentity: originalConversionIdentity,
          originalFundingLedgerKey: `${FUNDING_LEDGER_KEY_PREFIX}${reference}`,
          shortfallGhs: evidence.shortfall.toFixed(2),
          usdcRestoredExact: evidence.usdc.toFixed(8),
          rateGhsPerUsdcExact: evidence.rate.toFixed(8),
          quoteId: evidence.quoteId,
        },
      });

      // 3. The projection moves WITH the ledger, exactly once, in this same
      //    transaction. The CAS floor means a projection that cannot absorb the
      //    subtraction rolls the whole reversal back instead of driving the
      //    spendable balance negative or leaving it overstated.
      const projected = await tx.user.updateMany({
        where: { id: row.userId, nativeGhsBalance: { gte: evidence.shortfall } },
        data: { nativeGhsBalance: { decrement: evidence.shortfall } },
      });
      if (projected.count !== 1) {
        throw new NativeGhsWithdrawalError(
          'the funded shortfall could not be removed from the GHS projection — the reversal was rolled back',
          'NATIVE_GHS_FUNDING_REVERSAL_PROJECTION_FAILED',
          {
            reference,
            shortfallGhs: evidence.shortfall.toFixed(2),
            requiresNativeGhsAtLeast: evidence.shortfall.toFixed(2),
          }
        );
      }

      fundingReversal = {
        ledgerIdempotencyKey: `${FUNDING_REVERSAL_KEY_PREFIX}${reference}`,
        shortfallGhs: evidence.shortfall.toFixed(2),
        usdcRestoredExact: evidence.usdc.toFixed(8),
        rateGhsPerUsdcExact: evidence.rate.toFixed(8),
        quoteId: evidence.quoteId,
        conversionIdentity: reversalConversionIdentity,
        reversesConversionIdentity: originalConversionIdentity,
      };
    }

    // The liquidity authority transition is part of the SAME atomic boundary as
    // the customer credit: if the reservation cannot be released, the whole
    // reversal rolls back and the withdrawal stays held for reconciliation
    // instead of reporting a refund the float never reflected.
    await fiatLiquidity.releaseReservation(tx, { reference, reason: String(reason ?? 'definitive_failure') });

    // §WS5 REVERSAL EVIDENCE ON THE ROW ITSELF. The ledger posting is the
    // accounting authority; this is the operator-facing summary of the SAME
    // facts, written in the SAME transaction, so a rolled-back reversal can
    // never leave a summary claiming a refund that did not happen. It is
    // additive: the original funding evidence under `funding` is never touched.
    await tx.$executeRawUnsafe(
      'UPDATE "TransactionHistory" SET "metadata" = COALESCE("metadata", \'{}\'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE "id" = $1',
      row.id,
      'fundingReversal',
      JSON.stringify({
        reversedAt: new Date().toISOString(),
        reason: String(reason ?? 'definitive_failure'),
        refundGhs: refundGhs ? refundGhs.toFixed(2) : null,
        // FLAT, not nested: an operator reading the row should not have to
        // know the summary sits inside a key of the same name.
        ledgerIdempotencyKey: fundingReversal?.ledgerIdempotencyKey ?? null,
        shortfallGhs: fundingReversal?.shortfallGhs ?? null,
        usdcRestoredExact: fundingReversal?.usdcRestoredExact ?? null,
        rateGhsPerUsdcExact: fundingReversal?.rateGhsPerUsdcExact ?? null,
        quoteId: fundingReversal?.quoteId ?? null,
        conversionIdentity: fundingReversal?.conversionIdentity ?? null,
        reversesConversionIdentity: fundingReversal?.reversesConversionIdentity ?? null,
        // the SAME destination the payout was bound to (never a client value)
        destinationFingerprint: row.metadata?.bankDestinationSnapshot?.fingerprint
          ?? row.metadata?.momoDestinationSnapshot?.fingerprint
          ?? null,
        originalFundingIdentity: row.metadata?.funding?.conversionIdentity ?? null,
      })
    );

    // Compare-and-set on the way out as well: if the payout moved on between
    // the read above and here (a concurrent settle), the whole reversal rolls
    // back instead of overwriting a completed payout with FAILED.
    const canonicalFlip = await tx.transactionHistory.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    if (canonicalFlip.count !== 1) {
      throw new NativeGhsWithdrawalError('canonical payout moved during reversal', 'NATIVE_GHS_REVERSAL_RACED');
    }
    const mirrorStates = [...claimable];
    const mirrorFlip = await tx.withdrawal.updateMany({
      where: { transactionHistoryId: row.id, status: { in: mirrorStates } },
      data: { status: 'FAILED' },
    });
    if (mirror && mirrorFlip.count !== 1) {
      throw new NativeGhsWithdrawalError('payout mirror moved during reversal', 'NATIVE_GHS_REVERSAL_RACED');
    }
    return {
      reversed: true,
      amountGhs: amountGhs.toFixed(2),
      refundGhs: refundGhs.toFixed(2),
      fundingReversal,
    };
  }, { timeout: 20000 });
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
  // §P0-2/§P1-3: the quote and the payout must resolve the SAME rail fee
  // policy, so it is exported rather than re-derived by callers.
  bankPayoutFeePolicy,
  momoPayoutFeePolicy,
  GHS_NATIVE_FEE_POLICY,
  buildMomoDestinationSnapshot,
  SETTLEMENT_CURRENCY,
  DISPATCH_PROVIDER,
  DISPATCH_RAIL,
  GHS_NATIVE_FEE_POLICY,
  NativeGhsWithdrawalError,
  isNativeGhsWithdrawalEnabled,
  toExactPesewa,
  processNativeGhsWithdrawal,
  PROVIDER_OUTCOME,
  REVERSIBLE_OUTCOMES,
  classifyProviderOutcome,
  parkUncertainDispatch,
  dispatchNativeGhsWithdrawal,
  dispatchNaturalGhsBankWithdrawal,
  REVERSIBLE_MIRROR_STATES,
  NON_REVERSIBLE_TERMINAL_STATES,
  reverseNativeGhsWithdrawal,
  // exported for consumer-side contract tests (§7 provider echo binding)
  evaluateBankDispatchObservation,
  // exported so the #391 adapter can be driven through THIS branch's
  // pre-dispatch validation mapping without a route or a database
  enquiryBankDestination,
  bankRevalidationCapability,
  bankRevalidationCapability,
  enquiryBankDestination,
  reconcileNativeGhsWithdrawals,
};
