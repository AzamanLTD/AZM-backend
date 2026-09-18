-- §P.5-A multi-asset accounting identity: the explicit cross-asset
-- conversion/exchange entry type. A conversion identity + rate and
-- asset-specific legs are required by the ledgerService post() primitive;
-- GHS and USDC quantities are never numerically equated.
ALTER TYPE "JournalEntryType" ADD VALUE IF NOT EXISTS 'ASSET_CONVERSION';
