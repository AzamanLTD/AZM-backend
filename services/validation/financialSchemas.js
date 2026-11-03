// services/validation/financialSchemas.js
// =============================================================================
// Zod schemas for financial route validation.
//
// These are written against the ACTUAL controller request bodies (verified in
// controllers/{deposit,withdrawal,escrow,admin}Controller.js), NOT the idealised
// shapes in the hardening doc. Each schema only declares the fields it needs to
// guard; middleware/validate.js MERGES coerced values over req.body, so any
// extra field a controller reads (feeDiscountTierId, clientRequestId, ...) is
// preserved. Schemas therefore never need to enumerate every optional field.
// =============================================================================
const logger = require('../../src/config/logger');
const { z } = require('zod');

// ── Deposit ─────────────────────────────────────────────────────────────────
// Consumed by POST /api/deposit/fiat/initiate (quoteFiatDepositController.initiate): { amountGhs, provider }.
exports.initiateFiatDepositSchema = z.object({
  amountGhs: z.coerce.number().positive('Amount must be positive'),
  provider:  z.enum(['MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH', 'AIRTELTIGO', 'BANK_TRANSFER']),
});

// ── Withdrawal ────────────────────────────────────────────────────────────────
// fiatWithdrawal reads { amount, payoutMethod, recipientPhone | destination,
// feeDiscountTierId?, savedAccountId? }.
// recipientPhone/destination kept optional (older clients send `destination`);
// the controller still enforces the phone-presence rule. savedAccountId is the
// saved-momo account selected as payout destination (r42 WAVE-2 alias compat:
// the live Flutter app sends it; the controller verifies ownership + isVerified).
// Native-GHS withdrawal leg (issue #389). GHS-only: NO amount in USDC and no
// rate anywhere. `quoteId` is present ONLY when the customer explicitly
// consented to the separate USDC->GHS shortfall quote.
exports.ghsWithdrawalSchema = z.object({
  amountGhs:        z.union([z.string(), z.number()]),
  destination:      z.string().min(9, 'destination must be at least 9 characters').optional(),
  network:          z.string().optional(),
  savedAccountId:   z.string().optional(),
  quoteId:          z.string().optional(),
}).refine((v) => !!(v.destination || v.savedAccountId), {
  message: 'destination or savedAccountId is required',
  path: ['destination'],
});

exports.fiatWithdrawalSchema = z.object({
  amount:           z.coerce.number().positive('Amount must be positive'),
  payoutMethod:     z.string().optional(),
  recipientPhone:   z.string().min(9, 'recipientPhone must be at least 9 digits').optional(),
  destination:      z.string().optional(),
  feeDiscountTierId: z.string().optional(),
  savedAccountId:   z.string().optional(),
});

// cryptoWithdrawal reads { amount, destination, network }. destination is a
// Polygon address (controller checks 0x + 40 hex).
exports.cryptoWithdrawalSchema = z.object({
  amount:      z.coerce.number().positive('Amount must be positive'),
  destination: z.string().regex(
    /^0x[0-9a-fA-F]{40}$/,
    'Invalid Polygon address — must be 0x + 40 hex chars'
  ),
  network:     z.string().optional(),
});

// ── Escrow ────────────────────────────────────────────────────────────────────
// SmartEscrow.id is a String @default(uuid()). fundEscrow reads { escrowId }.
exports.fundEscrowSchema = z.object({
  escrowId: z.string().uuid('escrowId must be a valid UUID'),
});

// raiseDispute reads { escrowId, reason, evidenceUrls? }. Mirrors the
// controller's own checks (non-empty reason, max 1000; up to 5 evidence URLs).
exports.raiseDisputeSchema = z.object({
  escrowId:     z.string().uuid('escrowId must be a valid UUID'),
  reason:       z.string().trim().min(1, 'reason is required').max(1000, 'reason must be max 1000 chars'),
  evidenceUrls: z.array(z.string()).max(5, 'evidenceUrls max 5 items').optional(),
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// approveKyc / rejectKyc read { userId } (+ optional reason on reject).
exports.approveKycSchema = z.object({
  userId: z.coerce.number().int().positive('userId must be a positive integer'),
});
exports.rejectKycSchema = z.object({
  userId: z.coerce.number().int().positive('userId must be a positive integer'),
  reason: z.string().max(500).optional(),
});

// banUser reads { action } from the body (the user id is the :id route param).
// action is the REAL enum the controller switches on — not the doc's "duration".
exports.banUserSchema = z.object({
  action: z.enum(['BAN_24H', 'BAN_1W', 'BAN_INDEF', 'UNBAN']),
  reason: z.string().max(500).optional(),
});

// forceRelease reads { tradeId, adminNotes? }; the controller parseInt()s tradeId,
// so accept it as a string or a number.
exports.forceReleaseSchema = z.object({
  tradeId:    z.union([z.string().min(1), z.number()]),
  adminNotes: z.string().max(1000).optional(),
});

// ── Moolre MoMo PIN-push initiation (added 2026-06-24) ───────────────────────
// Consumed by POST /api/deposit/fiat/initiate/moolre
// (moolreQuoteDepositController.initiate): { amountGhs, provider, phoneNumber,
// memo? }. Only MoMo providers are valid on this endpoint (BANK_TRANSFER is
// not). .passthrough() keeps the optional `memo` (Susu trace) intact; the
// controller's own checks remain as fallback.
const MOMO_PROVIDERS = new Set(['MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH', 'AIRTELTIGO']);

exports.initiateMoolreFiatDepositSchema = z.object({
  amountGhs:   z.coerce.number().positive({ message: 'Amount must be greater than zero.' }),
  provider:    z.string().refine(v => MOMO_PROVIDERS.has(v), {
                 message: 'provider must be MTN_MOMO, TELECEL_CASH, or AIRTELTIGO.',
               }),
  phoneNumber: z.string().min(9, { message: 'A valid phone number is required.' }),
}).passthrough();

// ── Standalone payment requests (POST /api/payment-requests) ──────────────────
// Consumed by controllers/paymentRequestController.create. The amount is an
// EXACT 2-dp GHS decimal STRING ("12.50") — a JSON number is a float and is
// refused by the regex/message here, not silently coerced: money values are
// compared by their exact string form (§r42 exact-decimal discipline).
// recipientUserId is a User account id (string or number accepted on the
// wire; the controller verifies it is NOT a friendship id by requiring an
// integer that matches an existing user).
exports.createPaymentRequestSchema = z.object({
  amount:          z.string({ error: 'amount must be an exact decimal string, e.g. "12.50".' })
                    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'amount must be a positive number with at most two fractional digits, e.g. "12.50".'),
  currency:        z.literal('GHS', { errorMap: () => ({ message: 'currency must be "GHS".' }) }),
  requestMode:     z.enum(['DIRECT', 'LINK']),
  recipientUserId: z.union([z.string().min(1).max(64), z.number()]).optional(),
}).passthrough();

// Saved BANK payout beneficiary (issue #389 section 4). The account number is
// write-only: 6-20 digits, stored encrypted with a separate HMAC fingerprint.
exports.bankBeneficiarySchema = z.object({
  bankCode:      z.string().min(2).max(16),
  bankName:      z.string().min(2).max(80),
  accountNumber: z.string().min(6).max(24),
  accountName:   z.string().max(120).optional(),
  nickname:      z.string().max(40).optional(),
  isPrimary:     z.boolean().optional(),
});

// Bank payout request (issue #389): explicit typed BANK destination. The
// amount is GHS-denominated and exact to the pesewa.
// §P0-2: a BANK shortfall quote is requested for a SAVED, provider-verified
// beneficiary. The client names the beneficiary, never a fingerprint, an account
// number or a snapshot: those are server-derived from the persisted record.
exports.bankWithdrawalQuoteSchema = z.object({
  amountGhs:     z.union([z.string(), z.number()]),
  beneficiaryId: z.string().min(4).max(64),
});

exports.bankWithdrawalSchema = z.object({
  amountGhs:      z.union([z.string(), z.number()]),
  beneficiaryId:  z.string().min(4).max(64),
  quoteId:        z.string().optional(),
  idempotencyKey: z.string().optional(),
});
