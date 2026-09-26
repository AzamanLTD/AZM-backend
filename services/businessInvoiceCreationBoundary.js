'use strict';

const invoiceService = require('./businessInvoiceService');
const {
  parseExactDecimal,
  parseStrictQuantity,
} = require('../utils/exactInvoiceMath');

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function normalizeIdempotencyKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  if (!key) throw Object.assign(new Error('Idempotency-Key cannot be blank.'), { status: 400 });
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw Object.assign(new Error(`Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`), { status: 400 });
  }
  return key;
}

// r39/P1 — EXACT FINGERPRINT CANONICALIZATION.
// The replay identity uses the SAME authorities as the execution path
// (exactInvoiceMath.parseStrictQuantity / parseExactDecimal) and represents
// every monetary value by its exact canonical decimal string. NO JS Number
// conversion anywhere: float64 collapses large-magnitude 8dp values
// (999999999999.99999999 vs 999999999999.99999998 are indistinguishable as
// float64 but are DIFFERENT economic intents), so a Number()-based fingerprint
// could accept a materially different replay.
const canonicalUnitPrice = (value, label) => parseExactDecimal(value, label).toFixed(8);
const canonicalQuantity = (value, label) => String(parseStrictQuantity(value, label));

function canonicalRequestItem(item, index) {
  const label = `lineItems[${index}]`;
  return {
    description: String(item.description || '').trim().slice(0, 200),
    quantity: canonicalQuantity(item.quantity, `${label}.quantity`),
    unitPrice: canonicalUnitPrice(item.unitPrice, `${label}.unitPrice`),
  };
}

// Stored rows come back as Prisma.Decimal (or plain values in narrow unit
// mocks); both normalize through the same exact parser to the identical
// canonical 8dp string the row was persisted with.
function canonicalStoredItem(item, index) {
  const label = `stored lineItems[${index}]`;
  return {
    description: String(item.description || ''),
    quantity: canonicalQuantity(item.quantity, `${label}.quantity`),
    unitPrice: canonicalUnitPrice(item.unitPrice, `${label}.unitPrice`),
  };
}

// Tax value column is Decimal(10,4) — the same 4dp ceiling the execution path
// enforces up-front is applied here so a >4dp replay intent is refused rather
// than silently rounded into a false match.
const canonicalTaxValue = (value, name) => {
  const dec = parseExactDecimal(value, `tax value for '${name}'`);
  if (dec.decimalPlaces() > 4) {
    throw Object.assign(
      new Error(`Tax value for '${name}' supports at most 4 decimal places (Decimal(10,4) column).`),
      { status: 400 },
    );
  }
  return dec.toFixed(4);
};

function normalizeTaxIntent(taxLines) {
  if (taxLines === undefined) return null; // undefined means "use current business default"
  if (!Array.isArray(taxLines)) return [];
  return taxLines.map((tax) => {
    const name = String(tax.name || '').trim();
    return {
      name,
      type: String(tax.type || '').toUpperCase(),
      value: canonicalTaxValue(tax.value, name || 'unnamed'),
    };
  });
}

function storedTaxIntent(taxLines) {
  return (taxLines || []).map((tax) => {
    const name = String(tax.name || '').trim();
    return {
      name,
      type: String(tax.type || '').toUpperCase(),
      value: canonicalTaxValue(tax.value, name || 'unnamed'),
    };
  });
}

function assertReplayBelongsToIntent(invoice, args) {
  if (!invoice || !args?.idempotencyKey) return;

  const mismatches = [];
  if (String(invoice.businessProfileId) !== String(args.businessProfileId)) mismatches.push('businessProfileId');
  if (String(invoice.customerId) !== String(args.customerId)) mismatches.push('customerId');
  if ((invoice.locationId || null) !== (args.locationId || null)) mismatches.push('locationId');
  if ((invoice.tableId || null) !== (args.tableId || null)) mismatches.push('tableId');

  // Exact canonical decimal strings on BOTH sides — never JS Number coercion.
  const cleanItems = Array.isArray(args.lineItems)
    ? args.lineItems.map((item, i) => canonicalRequestItem(item, i))
    : [];
  const storedItems = (invoice.lineItems || []).map((item, i) => canonicalStoredItem(item, i));
  if (JSON.stringify(storedItems) !== JSON.stringify(cleanItems)) mismatches.push('lineItems');

  const requestedNote = args.businessNote ? String(args.businessNote).slice(0, 500) : null;
  if ((invoice.businessNote || null) !== requestedNote) mismatches.push('businessNote');

  const requestedTax = normalizeTaxIntent(args.taxLines);
  if (requestedTax !== null) {
    if (JSON.stringify(storedTaxIntent(invoice.taxLines)) !== JSON.stringify(requestedTax)) mismatches.push('taxLines');
  }

  if (mismatches.length) {
    throw Object.assign(
      new Error(`Idempotency-Key already used for a different invoice request (${mismatches.join(', ')}).`),
      { status: 409, code: 'IDEMPOTENCY_INTENT_MISMATCH' },
    );
  }
}

function isIdempotencyUniqueViolation(error) {
  if (error?.code !== 'P2002') return false;
  const target = error?.meta?.target;
  if (!target) return true;
  const values = Array.isArray(target) ? target : [target];
  return values.some((value) => String(value).toLowerCase().includes('idempotency'));
}

async function findReplay(prisma, idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.businessInvoice.findUnique({
    where: { idempotencyKey },
    include: { lineItems: true, taxLines: true },
  });
}

/**
 * Canonical creation boundary for business invoices.
 *
 * The underlying invoice service remains responsible for authoritative totals,
 * default-tax resolution, ownership/customer validation, and persistence. This
 * wrapper owns the client request identity contract: one non-blank key maps to
 * one invoice, replays return that committed invoice, and a reused key cannot
 * silently create a different invoice intent.
 */
async function createInvoice(prisma, args = {}) {
  const normalizedKey = normalizeIdempotencyKey(args.idempotencyKey);
  const effectiveArgs = { ...args, idempotencyKey: normalizedKey };

  if (!normalizedKey) {
    return { invoice: await invoiceService.createInvoice(prisma, effectiveArgs), replayed: false };
  }

  const existing = await findReplay(prisma, normalizedKey);
  if (existing) {
    assertReplayBelongsToIntent(existing, effectiveArgs);
    return { invoice: existing, replayed: true };
  }

  try {
    const invoice = await invoiceService.createInvoice(prisma, effectiveArgs);
    return { invoice, replayed: false };
  } catch (error) {
    if (!isIdempotencyUniqueViolation(error)) throw error;

    const replay = await findReplay(prisma, normalizedKey);
    if (!replay) throw error;
    assertReplayBelongsToIntent(replay, effectiveArgs);
    return { invoice: replay, replayed: true };
  }
}

module.exports = {
  createInvoice,
  normalizeIdempotencyKey,
  assertReplayBelongsToIntent,
};
