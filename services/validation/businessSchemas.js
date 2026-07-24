// services/validation/businessSchemas.js
// =============================================================================
// Zod schemas for the business-accounts surface (/api/business).
//
// DESIGN RULE — behaviour-preserving hardening:
//   These schemas encode the EXACT validation businessController/businessService
//   already perform, no more and no less. We deliberately do NOT add stricter
//   checks (e.g. .email() on contactEmail, .url() on website) because the live
//   service accepts those as free strings and merely trim/slices them —
//   tightening here would reject payloads the production Flutter client sends
//   today. The win is declarative, tested, consistent error shapes at the route
//   edge (mirroring withdrawalRoutes' validate(fiatWithdrawalSchema)), not new
//   rejections. Controllers keep their own fallback checks.
//
//   Bare z.enum([...]) is used (no custom errorMap) to match the house style in
//   financialSchemas.js and stay on the safe side of the Zod v4 error API.
//
// CRITICAL behavioural difference between the two paths, preserved here:
//   • REGISTER: businessController 400s on an unknown category  → enum-restrict.
//   • UPDATE:   businessService SILENTLY IGNORES an unknown category (it only
//     copies category through when VALID_CATEGORIES.has(value)) and never 400s →
//     so the update schema must accept category as a free string, NOT an enum,
//     or we'd introduce a new 400 the client never used to get.
//
// BUSINESS_CATEGORIES is pinned against services/businessService.VALID_CATEGORIES
// by a regression test so the two cannot silently drift.
// =============================================================================
const logger = require('../../src/config/logger');
const { z } = require('zod');

const BUSINESS_CATEGORIES = [
  'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE',
  'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS',
  'FINANCIAL_SERVICES', 'OTHER',
];

// businessName: trimmed, 2–100 chars (controller 25-27 + service 43-44).
const businessName = z
  .string({ required_error: 'businessName is required.' })
  .trim()
  .min(2, 'businessName must be 2–100 chars.')
  .max(100, 'businessName must be 2–100 chars.');

// description: optional, max 500 (controller 35-37).
const description = z.string().max(500, 'description must be max 500 chars.').optional();

// Free-string passthrough fields — typed but NOT format/length rejected, since
// the service tolerantly slices them. Declared so they're documented and coerced
// to string; .optional() keeps them non-required exactly as today.
const freeString = z.string().optional();

// POST /api/business/register -------------------------------------------------
// category enum-restricted: register DOES 400 on an unknown category today.
const businessRegisterSchema = z.object({
  businessName,
  category: z.enum(BUSINESS_CATEGORIES).optional(),
  description,
  website: freeString,
  logoUrl: freeString,
  phoneNumber: freeString,
  contactEmail: freeString,
  address: freeString,
  country: freeString,
});

// PATCH /api/business/profile -------------------------------------------------
// Partial update. category is a FREE STRING here (see header note): the service
// silently drops unknown categories, so we must not 400 on them. businessName,
// when present, keeps the 2–100 rule the service throws on.
const businessUpdateSchema = z.object({
  businessName: businessName.optional(),
  category: freeString,
  description,
  website: freeString,
  logoUrl: freeString,
  phoneNumber: freeString,
  contactEmail: freeString,
  address: freeString,
  country: freeString,
});

module.exports = {
  BUSINESS_CATEGORIES,
  businessRegisterSchema,
  businessUpdateSchema,
};
