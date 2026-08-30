'use strict';

const crypto = require('crypto');

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Normalize a client-supplied idempotency key without changing its identity. */
function normalizeIdempotencyKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  // An explicitly supplied blank key is malformed input. Only an omitted/null
  // key means the client chose not to use idempotency.
  if (!key) {
    const error = new Error('idempotencyKey must not be empty.');
    error.statusCode = 400;
    throw error;
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    const error = new Error(`idempotencyKey must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.`);
    error.statusCode = 400;
    throw error;
  }
  return key;
}

function normalizeText(value, maxLength = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeQuantity(value) {
  const quantity = parseInt(value, 10);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function normalizeVariants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, val]) => [String(key).trim(), String(val).trim()])
      .filter(([key, val]) => key && val)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeModifierSelections(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean).sort();
}

/**
 * Build a canonical representation of the economic intent sent to storefront
 * checkout. Ordering and object-key ordering are normalized, while variant and
 * modifier selections remain part of the economic identity.
 */
function canonicalizeCheckoutIntent({
  businessProfileId,
  customerId,
  items,
  customerNotes,
  deliveryNotes,
  paymentMode,
}) {
  const canonicalItems = (Array.isArray(items) ? items : [])
    .map(item => ({
      productId: String(item?.productId || '').trim(),
      quantity: normalizeQuantity(item?.quantity),
      notes: normalizeText(item?.notes),
      variantId: item?.variantId == null ? null : String(item.variantId).trim() || null,
      variants: normalizeVariants(item?.variants),
      modifierSelections: normalizeModifierSelections(item?.modifierSelections),
    }))
    .sort((a, b) => {
      const productCompare = a.productId.localeCompare(b.productId);
      if (productCompare !== 0) return productCompare;
      const variantCompare = (a.variantId || '').localeCompare(b.variantId || '');
      if (variantCompare !== 0) return variantCompare;
      const quantityCompare = a.quantity - b.quantity;
      if (quantityCompare !== 0) return quantityCompare;
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });

  return {
    businessProfileId: String(businessProfileId || '').trim(),
    customerId: String(customerId || '').trim(),
    items: canonicalItems,
    customerNotes: normalizeText(customerNotes),
    deliveryNotes: normalizeText(deliveryNotes),
    paymentMode: String(paymentMode || 'DIRECT').trim().toUpperCase(),
  };
}

function fingerprintCheckoutIntent(input) {
  const canonical = canonicalizeCheckoutIntent(input);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  normalizeIdempotencyKey,
  canonicalizeCheckoutIntent,
  fingerprintCheckoutIntent,
};
