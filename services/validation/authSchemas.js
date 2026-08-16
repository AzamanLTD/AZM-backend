// services/validation/authSchemas.js
// =============================================================================
// Zod schemas for the public auth surface (/api/auth register + login).
//
// BEHAVIOUR-PRESERVING PORT:
//   These reproduce controllers/authController.js validateRegisterInput /
//   validateLoginInput *branch-for-branch* — same checks, same order, same
//   exact messages. They are wired with the `authList` formatter so a rejection
//   here is byte-identical to the controller's existing
//     { success:false, message:"Validation failed", errors:[ ...msgs ] }.
//   The controllers KEEP their inline validation, so this is a redundant edge
//   guard, never a new behaviour. Validation can therefore never get stricter
//   than today.
//
// WHY superRefine (not field-level z.string().min()):
//   The controller helpers use `else if` chains — only the FIRST failing rule
//   per field yields a message (e.g. a 1-char username reports "at least 3
//   characters", never also the regex error). Field-level Zod would surface
//   multiple issues per field and reorder them. superRefine lets us emit
//   exactly one issue per field, in field order, matching the helper output.
//
// NO TRANSFORMS: we never .trim()/.toLowerCase() in the schema — the controller
// already normalises (email.trim().toLowerCase(), username.trim()) AFTER its
// own validation. validate.js merges result.data over req.body, so emitting
// transformed values here could change what the controller stores. We keep the
// schema side-effect free; req.body passes through untouched.
// =============================================================================
const logger = require('../../src/config/logger');
const { z } = require('zod');

// Shared primitives -----------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;          // identical to controller
const USERNAME_RE = /^[a-zA-Z0-9_]+$/;                  // identical to controller
const SPECIAL_RE = /[!@#$%^&*(),.?":{}|<>]/;            // identical to controller

function pushFirst(ctx, path, message) {
  ctx.addIssue({ code: 'custom', path: [path], message });
}

// ── REGISTER ─────────────────────────────────────────────────────────────────
// Mirrors validateRegisterInput(username, email, password). phoneNumber is read
// by the controller but never validated there, so we leave it untouched.
const registerSchema = z.object({}).passthrough().superRefine((data, ctx) => {
  const { username, email, password } = data;

  // username (controller lines 48-56)
  if (!username || typeof username !== 'string' || username.trim() === '') {
    pushFirst(ctx, 'username', 'Username is required');
  } else if (username.length < 3) {
    pushFirst(ctx, 'username', 'Username must be at least 3 characters long');
  } else if (username.length > 30) {
    pushFirst(ctx, 'username', 'Username must be 30 characters or fewer');
  } else if (!USERNAME_RE.test(username)) {
    pushFirst(ctx, 'username', 'Username can only contain letters, numbers, and underscores');
  }

  // email (controller lines 57-61)
  if (!email || typeof email !== 'string' || email.trim() === '') {
    pushFirst(ctx, 'email', 'Email is required');
  } else if (!EMAIL_RE.test(email)) {
    pushFirst(ctx, 'email', 'Invalid email format');
  }

  // password (controller lines 62-75)
  if (!password || typeof password !== 'string' || password.trim() === '') {
    pushFirst(ctx, 'password', 'Password is required');
  } else if (password.length < 8) {
    pushFirst(ctx, 'password', 'Password must be at least 8 characters long');
  } else {
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = SPECIAL_RE.test(password);
    if (!hasUpper || !hasNumber || !hasSpecial) {
      pushFirst(ctx, 'password', 'Password must contain at least one uppercase letter, one number, and one special character (!@#$%^&*)');
    }
  }
});

// ── LOGIN ────────────────────────────────────────────────────────────────────
// Mirrors validateLoginInput(email, password).
const loginSchema = z.object({}).passthrough().superRefine((data, ctx) => {
  const { email, password } = data;

  if (!email || typeof email !== 'string' || email.trim() === '') {
    pushFirst(ctx, 'email', 'Email is required');
  } else if (!EMAIL_RE.test(email)) {
    pushFirst(ctx, 'email', 'Invalid email format');
  }

  if (!password || typeof password !== 'string' || password.trim() === '') {
    pushFirst(ctx, 'password', 'Password is required');
  }
});

module.exports = { registerSchema, loginSchema };
