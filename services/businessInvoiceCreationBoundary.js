'use strict';

const invoiceService = require('./businessInvoiceService');

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

function normalizeTaxIntent(taxLines) {
  if (taxLines === undefined) return null; // undefined means "use current business default"
  if (!Array.isArray(taxLines)) return [];
  return taxLines.map((tax) => ({
    name: String(tax.name || '').trim(),
    type: String(tax.type || '').toUpperCase(),
    value: Number(tax.value),
  }));
}

function assertReplayBelongsToIntent(invoice, args) {
  if (!invoice || !args?.idempotencyKey) return;

  const mismatches = [];
  if (String(invoice.businessProfileId) !== String(args.businessProfileId)) mismatches.push('businessProfileId');
  if (Number(invoice.customerId) !== Number(args.customerId)) mismatches.push('customerId');
  if ((invoice.locationId || null) !== (args.locationId || null)) mismatches.push('locationId');
  if ((invoice.tableId || null) !== (args.tableId || null)) mismatches.push('tableId');

  const cleanItems = Array.isArray(args.lineItems)
    ? args.lineItems.map((item) => ({
        description: String(item.description || '').trim().slice(0, 200),
        quantity: Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1,
        unitPrice: Number(item.unitPrice),
      }))
    : [];
  const storedItems = (invoice.lineItems || []).map((item) => ({
    description: String(item.description || ''),
    quantity: Number(item.quantity),
    unitPrice: Number(item.unitPrice),
  }));
  if (JSON.stringify(storedItems) !== JSON.stringify(cleanItems)) mismatches.push('lineItems');

  const requestedNote = args.businessNote ? String(args.businessNote).slice(0, 500) : null;
  if ((invoice.businessNote || null) !== requestedNote) mismatches.push('businessNote');

  const requestedTax = normalizeTaxIntent(args.taxLines);
  if (requestedTax !== null) {
    const storedTax = (invoice.taxLines || []).map((tax) => ({
      name: String(tax.name || '').trim(),
      type: String(tax.type || '').toUpperCase(),
      value: Number(tax.value),
    }));
    if (JSON.stringify(storedTax) !== JSON.stringify(requestedTax)) mismatches.push('taxLines');
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
