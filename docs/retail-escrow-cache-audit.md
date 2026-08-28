# Retail Escrow Cache Audit

The storefront render cache contains the merchant-controlled `escrowProtectionAvailable` capability. Merchant profile updates that toggle `offerEscrowProtection` must invalidate the public storefront render cache so the UI does not remain stale for the cache TTL.
