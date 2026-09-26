// __tests__/auth-security-schemas.test.js
// =============================================================================
// Behaviour-preserving coverage for the auth + security Zod hardening.
//
// The whole point of this pass is that adding validate() must NOT change what
// the live Flutter client sees. These tests therefore assert, through the real
// validate() middleware + formatters:
//   • the EXACT error envelope per surface (authList vs singleMessage),
//   • the EXACT messages and ordering ported from each controller,
//   • that valid bodies pass through with req.body unmutated (no transforms),
//   • that the legacy field-map formatter (original 9 callers) is untouched.
//
// Pure unit — no DB, runs everywhere (mirrors zod-schemas.test.js).
// =============================================================================
const express = require('express');
const request = require('supertest');

const { validate, formatters } = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../services/validation/authSchemas');
const sec = require('../services/validation/securitySchemas');

// Build a throwaway app that wires a schema+formatter exactly like the routes,
// with a terminal handler echoing req.body so we can assert non-mutation.
function appFor(schema, formatter) {
  const app = express();
  app.use(express.json());
  app.post('/t', validate(schema, formatter), (req, res) => {
    res.status(200).json({ ok: true, body: req.body });
  });
  return app;
}

// ── AUTH: register/login → authList envelope ─────────────────────────────────
describe('authSchemas — register (authList envelope)', () => {
  const app = appFor(registerSchema, 'authList');

  test('empty body → "Validation failed" + ordered field messages', async () => {
    const res = await request(app).post('/t').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: 'Validation failed',
      errors: [
        'Username is required',
        'Email is required',
        'Password is required',
      ],
    });
  });

  test('one message per field, first-failing rule only (else-if parity)', async () => {
    const res = await request(app).post('/t').send({ username: 'ab', email: 'bad', password: 'short' });
    expect(res.body.errors).toEqual([
      'Username must be at least 3 characters long',
      'Invalid email format',
      'Password must be at least 8 characters long',
    ]);
  });

  test('password complexity message matches controller verbatim', async () => {
    const res = await request(app).post('/t').send({ username: 'good_name', email: 'a@b.co', password: 'alllowercase' });
    expect(res.body.errors).toEqual([
      'Password must contain at least one uppercase letter, one number, and one special character (!@#$%^&*)',
    ]);
  });

  test('valid body passes; req.body unmutated (no trim/lowercase)', async () => {
    // Mixed-case email + username kept verbatim — the schema must NOT normalise
    // (the controller lowercases email / trims username itself, AFTER validating).
    // NB: the controller validates pre-trim, so surrounding spaces in
    // username/email are a genuine rejection there too — see the next test.
    const payload = { username: 'Keeps_Case', email: 'A@B.CO', password: 'Str0ng!pw', phoneNumber: '+1' };
    const res = await request(app).post('/t').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual(payload);
  });

  test('pre-trim parity: surrounding spaces rejected exactly like the controller', async () => {
    // Controller runs validateRegisterInput BEFORE trim, so its username regex
    // (/^[a-zA-Z0-9_]+$/) and email regex reject leading/trailing spaces. The
    // schema reproduces that, surfacing the SAME first-failing messages.
    const res = await request(app).post('/t').send({ username: '  Keeps_Case  ', email: '  a@b.co ', password: 'Str0ng!pw' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      'Username can only contain letters, numbers, and underscores',
      'Invalid email format',
    ]);
  });
});

describe('authSchemas — login (authList envelope)', () => {
  const app = appFor(loginSchema, 'authList');

  test('empty → email+password required', async () => {
    const res = await request(app).post('/t').send({});
    expect(res.body).toEqual({
      success: false,
      message: 'Validation failed',
      errors: ['Email is required', 'Password is required'],
    });
  });

  test('bad email format', async () => {
    const res = await request(app).post('/t').send({ email: 'nope', password: 'x' });
    expect(res.body.errors).toEqual(['Invalid email format']);
  });

  test('valid passes through', async () => {
    const res = await request(app).post('/t').send({ email: 'a@b.co', password: 'anything' });
    expect(res.status).toBe(200);
  });
});

// ── SECURITY: singleMessage envelope ─────────────────────────────────────────
describe('securitySchemas — singleMessage envelope + exact messages', () => {
  const cases = [
    {
      name: 'changePassword: missing current',
      schema: sec.changePasswordSchema, body: {},
      msg: 'Current password is required.',
    },
    {
      name: 'changePassword: missing new',
      schema: sec.changePasswordSchema, body: { currentPassword: 'x' },
      msg: 'New password is required.',
    },
    {
      name: 'changePassword: short new',
      schema: sec.changePasswordSchema, body: { currentPassword: 'x', newPassword: 'short' },
      msg: 'New password must be at least 8 characters long.',
    },
    {
      name: 'changePassword: same as current',
      schema: sec.changePasswordSchema, body: { currentPassword: 'samePass1', newPassword: 'samePass1' },
      msg: 'New password must be different from the current password.',
    },
    {
      name: 'verify2FA: missing token',
      schema: sec.verify2FASchema, body: {},
      msg: 'Token is required',
    },
    {
      name: 'disable2FA: missing token',
      schema: sec.disable2FASchema, body: {},
      msg: 'Token is required to disable 2FA.',
    },
    {
      name: 'setPin: missing',
      schema: sec.setPinSchema, body: {},
      msg: 'PIN is required.',
    },
    {
      name: 'setPin: non-numeric / wrong length',
      schema: sec.setPinSchema, body: { pin: '12ab' },
      msg: 'PIN must be 4-6 numeric digits.',
    },
    {
      name: 'verifyPin: missing',
      schema: sec.verifyPinSchema, body: {},
      msg: 'PIN is required.',
    },
    {
      name: 'sendPhoneOtp: missing',
      schema: sec.sendPhoneOtpSchema, body: {},
      msg: 'phoneNumber is required (E.164 format, e.g. "+233241234567").',
    },
    {
      name: 'sendPhoneOtp: bad format',
      schema: sec.sendPhoneOtpSchema, body: { phoneNumber: '0241234567' },
      msg: 'Invalid phone number format. Use E.164 (e.g. "+233241234567").',
    },
    {
      name: 'verifyPhoneOtp: missing phone',
      schema: sec.verifyPhoneOtpSchema, body: {},
      msg: 'phoneNumber is required.',
    },
    {
      name: 'verifyPhoneOtp: missing code',
      schema: sec.verifyPhoneOtpSchema, body: { phoneNumber: '+233241234567' },
      msg: 'OTP code is required.',
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const res = await request(appFor(c.schema, 'singleMessage')).post('/t').send(c.body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, message: c.msg });
    });
  }

  const valids = [
    { name: 'changePassword', schema: sec.changePasswordSchema, body: { currentPassword: 'oldPass1', newPassword: 'newPass12' } },
    { name: 'verify2FA', schema: sec.verify2FASchema, body: { token: '123456' } },
    { name: 'setPin valid 4', schema: sec.setPinSchema, body: { pin: '1234' } },
    { name: 'setPin valid 6', schema: sec.setPinSchema, body: { pin: '123456' } },
    { name: 'sendPhoneOtp valid E.164', schema: sec.sendPhoneOtpSchema, body: { phoneNumber: '+233241234567' } },
    { name: 'verifyPhoneOtp valid', schema: sec.verifyPhoneOtpSchema, body: { phoneNumber: '+233241234567', code: '000000' } },
  ];
  for (const v of valids) {
    test(`valid passes + body unmutated: ${v.name}`, async () => {
      const res = await request(appFor(v.schema, 'singleMessage')).post('/t').send(v.body);
      expect(res.status).toBe(200);
      expect(res.body.body).toEqual(v.body);
    });
  }
});

// ── Regression guard: legacy default formatter unchanged ─────────────────────
describe('validate() backward compatibility', () => {
  const { z } = require('zod');
  const schema = z.object({ amount: z.coerce.number().positive('Amount must be positive') });

  test('no formatter → original { success:false, errors:{field:[msg]} } shape', async () => {
    const res = await request(appFor(schema)).post('/t').send({ amount: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, errors: { amount: ['Amount must be positive'] } });
  });

  test('coercion still merges over req.body on success', async () => {
    const res = await request(appFor(schema)).post('/t').send({ amount: '42', keepMe: 'yes' });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ amount: 42, keepMe: 'yes' });
  });

  test('formatters export is present', () => {
    expect(typeof formatters.authList).toBe('function');
    expect(typeof formatters.singleMessage).toBe('function');
    expect(typeof formatters.fieldMap).toBe('function');
  });
});
