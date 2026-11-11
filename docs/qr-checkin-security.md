# QR check-in security posture

**Scope:** `services/qrCheckInService.js`, the reservation and transit check-in
routes, and the startup key gate. This document states what is proven by the
implementation and tests, and what is not.

## 1. Signing key

QR check-in signs and verifies with **`QR_CHECKIN_SIGNING_KEY` only**.

| Rule | Behaviour |
| --- | --- |
| Key source | `process.env.QR_CHECKIN_SIGNING_KEY`. No `JWT_SECRET`, no constant, no dev default. |
| Minimum material | 32 **bytes** (`Buffer.byteLength`, so multi-byte characters count correctly), not 32 characters. |
| Missing or short key | Token issuance and token verification both throw `QrSigningKeyError` before any database read or write. |
| Production boot | `server.js` refuses to start when the key is absent or short (`NODE_ENV=production`). Non-production keeps booting and fails closed per request. |
| Secret in output | Never logged, never included in an error message. Messages name the variable and the byte count only. |
| Tests | `jest.setup.js` injects an explicit test-only key. The production path contains no test fallback. |

**Rotating from `JWT_SECRET`.** Tokens minted before this change were signed with
`JWT_SECRET` and are **invalidated**: verification now uses the dedicated key, so
their signature no longer matches. A customer holding a QR issued before the
deployment must regenerate it, which is a 30-minute-maximum disruption because no
token can outlive 30 minutes anyway. Retaining `JWT_SECRET` as a verification
fallback would have preserved those tokens at the cost of the whole separation,
so no fallback exists.

**Production prerequisite (owner action).** `QR_CHECKIN_SIGNING_KEY` must be
generated (32+ random bytes) and set in the production environment before any
deployment containing this change. Without it the server refuses to boot in
production, and QR check-in fails closed in every other environment.

## 2. Token contract

Payload is `base64url(JSON).hex-hmac-sha256`. Both paths carry `typ`, `iat`,
`exp` and a cryptographically random `jti` (`crypto.randomUUID()`).

| Control | Reservation | Transit |
| --- | --- | --- |
| Dedicated key | yes | yes |
| Signature checked before use | yes | yes |
| Fixed-length hex signature required before `timingSafeEqual` | yes | yes |
| Tampered payload / wrong key rejected | yes | yes |
| Expiry enforced | yes | yes |
| `exp - iat` never exceeds 30 minutes (asserted at verification too) | yes | yes |
| Never outlives its own window | `exp = min(iat+30m, reservation.endDatetime)` | `exp = min(iat+30m, departure+1h)` |
| Window closed at issue | after `endDatetime` | before `departure-1h`, after `departure+1h` |
| Bound to customer | `cid` compared to `reservation.customerId` | `cid` compared to `booking.customerId` |
| Bound to reservation/booking | `rid` | `bid`, plus `tid` compared to `booking.tripId` |
| Bound to business | `businessProfile.userId` | `businessProfile.userId` |
| Wrong target refused | yes | yes |

A QR token is never accepted as an identifier. `transitCheckIn` refuses a string
that has the shape of a token, so a scanner payload cannot be smuggled into a
booking-id lookup.

## 3. One-use guarantee: what is proven, what is not

**Proven (VERIFIED SAFE for one check-in per reservation/booking).** The
transition is a conditional claim:

```sql
UPDATE "Reservation" SET status='CHECKED_IN', ...
 WHERE id = $1 AND status = 'CONFIRMED'          -- updateMany, count must be 1
```

PostgreSQL row locking arbitrates concurrent claims, so exactly one request can
perform the transition. The QR path additionally refuses any use that did not
itself perform the transition: `checkInReservation(..., requireFreshClaim: true)`
throws `RESERVATION_ALREADY_CHECKED_IN` on both the already-checked-in read and
the convergent retry path. Proven by real-PostgreSQL tests: sequential replay
refused, concurrent replay exactly one winner and one refusal, one escrow
release and one release ledger entry.

Transit uses the same shape (`CONFIRMED -> IN_PROGRESS`, `checkedInAt` set),
proven sequentially and concurrently.

**Not proven (NOT PROVEN): per-token JTI consumption.** No durable record says
"this `jti` was spent". The `jti` is generated and is available for correlation,
but it is not consumed anywhere. The guarantee above is
*one check-in per reservation/booking*, enforced by the state machine, which
differs from *one use per token* in one specific case: if a reservation could
return to `CONFIRMED` inside a token's remaining lifetime, the same token would
work again.

Closing that requires an additive schema slot, which this packet is not allowed
to open. The smallest sufficient design:

```prisma
model QrTokenUse {
  id        String   @id @default(uuid())
  jti       String   @unique
  purpose   String   @db.VarChar(32)   // RESERVATION_CHECKIN | TRANSIT_CHECKIN
  subjectId String                     // reservationId | bookingId
  usedBy    Int
  usedAt    DateTime @default(now())
  @@index([purpose, subjectId])
}
```

Consumption is then `INSERT ... ON CONFLICT (jti) DO NOTHING` **inside the same
transaction as the state claim**: `rowsAffected = 0` means the token was already
spent, and the transaction rolls back. That is the only way a unique index can
arbitrate two concurrent uses of the same token regardless of subject state.
Redis is not used and is not required: the document `docs/redis-operating-mode`
records Redis-off single-instance as the current operating mode.

## 4. Branch-level authority: NOT PROVEN

`Reservation.locationId` is nullable, and `BusinessEmployee` carries
`businessProfileId` but **no `locationId`**. Nothing in the authentication or
permission path derives a branch for the signed-in staff member, and the
`Shift` model's `locationId` is a scheduling fact, not an authorisation binding.
So "this staff member may check in reservations at *this* branch" cannot be
evaluated. Only the business-owner check stands, and it is business-wide.

Enforcing branch scope needs, in order:

1. a staff-to-branch binding (`BusinessEmployee.locationId`, or a
   `BusinessLocationMembership` join),
2. a trusted resolver that derives the active branch server-side (for example a
   signed session claim or a `X-Branch-Id` header validated against that
   binding, never a raw body field), and
3. check-in refusing when the reservation's `locationId` is set and differs
   from the resolved branch.

Until then a wrong-branch test cannot be written honestly, and this document
does not claim one exists.

## 5. Test map

`__tests__/qr-checkin-hardening.test.js` (real PostgreSQL) covers: missing key on
generate and verify, production boot refusal, short key, byte-vs-character
measurement, exactly-32-byte key, tampered payload, foreign key, malformed
signature, expiry, over-long lifetime, reservation-window cap, wrong
reservation, wrong customer, wrong business owner, sequential replay, concurrent
replay, manual-path convergence, strict-mode refusal, transit binding, transit
window, transit replay, transit manual path, and the mounted HTTP routes
(reservation round trip and 409 replay, 400 for a malformed signature, 503 when
the key is absent, transit round trip through the routes).
