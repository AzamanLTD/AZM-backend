# Retail checkout integrity

This document records the contract implemented by the accumulated retail checkout batch.

## Checkout boundary

`POST /api/storefront/:businessProfileId/checkout` remains the canonical order-creation endpoint. The integrity boundary is mounted immediately before the existing storefront router so the existing pricing, escrow, notification, analytics, and order transaction remain the single financial implementation.

### Request

```json
{
  "items": [
    {
      "productId": "...",
      "quantity": 1,
      "notes": "optional",
      "variants": { "Size": "Large" }
    }
  ],
  "customerNotes": "optional",
  "deliveryNotes": "optional",
  "paymentMode": "DIRECT",
  "idempotencyKey": "client-generated-key"
}
```

The backend validates every product against the authenticated business, rejects unavailable products, validates quantity bounds, and validates every selected variant dimension/value against the authoritative `BusinessProduct.variants` definition.

## Idempotency

Client keys are never used as global identifiers. The boundary derives a server-scoped key from:

`businessProfileId + authenticated customerId + SHA-256(clientKey)`

A request fingerprint covers product IDs, quantities, notes, variants, payment mode, and checkout notes. Reusing the same key with different cart contents returns `409` instead of silently replaying the wrong order.

The migration enforces a database-level composite uniqueness constraint on `(businessProfileId, customerId, idempotencyKey)`. If concurrent requests race, the legacy transaction's unique violation is converted back into an idempotent response after the losing transaction has rolled back.

## Variant snapshots

Selected variants are persisted as JSONB on `BusinessOrderItem`. The snapshot is immutable checkout metadata: product pricing and availability remain server-authoritative, while the exact customer selection is retained for fulfillment, customer history, and dispute evidence.

## Order history

Customer-scoped endpoints expose complete multi-item orders, including line items and variant snapshots:

- `GET /api/storefront/:businessProfileId/orders`
- `GET /api/storefront/:businessProfileId/orders/:orderId`

Both endpoints enforce the authenticated customer ID and business profile ID in the query, so an order ID alone cannot be used to retrieve another customer's order.

## Migration

`prisma/migrations/20260829_retail_checkout_integrity/migration.sql` adds the request fingerprint, replaces the global idempotency uniqueness constraint with customer/business scope, and adds the order-line variant snapshot column.
