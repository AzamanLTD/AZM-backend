# Retail checkout integrity

This document records the contract implemented by the accumulated retail checkout batch.

## Checkout boundary

`POST /api/storefront/:businessProfileId/checkout` remains the canonical order-creation endpoint. The integrity boundary is mounted immediately before the existing storefront router so the existing pricing, escrow, notification, analytics, and order transaction remain the single financial implementation.

Production checkout is fail-closed until the boot-time schema convergence guard reports ready. This matters because the deployed environment currently uses `prisma db push`; the Prisma schema can otherwise recreate the legacy global idempotency uniqueness constraint after an additive migration.

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

The runtime convergence installer repeats the critical DDL after `db push`, and the readiness gate blocks checkout until that installer succeeds. This prevents a partially converged production database from accepting financial checkout traffic.

## Variant snapshots

Selected variants are persisted as JSONB on `BusinessOrderItem`. The snapshot is immutable checkout metadata: product pricing and availability remain server-authoritative, while the exact customer selection is retained for fulfillment, customer history, and dispute evidence.

## Inventory authority

Tracked products (`stockQty IS NOT NULL`) are reserved atomically when an order line is inserted. The database row is locked during the reservation, so concurrent checkouts cannot both consume the same stock. An insufficient-stock reservation aborts the enclosing checkout transaction.

When an order transitions into `CANCELLED` or `REFUNDED`, its outstanding stock reservations are returned exactly once. Untracked products remain unchanged. This keeps inventory authority in the backend/database rather than trusting the client cart.

## Order history

The customer-facing frontend already uses the `/me/orders` contract, so the backend provides it directly:

- `GET /api/storefront/me/orders?limit=20&status=PAID&cursor=...`
- `GET /api/storefront/me/orders/:orderId`

The list is cursor-paginated and supports the canonical `BusinessOrderStatus` values. Invalid filters/cursors are rejected rather than silently falling back to the first page. Both endpoints scope queries to the authenticated customer ID, so an order ID alone cannot be used to retrieve another customer's order.

Business-scoped equivalents are also available:

- `GET /api/storefront/:businessProfileId/orders`
- `GET /api/storefront/:businessProfileId/orders/:orderId`

All order-history responses include complete multi-item line items and their persisted variant snapshots.

## Deployment convergence

The historical migrations remain the source-of-record for database evolution:

- `prisma/migrations/20260829_retail_checkout_integrity/migration.sql`
- `prisma/migrations/20260829_retail_inventory_reservations/migration.sql`

`infra/install-retail-checkout-integrity.js` mirrors the required additive/repair statements because production currently converges with `prisma db push`. The installer is executed during boot and the checkout readiness gate fails closed until it succeeds.
