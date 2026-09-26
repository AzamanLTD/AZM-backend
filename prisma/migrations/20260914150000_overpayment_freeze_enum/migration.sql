-- Discovery Sprint follow-up (2026-09-14): flagOverpayment (services/p2p.service.js,
-- Phase H11 idempotency lock) has always written TransactionHistory rows with
-- type = 'OVERPAYMENT_FREEZE', but that value was never added to the
-- TransactionType enum. On a real Postgres database the insert fails the enum
-- constraint and the ENTIRE overpayment-freeze transaction rolls back —
-- flagOverpayment can never commit. Additive fix: add the missing enum value.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'OVERPAYMENT_FREEZE';
