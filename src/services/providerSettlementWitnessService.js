// =============================================================================
// WP-I — PROVIDER SETTLEMENT WITNESS (authoritative treasury funding evidence)
//
// THE PROBLEM THIS CLOSES
// The runtime database identity can insert a plausible FiatProviderEvent.
// `confirmTreasuryOpening` historically accepted such an event as proof that
// real GHS arrived, so a compromised runtime credential could mint treasury
// funding out of nothing.
//
// THE BOUNDARY
// A receipt may become AVAILABLE only when an INDEPENDENTLY FETCHED provider
// settlement witness matches it exactly. The witness is written by a separate
// reconciliation process that:
//   • holds its own provider credentials (never the API process's),
//   • connects under its own database identity,
//   • queries the provider over HTTPS itself,
//   • and accepts as input ONLY the identifier of a treasury opening that the
//     server already created — never an amount or a reference supplied by the
//     application or a user.
//
// HONEST LIMITS (stated so nobody over-reads this):
//   • A separate process defeats a compromised API process. A second credential
//     inside the same process would NOT — that is why the writer guard below
//     refuses to run outside reconciler mode rather than pretending.
//   • This module cannot stop a compromised RECONCILER. It contains the damage:
//     a witness without a genuine provider response cannot satisfy the digest,
//     endpoint and timestamp binding checks at promotion time.
//   • No HMAC is invented here. Provider authentication is whatever the
//     provider contract actually supports; this file does not assume one.
// =============================================================================

'use strict';

const crypto = require('crypto');

/** Currencies this witness layer can prove. GHS only, deliberately. */
const WITNESS_CURRENCIES = Object.freeze(['GHS']);

/** Provider-reported states that count as SETTLED. Anything else is not proof. */
const WITNESS_SETTLED_STATES = Object.freeze(['SETTLED', 'SUCCESS', 'COMPLETED']);

/**
 * Funding types and the witness each one requires. A witness fetched by the
 * wrong lookup cannot prove the funding it is presented for — a collection
 * reference cannot prove a bank deposit, and neither can prove an unsolicited
 * mobile-money credit. Unsupported combinations are refused, never coerced.
 */
const FUNDING_TYPE_WITNESS = Object.freeze({
  COLLECTION: 'PAYMENT_STATUS_TYPE_1',
  BANK_VIRTUAL_ACCOUNT: 'PAYMENT_STATUS_TYPE_2_ACCOUNT',
  PAYMENT_ID: 'PAYMENT_STATUS_TYPE_2_PAYMENT_ID',
  WALLET_INFLOW: 'ACCOUNT_STATEMENT_TYPE_2_PRIVATE',
});

class WitnessError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'WitnessError';
    this.code = code;
    this.details = details;
  }
}

/** Thrown when the caller is not the reconciliation process. */
class WitnessWriterNotPermittedError extends WitnessError {
  constructor(message, details) {
    super('WITNESS_WRITER_NOT_PERMITTED', message, details);
  }
}

/** Thrown when a presented witness does not match the opening it is used for. */
class WitnessMismatchError extends WitnessError {
  constructor(message, details) {
    super('WITNESS_MISMATCH', message, details);
  }
}

/**
 * True only inside the reconciliation process. The API process does not set
 * AZM_RECONCILER_MODE, so it cannot write a witness even holding the runtime
 * credential. This is a defence-in-depth guard, NOT a claim that a compromised
 * API process is contained by it — the containment is the separate credential
 * and the absence of write authority in the runtime database identity.
 */
function assertReconcilerContext() {
  if (process.env.AZM_RECONCILER_MODE !== '1') {
    throw new WitnessWriterNotPermittedError(
      '[wp-i] provider settlement witnesses may only be written by the reconciliation process '
      + '(AZM_RECONCILER_MODE=1). The API process is not permitted to manufacture treasury evidence.'
    );
  }
  if (!process.env.AZM_RECONCILER_PROVIDER_KEY) {
    throw new WitnessWriterNotPermittedError(
      '[wp-i] the reconciliation process must present its own provider credential; '
      + 'the API process credential is not acceptable evidence.'
    );
  }
}

/** SHA-256 of the exact provider response bytes. */
function digestOf(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Exact GHS -> integer pesewas. Never float maths (0.1+0.2 class errors). */
function ghsToPesewas(value) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new WitnessError('WITNESS_AMOUNT_INEXACT', `[wp-i] amount ${JSON.stringify(value)} is not exact to the pesewa`);
  }
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const pesewas = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -pesewas : pesewas;
}

/**
 * Resolve currency from an authoritative account mapping. Currency must NEVER be
 * inferred from an absent callback field: an unmatched account is a refusal.
 */
function currencyForAccount(accountNumber, mapping) {
  const key = String(accountNumber ?? '').trim();
  if (!key) {
    throw new WitnessError('WITNESS_ACCOUNT_MISSING', '[wp-i] no provider account number on the witness request');
  }
  const currency = mapping?.[key];
  if (!currency) {
    throw new WitnessError(
      'WITNESS_ACCOUNT_UNMAPPED',
      `[wp-i] provider account ${key} has no authoritative currency mapping; refusing to infer one`,
      { accountNumber: key }
    );
  }
  if (!WITNESS_CURRENCIES.includes(currency)) {
    throw new WitnessError('WITNESS_CURRENCY_UNSUPPORTED', `[wp-i] currency ${currency} is not witnessable`);
  }
  return currency;
}

/**
 * Moolre reports BOTH `amount` (payer gross) and `value` (net after fees).
 * The ledger may only credit what the wallet actually received, so net is
 * authoritative and gross is retained alongside it for reconciliation.
 * Never credit gross.
 */
function settledAmountFromProviderPayload(payload) {
  const net = payload?.value;
  if (net === undefined || net === null || String(net).trim() === '') {
    throw new WitnessError(
      'WITNESS_NET_AMOUNT_ABSENT',
      '[wp-i] provider payload carries no `value` (net credited amount); gross `amount` may never be credited'
    );
  }
  const netPesewas = ghsToPesewas(net);
  if (netPesewas <= 0n) {
    throw new WitnessError('WITNESS_NET_AMOUNT_NOT_POSITIVE', '[wp-i] net settled amount must be positive');
  }
  let grossPesewas = null;
  try {
    grossPesewas = payload?.amount === undefined ? null : ghsToPesewas(payload.amount);
  } catch (_) {
    grossPesewas = null;
  }
  return { netPesewas, grossPesewas, feePesewas: grossPesewas === null ? null : grossPesewas - netPesewas };
}

/**
 * Record an immutable provider settlement witness against a treasury opening
 * that ALREADY EXISTS.
 *
 * @param tx          Prisma transaction client (reconciler DB identity)
 * @param input.openingDedupKey  the ONLY accepted locator — must already exist
 * @param input.provider         provider id
 * @param input.fundingType      one of FUNDING_TYPE_WITNESS keys
 * @param input.endpoint         provider endpoint actually queried
 * @param input.requestParams    parameters actually sent
 * @param input.rawResponse      exact provider response bytes
 * @param input.providerPayload  parsed response used for matching
 * @param input.amounts          { netPesewas, grossPesewas }
 * @param input.fetchedAt        Date of the provider call
 */
async function recordProviderSettlementWitness(tx, input = {}) {
  assertReconcilerContext();

  const {
    openingDedupKey, provider, fundingType, endpoint, requestParams,
    rawResponse, providerPayload, amounts, fetchedAt, walletAccount,
  } = input;

  if (!openingDedupKey || typeof openingDedupKey !== 'string') {
    throw new WitnessError(
      'WITNESS_NO_OPENING',
      '[wp-i] a witness must name an existing treasury opening; arbitrary references are refused'
    );
  }
  if (!provider || !WITNESS_SETTLED_STATES.includes(String(providerPayload?.state ?? providerPayload?.txstatus_label ?? '').toUpperCase())) {
    // Non-final provider state can never become a witness.
    throw new WitnessError(
      'WITNESS_PROVIDER_STATE_NOT_SETTLED',
      '[wp-i] the provider has not reported a settled state; pending or failed responses cannot witness funding'
    );
  }
  const requiredWitness = FUNDING_TYPE_WITNESS[fundingType];
  if (!requiredWitness) {
    throw new WitnessError('WITNESS_FUNDING_TYPE_UNSUPPORTED', `[wp-i] funding type ${fundingType} has no supported witness`);
  }

  // The opening must pre-exist. This is what stops the application (or a user)
  // from inventing a lookup and then presenting its result as evidence.
  const opening = await tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey: openingDedupKey } });
  if (!opening) {
    throw new WitnessError(
      'WITNESS_OPENING_NOT_FOUND',
      `[wp-i] treasury opening ${openingDedupKey} does not exist; the reconciler never queries for a reference it was handed`
    );
  }

  const netPesewas = amounts?.netPesewas;
  if (typeof netPesewas !== 'bigint' || netPesewas <= 0n) {
    throw new WitnessError('WITNESS_NET_AMOUNT_REQUIRED', '[wp-i] witness requires an exact positive net amount in pesewas');
  }
  const openingPesewas = ghsToPesewas(opening.amountGhs?.toString?.() ?? opening.amountGhs);
  if (openingPesewas !== netPesewas) {
    throw new WitnessMismatchError(
      `[wp-i] provider settled net ${netPesewas} pesewas does not equal opening ${openingPesewas} pesewas`,
      { openingPesewas: openingPesewas.toString(), netPesewas: netPesewas.toString() }
    );
  }

  const witness = await tx.providerSettlementWitness.create({
    data: {
      openingDedupKey,
      provider: String(provider),
      fundingType,
      witnessKind: requiredWitness,
      walletAccount: String(walletAccount ?? ''),
      currency: 'GHS',
      netPesewas,
      grossPesewas: amounts?.grossPesewas ?? null,
      providerState: String(providerPayload?.state ?? '').toUpperCase(),
      endpoint: String(endpoint ?? ''),
      requestParams: requestParams ?? {},
      rawResponseDigest: digestOf(rawResponse),
      fetchedAt: fetchedAt ?? new Date(),
      // The exact bytes are retained so a later audit can recompute the digest.
      rawResponse: String(rawResponse ?? ''),
    },
  });

  return witness;
}

/**
 * Find the witness that authorises a treasury opening, and prove it is usable.
 * Returns null when there is no witness — the caller must then refuse.
 */
async function findWitnessForOpening(tx, { openingDedupKey, provider }) {
  const witness = await tx.providerSettlementWitness.findUnique({
    where: { openingDedupKey },
  });
  if (!witness) return null;

  // Re-prove the binding at promotion time rather than trusting a stored flag.
  if (provider && witness.provider !== provider) {
    throw new WitnessMismatchError(
      `[wp-i] witness provider ${witness.provider} does not match opening provider ${provider}`
    );
  }
  if (!WITNESS_CURRENCIES.includes(witness.currency)) {
    throw new WitnessMismatchError(`[wp-i] witness currency ${witness.currency} is not witnessable`);
  }
  if (!WITNESS_SETTLED_STATES.includes(String(witness.providerState).toUpperCase())) {
    throw new WitnessMismatchError('[wp-i] witness does not record a provider-reported settled state');
  }
  // Digest integrity: a witness whose retained bytes no longer hash to its
  // recorded digest was tampered with after the fact.
  const recomputed = digestOf(witness.rawResponse);
  if (recomputed !== witness.rawResponseDigest) {
    throw new WitnessMismatchError('[wp-i] witness digest does not match its retained provider response');
  }
  if (!witness.fetchedAt || !witness.endpoint) {
    throw new WitnessMismatchError('[wp-i] witness is missing its fetch timestamp or endpoint binding');
  }
  return witness;
}

module.exports = {
  WITNESS_CURRENCIES,
  WITNESS_SETTLED_STATES,
  FUNDING_TYPE_WITNESS,
  WitnessError,
  WitnessWriterNotPermittedError,
  WitnessMismatchError,
  assertReconcilerContext,
  digestOf,
  ghsToPesewas,
  currencyForAccount,
  settledAmountFromProviderPayload,
  recordProviderSettlementWitness,
  findWitnessForOpening,
};
