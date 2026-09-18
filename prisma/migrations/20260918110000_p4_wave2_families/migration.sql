-- §P.4 wave 2: escrow/dispute/vendor-unallocated/susu/vault families join the
-- authoritative ledger; provisional custody clearing + fiat off-ramp clearing
-- accounts; custody:provider:usdc reclassified to the canonical ASSET location.
ALTER TYPE "JournalEntryType" ADD VALUE 'ESCROW_DISPUTE';
ALTER TYPE "JournalEntryType" ADD VALUE 'SUSU_SEIZURE';
ALTER TYPE "JournalEntryType" ADD VALUE 'SUSU_REFUND';
ALTER TYPE "JournalEntryType" ADD VALUE 'VENDOR_TOPUP';
ALTER TYPE "JournalEntryType" ADD VALUE 'VENDOR_ALLOCATE';
ALTER TYPE "JournalEntryType" ADD VALUE 'CUSTODY_VERIFICATION';
ALTER TYPE "JournalEntryType" ADD VALUE 'CUSTODY_REJECTION';
