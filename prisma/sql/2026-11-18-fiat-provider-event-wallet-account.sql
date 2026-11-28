-- WP-I trusted-wallet overlay: FiatProviderEvent.walletAccount
--
-- WHY: Moolre's Quickstart states `externalref` is unique PER WALLET, not
-- globally. The v1 observation identity is `moolre|collection|<ref>`, so two
-- different Moolre wallets reusing one externalref collide into a single claim
-- identity, and the wallet that actually received the money is recorded nowhere.
-- Without a column there is no evidence to scope the identity to.
--
-- This file is the SINGLE SOURCE OF TRUTH for the DDL: the release installer and
-- the real-PostgreSQL contract suite both apply THIS file, so they cannot drift.
--
-- Every statement is guarded, so a second run is a no-op. The column is nullable
-- because historical rows genuinely do not know their wallet; NULL means
-- "unknown", never "the default wallet".

ALTER TABLE "FiatProviderEvent"
  ADD COLUMN IF NOT EXISTS "walletAccount" TEXT;

COMMENT ON COLUMN "FiatProviderEvent"."walletAccount" IS
  'Trusted server-side Moolre wallet that received this payment. NULL = unknown, never a default.';

CREATE INDEX IF NOT EXISTS "FiatProviderEvent_walletAccount_idx"
  ON "FiatProviderEvent" ("walletAccount");
