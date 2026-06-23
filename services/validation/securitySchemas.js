// services/validation/securitySchemas.js
// =============================================================================
// Zod schemas for the authenticated security surface (/api/security): change
// password, 2FA verify/disable, PIN set/verify, and phone OTP send/verify.
//
// BEHAVIOUR-PRESERVING PORT:
//   Each schema reproduces ONLY the body-shape checks its controller performs
//   BEFORE any DB or business logic, in the same order and with the exact same
//   message. DB-dependent checks ("User not found", "2FA already enabled",
//   "Current password is incorrect", SMS-service availability, etc.) stay in the
//   controller — they cannot live in a request schema and must not change.
//
//   Wired with the `singleMessage` formatter so a rejection is byte-identical to
//   each endpoint's existing `return res.status(400).json({ success:false,
//   message:'…' })`. Controllers keep their inline checks, so the schema is a
//   redundant edge guard and can never reject something the controller accepts.
//
// superRefine + early return: the controllers `return` on the first failed
// check. Returning out of the superRefine callback after the first addIssue
// reproduces that exactly, so issues[0] (what singleMessage surfaces) always
// matches the controller's first-failing message. No transforms → req.body is
// passed through untouched.
// =============================================================================
const { z } = require('zod');

const passthrough = () => z.object({}).passthrough();
const isStr = (v) => typeof v === 'string';

// ── CHANGE PASSWORD ──────────────────────────────────────────────────────────
// securityController.changePassword lines 190-216 (pre-DB checks only).
const changePasswordSchema = passthrough().superRefine((data, ctx) => {
  const { currentPassword, newPassword } = data;

  if (!currentPassword || !isStr(currentPassword)) {
    ctx.addIssue({ code: 'custom', path: ['currentPassword'], message: 'Current password is required.' });
    return;
  }
  if (!newPassword || !isStr(newPassword)) {
    ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'New password is required.' });
    return;
  }
  if (newPassword.length < 8) {
    ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'New password must be at least 8 characters long.' });
    return;
  }
  if (newPassword === currentPassword) {
    ctx.addIssue({ code: 'custom', path: ['newPassword'], message: 'New password must be different from the current password.' });
    return;
  }
});

// ── 2FA VERIFY ───────────────────────────────────────────────────────────────
// verify2FA line 49: if (!token) → 'Token is required'.
const verify2FASchema = passthrough().superRefine((data, ctx) => {
  if (!data.token) {
    ctx.addIssue({ code: 'custom', path: ['token'], message: 'Token is required' });
  }
});

// ── 2FA DISABLE ──────────────────────────────────────────────────────────────
// disable2FA line 100: if (!token) → 'Token is required to disable 2FA.'.
const disable2FASchema = passthrough().superRefine((data, ctx) => {
  if (!data.token) {
    ctx.addIssue({ code: 'custom', path: ['token'], message: 'Token is required to disable 2FA.' });
  }
});

// ── SET PIN ──────────────────────────────────────────────────────────────────
// setPin lines 151-157: required, then 4-6 numeric digits.
const setPinSchema = passthrough().superRefine((data, ctx) => {
  const { pin } = data;
  if (!pin) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN is required.' });
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN must be 4-6 numeric digits.' });
  }
});

// ── VERIFY PIN ───────────────────────────────────────────────────────────────
// verifyPin line 338: if (!pin) → 'PIN is required.'.
const verifyPinSchema = passthrough().superRefine((data, ctx) => {
  if (!data.pin) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'PIN is required.' });
  }
});

// ── SEND PHONE OTP ───────────────────────────────────────────────────────────
// sendPhoneOtp lines 385-399: required+string, then E.164 format.
const E164_RE = /^\+[1-9]\d{6,14}$/; // identical to controller
const sendPhoneOtpSchema = passthrough().superRefine((data, ctx) => {
  const { phoneNumber } = data;
  if (!phoneNumber || !isStr(phoneNumber)) {
    ctx.addIssue({ code: 'custom', path: ['phoneNumber'], message: 'phoneNumber is required (E.164 format, e.g. "+233241234567").' });
    return;
  }
  if (!E164_RE.test(phoneNumber)) {
    ctx.addIssue({ code: 'custom', path: ['phoneNumber'], message: 'Invalid phone number format. Use E.164 (e.g. "+233241234567").' });
  }
});

// ── VERIFY PHONE OTP ─────────────────────────────────────────────────────────
// verifyPhoneOtp lines 445-457: phoneNumber required+string, then code required+string.
const verifyPhoneOtpSchema = passthrough().superRefine((data, ctx) => {
  const { phoneNumber, code } = data;
  if (!phoneNumber || !isStr(phoneNumber)) {
    ctx.addIssue({ code: 'custom', path: ['phoneNumber'], message: 'phoneNumber is required.' });
    return;
  }
  if (!code || !isStr(code)) {
    ctx.addIssue({ code: 'custom', path: ['code'], message: 'OTP code is required.' });
  }
});

module.exports = {
  changePasswordSchema,
  verify2FASchema,
  disable2FASchema,
  setPinSchema,
  verifyPinSchema,
  sendPhoneOtpSchema,
  verifyPhoneOtpSchema,
};
