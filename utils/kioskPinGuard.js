'use strict';

// r34/E — KIOSK PIN ATTEMPT GUARD (interim, in-memory).
//
// The kiosk credential is the employee PIN. A PIN verification surface
// without an attempt ceiling is brute-forceable, so failed attempts are
// counted and locked out. This mirrors the repo's other interim in-memory
// guards (OTP/rate-limit TODO): it is per-process, which is acceptable for
// the kiosk because a kiosk device authenticates against one backend
// process; moving it to Redis alongside the OTP migration is tracked debt
// (see audit docs).
//
// Two lock spaces exist:
//   • /kiosk/pin-auth   — the caller supplies a PIN and the employee is
//     discovered by comparing against the business's active PIN holders:
//     the lock key is the BUSINESS (an attacker cannot target one employee
//     there, so the whole PIN space of the business locks together).
//   • /kiosk/clock-in|clock-out — the caller names a specific employee: the
//     lock key is that EMPLOYEE, so abuse never locks out colleagues.

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

// key -> { count, lockedUntil }
const attempts = new Map();

function keyOf(businessProfileId, subject) {
    return `${businessProfileId}:${subject}`;
}

function isLocked(businessProfileId, subject) {
    const a = attempts.get(keyOf(businessProfileId, subject));
    return Boolean(a && a.count >= MAX_FAILURES && Date.now() < a.lockedUntil);
}

// Throws a guard error carrying statusCode 429 when locked out.
function assertNotLocked(businessProfileId, subject) {
    if (isLocked(businessProfileId, subject)) {
        const err = new Error('Too many failed PIN attempts — try again later.');
        err.statusCode = 429;
        err.code = 'KIOSK_PIN_LOCKED';
        throw err;
    }
}

function recordFailure(businessProfileId, subject) {
    const key = keyOf(businessProfileId, subject);
    const a = attempts.get(key) || { count: 0, lockedUntil: 0 };
    a.count += 1;
    if (a.count >= MAX_FAILURES) a.lockedUntil = Date.now() + LOCK_MS;
    attempts.set(key, a);
}

function recordSuccess(businessProfileId, subject) {
    attempts.delete(keyOf(businessProfileId, subject));
}

// Test hook.
function __reset() {
    attempts.clear();
}

module.exports = { assertNotLocked, recordFailure, recordSuccess, isLocked, __reset, MAX_FAILURES };
