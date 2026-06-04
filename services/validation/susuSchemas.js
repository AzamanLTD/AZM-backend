// services/validation/susuSchemas.js
// =============================================================================
// Hand-rolled validation schemas for the Susu overlay endpoints. Returns
// a zod-shaped result `{ success: boolean, data?, error? }` so the
// controllers stay agnostic of the validator. (Project does not use zod;
// keeping this dependency-free.)
//
// Each schema's `safeParse(input)` returns:
//   { success: true,  data: <coerced object> }
//   { success: false, error: { flatten: () => { fieldErrors: { name: [msg] } } } }
// =============================================================================

function ok(data) {
  return { success: true, data };
}
function fail(fieldErrors) {
  return {
    success: false,
    error: {
      flatten: () => ({ fieldErrors }),
    },
  };
}

const E164 = /^\+[1-9]\d{6,14}$/;
const FREQS = new Set(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']);
const CHANNELS = new Set(['FRIEND', 'PHONE', 'LINK']);

const createSusuSchema = {
  safeParse(input) {
    const errors = {};
    if (!input || typeof input !== 'object') return fail({ _: ['Body must be an object.'] });

    const name = input.name;
    if (typeof name !== 'string' || name.length < 3 || name.length > 60) {
      errors.name = ['Name must be a 3..60-character string.'];
    }

    let contributionUsdc = input.contributionUsdc;
    if (contributionUsdc === undefined || contributionUsdc === null) {
      errors.contributionUsdc = ['Required.'];
    } else if (typeof contributionUsdc !== 'string' && typeof contributionUsdc !== 'number') {
      errors.contributionUsdc = ['Must be a number or numeric string.'];
    } else {
      contributionUsdc = String(contributionUsdc);
      if (!/^\d+(\.\d+)?$/.test(contributionUsdc)) {
        errors.contributionUsdc = ['Must be a positive decimal.'];
      }
    }

    const frequency = input.frequency;
    if (!FREQS.has(frequency)) {
      errors.frequency = [`Must be one of ${[...FREQS].join('/')}.`];
    }

    const invites = input.invites;
    if (!Array.isArray(invites)) {
      errors.invites = ['Must be an array.'];
    } else {
      const sub = invites.map((inv, i) => {
        if (!CHANNELS.has(inv?.channel)) return `invites[${i}].channel must be FRIEND/PHONE/LINK`;
        if (inv.channel === 'FRIEND' && typeof inv.inviteeUserId !== 'number')
          return `invites[${i}].inviteeUserId required for FRIEND`;
        if (inv.channel === 'PHONE' && (typeof inv.inviteePhone !== 'string' || !E164.test(inv.inviteePhone)))
          return `invites[${i}].inviteePhone must be E.164`;
        return null;
      }).filter(Boolean);
      if (sub.length) errors.invites = sub;
    }

    if (Object.keys(errors).length) return fail(errors);
    return ok({ name, contributionUsdc, frequency, invites });
  },
};

const createInviteSchema = {
  safeParse(input) {
    const errors = {};
    if (!input || typeof input !== 'object') return fail({ _: ['Body must be an object.'] });
    if (!CHANNELS.has(input.channel)) {
      errors.channel = [`Must be one of ${[...CHANNELS].join('/')}.`];
    }
    if (input.channel === 'FRIEND' && typeof input.inviteeUserId !== 'number') {
      errors.inviteeUserId = ['Required for FRIEND channel and must be a number.'];
    }
    if (input.channel === 'PHONE') {
      if (typeof input.inviteePhone !== 'string' || !E164.test(input.inviteePhone)) {
        errors.inviteePhone = ['Must be a valid E.164 phone number.'];
      }
    }
    if (Object.keys(errors).length) return fail(errors);
    return ok({
      channel: input.channel,
      inviteeUserId: input.inviteeUserId,
      inviteePhone: input.inviteePhone,
    });
  },
};

const acceptContractSchema = {
  safeParse(input) {
    const errors = {};
    if (!input || typeof input !== 'object') return fail({ _: ['Body must be an object.'] });
    if (typeof input.contractVersion !== 'string' || !input.contractVersion) {
      errors.contractVersion = ['Required string.'];
    }
    if (typeof input.contractHash !== 'string' || input.contractHash.length !== 64) {
      errors.contractHash = ['Must be a 64-char SHA-256 hex string.'];
    }
    if (input.agreed !== true) {
      errors.agreed = ['Must be exactly true.'];
    }
    if (Object.keys(errors).length) return fail(errors);
    return ok({
      contractVersion: input.contractVersion,
      contractHash: input.contractHash,
      agreed: true,
    });
  },
};

module.exports = {
  createSusuSchema,
  createInviteSchema,
  acceptContractSchema,
};
