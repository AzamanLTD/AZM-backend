'use strict';

// =============================================================================
// §r42 — STOREFRONT ORDER DURABLE IDENTITY (shared boundary primitives)
// =============================================================================
// Single source of truth for the storefront order idempotency contract that
// docs/retail-checkout-integrity.md established for POST /checkout and that
// now also covers POST /order:
//
//   • The client key is NEVER used as a global identifier. The durable
//     identity is (businessProfileId, customerId, scopedIdempotencyKey)
//     where the scoped key is `v1:<business>:<user>:sha256(clientKey)` —
//     a key minted by one customer can never address another customer's
//     operation, and a key never crosses businesses.
//   • Every request carries an exact fingerprint (sha256 of the canonical
//     request, stable-key JSON, raw client values — no cosmetic coercion).
//     Persisted on BusinessOrder.idempotencyRequestHash. A replay of the
//     SAME request returns the SAME logical order; ANY materially different
//     reuse of a key fails closed with 409.
//   • The identity is DB-ENFORCED: composite unique on
//     (businessProfileId, customerId, idempotencyKey) — installed by
//     prisma/migrations/20260829_retail_checkout_integrity, mirrored by
//     infra/install-retail-checkout-integrity.js at boot, and declared in
//     prisma/schema.prisma so `prisma db push` converges to the same shape.
//     Concurrent same-identity requests arbitrate on the constraint: one
//     winner; losers converge only via the fingerprint-checked replay path.
// =============================================================================

const crypto = require('crypto');

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scopedIdempotencyKey(businessProfileId, userId, clientKey) {
  return `v1:${businessProfileId}:${userId}:${sha256(String(clientKey)).slice(0, 48)}`;
}

// Cart checkout fingerprint — exact raw client values (order-preserving items,
// variants, notes, payment mode). Byte-identical to the original boundary
// implementation (docs/retail-checkout-integrity.md).
function checkoutFingerprint(body) {
  return sha256(stableJson({
    items: (body.items || []).map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      notes: item.notes ?? null,
      variants: item.variants ?? {},
    })),
    customerNotes: body.customerNotes ?? null,
    deliveryNotes: body.deliveryNotes ?? null,
    paymentMode: String(body.paymentMode || 'DIRECT').toUpperCase(),
  }));
}

// Single-item /order fingerprint — same discipline as the cart fingerprint:
// every parameter that determines the created order, as sent by the client.
function orderFingerprint(body) {
  return sha256(stableJson({
    productId: body.productId,
    quantity: body.quantity,
    customerNotes: body.customerNotes ?? null,
    deliveryNotes: body.deliveryNotes ?? null,
  }));
}

// Find the order that owns this durable identity (business + customer +
// scoped key), with its persisted request fingerprint.
async function findExistingByScopedKey(prisma, businessProfileId, customerId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const rows = await prisma.$queryRaw`
    SELECT id, "orderRef", status, "idempotencyRequestHash"
    FROM "BusinessOrder"
    WHERE "businessProfileId" = ${businessProfileId}
      AND "customerId" = ${customerId}
      AND "idempotencyKey" = ${idempotencyKey}
    LIMIT 1
  `;
  return rows[0] || null;
}

// A found order is an exact replay ONLY if the persisted fingerprint matches
// this request's. A NULL persisted hash (a legacy row that predates
// fingerprints) replays idempotently — those rows predate the scoped-key
// boundary too and are only reachable through their own legacy paths.
const isExactReplay = (existing, requestHash) =>
  !existing.idempotencyRequestHash || existing.idempotencyRequestHash === requestHash;

module.exports = {
  stableJson,
  sha256,
  scopedIdempotencyKey,
  checkoutFingerprint,
  orderFingerprint,
  findExistingByScopedKey,
  isExactReplay,
};
