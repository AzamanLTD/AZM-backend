// jest.setup.js — setupFiles entry: runs in each worker before test modules load.
// Ensures DATABASE_URL and JWT_SECRET are set even when .env.test is absent
// (CI injects via workflow env block; local devs use .env.test).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.test') });

if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL =
        'postgresql://postgres:postgres@localhost:5432/azm_test';
}
if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test_secret_exactly_32_characters_long';
}
// QR check-in has NO production fallback; the suite injects an explicit
// test-only key so the code path is exercised at all. Tests that need the
// fail-closed behaviour delete this variable themselves.
if (!process.env.QR_CHECKIN_SIGNING_KEY) {
    process.env.QR_CHECKIN_SIGNING_KEY = 'test_only_qr_checkin_signing_key!2026-azm';
}
process.env.NODE_ENV = 'test';
