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
  if (!process.env.AZM_RECONCILER_PROVIDER_USER || !process.env.AZM_RECONCILER_PROVIDER_PUBKEY) {
    throw new WitnessWriterNotPermittedError(
      '[wp-i] the reconciliation process must present its own provider credential; '
      + 'the API process credential is not acceptable evidence.'
    );
  }
}

/** SHA-256 of the exact provider response bytes. */
/** Providers whose inbound funding this witness layer may authorise. */
const TRUSTED_FUNDING_PROVIDERS = Object.freeze(['MOOLRE']);

/**
 * Resolve the AUTHORITATIVE account-to-currency mapping.
 *
 * Currency is never inferred from a callback field that may be absent. The
 * mapping is operator-maintained configuration: pass it explicitly, or provide
 * it as JSON in WITNESS_ACCOUNT_CURRENCY_MAP. With no mapping an account is
 * unmapped, and an unmapped account is a refusal, not a guess.
 */
function resolveCurrencyMapping(explicit) {
  if (explicit && typeof explicit === 'object') return explicit;
  const raw = process.env.WITNESS_ACCOUNT_CURRENCY_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    throw new WitnessError(
      'WITNESS_ACCOUNT_MAPPING_INVALID',
      '[wp-i] WITNESS_ACCOUNT_CURRENCY_MAP is not valid JSON; refusing to witness without an authoritative mapping'
    );
  }
}

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
 * THE DOCUMENTED MOOLRE PAYMENT STATUS CONTRACT.
 *
 * The only provider answer that may evidence treasury funding is the Payment
 * Status response: a wrapper carrying `status`, and a `data` object carrying a
 * NUMERIC `txstatus` alongside `externalref`, `accountnumber`, `value` (net) and
 * `amount` (gross).
 *
 * Two things this rules out, both of which previously authorised money:
 *   - the legacy `state` / `txstatus_label` vocabulary. Those are not the
 *     documented numeric field, and treating free-text "success" as settlement
 *     is an adapter guessing at a provider's semantics. For funding they are
 *     UNKNOWN, never success.
 *   - identity fields being OPTIONAL. A response naming no account and no
 *     reference proves nothing about either, and the old `?? walletAccount`
 *     fallback silently substituted the wallet we asked about for the account
 *     the provider actually named.
 */
// The canonical rules live in exactly one place. Inventing a second name here is
// how a boundary ends up with two vocabularies that silently disagree.
const {
    ADAPTER_DOCUMENTED: DOCUMENTED_ADAPTER_RULE,
    ADAPTER_LEGACY: LEGACY_ADAPTER_RULE,
} = require('./providers/moolreStatusAdapter');
const TXSTATUS_SUCCESS = 1;

/** `data.txstatus` is numeric by contract; a numeric string is tolerated, anything else is absent. */
function numericTxstatus(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
    return null;
}

function parseDocumentedStatusBytes(rawResponse) {
    let doc;
    try {
        doc = JSON.parse(String(rawResponse));
    } catch (_) {
        throw new WitnessError(
            'WITNESS_RAW_RESPONSE_UNPARSEABLE',
            '[wp-i] the retained provider response is not JSON, so none of its claims can be re-derived'
        );
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new WitnessError('WITNESS_RAW_RESPONSE_UNPARSEABLE', '[wp-i] the retained provider response is not a JSON object');
    }
    const data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? doc.data : null;
    if (!data) {
        throw new WitnessError(
            'WITNESS_PROVIDER_PAYLOAD_ABSENT',
            '[wp-i] the documented Moolre status response carries a `data` object; this one does not'
        );
    }
    const txstatus = numericTxstatus(data.txstatus);
    if (txstatus === null) {
        throw new WitnessError(
            'WITNESS_LEGACY_STATUS_NOT_FUNDABLE',
            '[wp-i] no numeric data.txstatus; legacy state/txstatus_label observations are UNKNOWN for funding'
        );
    }
    if (txstatus !== TXSTATUS_SUCCESS) {
        throw new WitnessError(
            'WITNESS_PROVIDER_STATE_NOT_SETTLED',
            '[wp-i] provider txstatus ' + txstatus + ' is not settlement; only ' + TXSTATUS_SUCCESS + ' may evidence funding'
        );
    }
    const externalref = data.externalref == null ? '' : String(data.externalref).trim();
    const accountnumber = data.accountnumber == null ? '' : String(data.accountnumber).trim();
    if (!externalref || !accountnumber) {
        throw new WitnessError(
            'WITNESS_IDENTITY_FIELDS_REQUIRED',
            '[wp-i] the response must name both externalref and accountnumber; a missing identity field is not optional for treasury proof'
        );
    }
    return {
        wrapperStatus: doc.status === undefined || doc.status === null ? null : String(doc.status),
        data: data,
        txstatus: txstatus,
        externalref: externalref,
        accountnumber: accountnumber,
    };
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
    settlementState = null, adapterRule = null,
  } = input;

  // The adapter's documented settlement verdict is authoritative when supplied.
  // The legacy field sniffing below exists only for historical fixtures and is
  // recorded on the witness as undocumented.
  // There is no legacy fallback any more. `state` / `txstatus_label` are not the
  // documented field and must never be read as settlement; parseDocumentedStatusBytes
  // below refuses an envelope without a numeric data.txstatus.
  const effectiveState = settlementState ? String(settlementState).toUpperCase() : 'SETTLED';

  if (!openingDedupKey || typeof openingDedupKey !== 'string') {
    throw new WitnessError(
      'WITNESS_NO_OPENING',
      '[wp-i] a witness must name an existing treasury opening; arbitrary references are refused'
    );
  }
  if (!provider || !WITNESS_SETTLED_STATES.includes(effectiveState) || effectiveState !== 'SETTLED') {
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

  if (!TRUSTED_FUNDING_PROVIDERS.includes(String(provider))) {
    throw new WitnessError(
      'WITNESS_PROVIDER_UNTRUSTED',
      `[wp-i] provider ${provider} is not a trusted inbound funding provider`
    );
  }
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.trim()) {
    throw new WitnessError('WITNESS_ENDPOINT_REQUIRED', '[wp-i] witness must record the provider endpoint actually queried');
  }
  if (rawResponse === undefined || rawResponse === null || String(rawResponse).trim() === '') {
    throw new WitnessError('WITNESS_RAW_RESPONSE_REQUIRED', '[wp-i] witness must retain the exact provider response bytes');
  }

  // The amounts are DERIVED from the provider payload, never taken on trust
  // from the caller. A caller-supplied figure must agree with the bytes.
  // THE BYTES ARE THE EVIDENCE. Everything below is re-derived from rawResponse,
  // never taken from a caller's parsed copy. A supplied providerPayload is
  // accepted only when it IS the parse of these exact bytes.
  const parsed = parseDocumentedStatusBytes(rawResponse);
  if (providerPayload !== undefined && providerPayload !== null) {
    if (JSON.stringify(providerPayload) !== JSON.stringify(parsed.data)) {
      throw new WitnessMismatchError(
        '[wp-i] the supplied providerPayload is not the parse of the retained raw response bytes',
        { parsedDigest: digestOf(JSON.stringify(parsed.data)), suppliedDigest: digestOf(JSON.stringify(providerPayload)) }
      );
    }
  }
  // A LEGACY observation must never authorise treasury funding, even though the
  // adapter still parses it for historical evidence. The refusal is by RULE, not
  // by the presence of a lucky txstatus field.
  if (adapterRule === LEGACY_ADAPTER_RULE) {
    throw new WitnessError(
      'WITNESS_LEGACY_ADAPTER_NOT_FUNDABLE',
      '[wp-i] adapter rule ' + LEGACY_ADAPTER_RULE + ' is undocumented evidence and cannot authorise treasury funding'
    );
  }
  if (adapterRule !== null && adapterRule !== undefined && adapterRule !== DOCUMENTED_ADAPTER_RULE) {
    throw new WitnessError(
      'WITNESS_ADAPTER_RULE_UNSUPPORTED',
      '[wp-i] adapter rule ' + String(adapterRule) + ' is not the documented ' + DOCUMENTED_ADAPTER_RULE
    );
  }
  const derived = settledAmountFromProviderPayload(parsed.data);
  if (derived.grossPesewas !== null && derived.grossPesewas < derived.netPesewas) {
    // A gross below net is not a fee, it is a contradiction. Never invent a
    // negative fee to make the arithmetic close.
    throw new WitnessMismatchError(
      '[wp-i] provider gross ' + derived.grossPesewas + ' pesewas is BELOW net ' + derived.netPesewas + ' pesewas',
      { grossPesewas: derived.grossPesewas.toString(), netPesewas: derived.netPesewas.toString() }
    );
  }
  const netPesewas = derived.netPesewas;
  if (amounts?.netPesewas !== undefined && BigInt(amounts.netPesewas) !== netPesewas) {
    throw new WitnessMismatchError(
      `[wp-i] supplied net ${amounts.netPesewas} contradicts the provider payload net ${netPesewas}`,
      { supplied: String(amounts.netPesewas), derived: netPesewas.toString() }
    );
  }

  // Currency comes from the authoritative mapping, never from the payload.
  const currency = currencyForAccount(walletAccount, resolveCurrencyMapping(input.currencyMapping));

  // The account the provider NAMES in its own response must be the account we
  // reconciled. Asking about wallet Y while the provider answers for wallet Z is
  // not evidence about Y, so it is a refusal — even when the amounts happen to
  // agree. An answer that names no account is allowed: the query was scoped to
  // the opening's wallet and the provider returned nothing for it.
  const reportedAccount = parsed.accountnumber;
  const reconciledAccount = walletAccount == null ? '' : String(walletAccount).trim();
  if (reportedAccount !== '' && reconciledAccount !== '' && reportedAccount !== reconciledAccount) {
    throw new WitnessError(
      'WITNESS_ACCOUNT_MISMATCH',
      `[wp-i] the provider settled ${reportedAccount}, not the reconciled wallet ${reconciledAccount}`,
      { reportedAccount, reconciledAccount }
    );
  }

  // The reference the answer DESCRIBES must be the reference that was ASKED
  // ABOUT. The provider scopes a type-1 lookup by id, so a mismatched
  // externalref means we are holding an answer to a different question, and
  // matching amounts would otherwise let it vouch for this opening.
  const requestedReferenceRaw = requestParams && (requestParams.id ?? requestParams.reference);
  const reportedReferenceRaw = parsed.externalref;
  const requestedReference = requestedReferenceRaw == null ? '' : String(requestedReferenceRaw).trim();
  const reportedReference = reportedReferenceRaw == null ? '' : String(reportedReferenceRaw).trim();
  if (reportedReference === '') {
    throw new WitnessError(
      'WITNESS_IDENTITY_FIELDS_REQUIRED',
      '[wp-i] the response names no externalref, so it cannot be bound to a specific provider payment'
    );
  }
  if (requestedReference !== '' && reportedReference !== requestedReference) {
    throw new WitnessError(
      'WITNESS_REFERENCE_MISMATCH',
      `[wp-i] the provider answered for ${reportedReference}, not the requested reference ${requestedReference}`,
      { reportedReference, requestedReference }
    );
  }


  const fetched = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(fetched.getTime())) {
    throw new WitnessError('WITNESS_FETCH_TIME_INVALID', '[wp-i] witness requires the real time of the provider fetch');
  }
  if (fetched.getTime() > Date.now() + 60_000) {
    throw new WitnessError('WITNESS_FETCH_TIME_IN_FUTURE', '[wp-i] a witness cannot be dated in the future');
  }
  const openingAt = opening.createdAt ?? opening.created_date ?? opening.createdDate ?? null;
  if (!openingAt) {
    // Cannot verify the fetch against the opening it claims to evidence.
    throw new WitnessError(
      'WITNESS_OPENING_TIME_UNKNOWN',
      '[wp-i] the treasury opening carries no creation time, so a provider fetch cannot be bound to it'
    );
  }
  if (fetched.getTime() < new Date(openingAt).getTime()) {
    throw new WitnessMismatchError(
      '[wp-i] the provider fetch predates the treasury opening it claims to evidence',
      { fetchedAt: fetched.toISOString(), openingAt: new Date(openingAt).toISOString() }
    );
  }
  const openingPesewas = ghsToPesewas(opening.amountGhs?.toString?.() ?? opening.amountGhs);
  if (openingPesewas !== netPesewas) {
    throw new WitnessMismatchError(
      `[wp-i] provider settled net ${netPesewas} pesewas does not equal opening ${openingPesewas} pesewas`,
      { openingPesewas: openingPesewas.toString(), netPesewas: netPesewas.toString() }
    );
  }

  // Single-use binding on the provider observation (WP-I matrix case 26): one
  // settlement can fund exactly ONE treasury opening. Identity is derived from
  // what was actually queried, not from anything the caller may vary, and the
  // unique index is the real guard under concurrency — the pre-check exists so
  // the common path fails with a typed reason instead of a raw constraint error.
  // The identity must identify the OBSERVATION, not merely the call shape. A
  // witness recorded without requestParams.id still describes one specific
  // payment, so fall back to the reference the provider reported and finally to
  // the response bytes themselves — two different payments can never collide,
  // and the same payment always does.
  const observedReference = parsed.externalref;
  const observedAccount = parsed.accountnumber;
  const observedTransactionId = parsed.data.transactionid ?? requestParams?.transactionid ?? '';
  const observationKey = crypto
    .createHash('sha256')
    .update([
      String(provider), fundingType, String(endpoint), String(observedReference),
      String(observedAccount), String(observedTransactionId),
    ].join('|'))
    .digest('hex');
  // ── CROSS-PATH SINGLE USE ────────────────────────────────────────────────
  // The check below only sees witnesses. A collection that already settled an
  // ORDINARY CUSTOMER DEPOSIT leaves no witness row, so without this guard the
  // same Moolre payment could be spent once as a deposit and again as treasury
  // funding - two economic uses, one payment. The deposit path's durable record
  // is a FiatProviderEvent keyed `event:moolre-collection:<externalref>`
  // (src/services/moolreDepositSettlement.js), so that key is the evidence that
  // the observation is spent. Absence of the model on a stub client is treated
  // as "cannot prove", which refuses rather than allows.
  const collectionKey = observedReference ? `event:moolre-collection:${observedReference}` : null;
  if (collectionKey) {
      // A client that cannot see fiatProviderEvent cannot prove the collection is
      // UNSPENT, so it must not fund anything. This is a typed refusal rather
      // than a TypeError: the first version of this guard called .findFirst on an
      // absent delegate and crashed the six trust-boundary cases that use a fake
      // transaction, which is exactly how a missing capability should NOT behave.
      const depositDelegate = tx.fiatProviderEvent;
      if (!depositDelegate || typeof depositDelegate.findFirst !== 'function') {
          throw new WitnessError(
              'WITNESS_DEPOSIT_USE_UNVERIFIABLE',
              '[wp-i] this settlement client cannot prove whether the collection already settled a customer deposit, so it cannot fund a treasury opening',
              { dedupKey: collectionKey }
          );
      }
      const depositUse = await depositDelegate.findFirst({
          where: { dedupKey: collectionKey },
          select: { dedupKey: true, status: true },
      });
      if (depositUse) {
          throw new WitnessError(
              'WITNESS_OBSERVATION_SPENT_ON_DEPOSIT',
              '[wp-i] this provider collection already settled a customer deposit; one payment cannot also fund a treasury opening',
              { dedupKey: collectionKey }
          );
      }
  }

  const alreadyUsed = await tx.providerSettlementWitness.findUnique({ where: { observationKey } });
  if (alreadyUsed) {
    throw new WitnessError(
      'WITNESS_OBSERVATION_ALREADY_USED',
      `[wp-i] this provider settlement already vouches for opening ${alreadyUsed.openingDedupKey}; one observation cannot fund a second opening`
    );
  }

  let witness;
  try {
    witness = await tx.providerSettlementWitness.create({
    data: {
      openingDedupKey,
      observationKey,
      provider: String(provider),
      fundingType,
      witnessKind: requiredWitness,
      walletAccount: String(walletAccount ?? ''),
      currency,
      netPesewas,
      grossPesewas: derived.grossPesewas,
      providerState: effectiveState,
      adapterRule: DOCUMENTED_ADAPTER_RULE,
      endpoint: String(endpoint ?? ''),
      requestParams: requestParams ?? {},
      rawResponseDigest: digestOf(rawResponse),
      fetchedAt: fetched,
      // The exact bytes are retained so a later audit can recompute the digest.
      rawResponse: String(rawResponse ?? ''),
    },
    });
  } catch (err) {
    // Concurrent writers both pass the pre-check; the unique index settles it.
    if (err && err.code === 'P2002') {
      throw new WitnessError(
        'WITNESS_OBSERVATION_ALREADY_USED',
        '[wp-i] this provider settlement is already bound to another opening'
      );
    }
    throw err;
  }

  return witness;
}

/**
 * Find the witness that authorises a treasury opening, and prove it is usable.
 * Returns null when there is no witness — the caller must then refuse.
 */
async function findWitnessForOpening(tx, { openingDedupKey, provider, openingPesewas = null }) {
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
  // Defence in depth: the witness amount must still equal the opening it funds,
  // even if the receipt was touched after the witness was recorded.
  if (openingPesewas !== undefined && openingPesewas !== null) {
    if (BigInt(witness.netPesewas) !== BigInt(openingPesewas)) {
      throw new WitnessMismatchError(
        `[wp-i] witness net ${witness.netPesewas} no longer equals opening ${openingPesewas} pesewas`
      );
    }
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
  resolveCurrencyMapping,
  TRUSTED_FUNDING_PROVIDERS,
  settledAmountFromProviderPayload,
  recordProviderSettlementWitness,
  findWitnessForOpening,
};
