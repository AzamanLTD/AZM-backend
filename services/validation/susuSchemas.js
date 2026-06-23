// services/validation/susuSchemas.js
// =============================================================================
// Zod validation schemas for the Susu overlay endpoints.
//
// Consumed by controllers/susu/susuOverlayController.js via:
//   const parsed = schema.safeParse(req.body);
//   if (!parsed.success) throw new SusuError(..., parsed.error.flatten().fieldErrors);
//
// `safeParse` + `error.flatten().fieldErrors` are the only surface the
// controller touches — both are stable in zod v4, so this is a drop-in
// replacement for the previous hand-rolled validator.
//
// NOTE on contributionUsdc: `z.coerce.number()` turns the inbound string into
// a Number. Every downstream consumer wraps it in `new Prisma.Decimal(...)`
// (services/susuService.js, services/susu/susuInitiation.service.js — the
// latter's JSDoc explicitly accepts {string|number}), so the coercion is safe.
// =============================================================================

const { z } = require('zod');

const E164  = /^\+[1-9]\d{6,14}$/;
const FREQS = ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'];

const inviteEntrySchema = z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('FRIEND'), inviteeUserId: z.number().int().positive() }),
    z.object({ channel: z.literal('PHONE'),  inviteePhone: z.string().regex(E164, 'Must be E.164') }),
    z.object({ channel: z.literal('LINK') }),
]);

const createSusuSchema = z.object({
    name:             z.string().min(3).max(60),
    contributionUsdc: z.coerce.number().positive(),
    frequency:        z.enum(FREQS),
    invites:          z.array(inviteEntrySchema).min(1),
});

const createInviteSchema = z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('FRIEND'), inviteeUserId: z.number().int().positive() }),
    z.object({ channel: z.literal('PHONE'),  inviteePhone: z.string().regex(E164) }),
    z.object({ channel: z.literal('LINK') }),
]);

const acceptContractSchema = z.object({
    contractVersion: z.string().min(1),
    contractHash:    z.string().length(64, 'Must be a 64-char SHA-256 hex string'),
    agreed:          z.literal(true),
});

module.exports = { createSusuSchema, createInviteSchema, acceptContractSchema };
