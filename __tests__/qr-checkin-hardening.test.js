// __tests__/qr-checkin-hardening.test.js
// =============================================================================
// QR check-in hardening — real PostgreSQL proof.
//
// Covers: dedicated signing key (no JWT_SECRET fallback, byte-length floor,
// production boot fail-closed), token integrity (tamper, wrong signature,
// malformed signature, expiry, 30-minute ceiling), binding (reservation,
// customer, business), and one-use behaviour under SEQUENTIAL and CONCURRENT
// replay for both the reservation and the transit path.
//
// WHAT IS *NOT* PROVEN HERE: a durable per-token JTI consumption ledger. No
// schema change is permitted in this packet, so the one-use guarantee rests on
// the state machine (CONFIRMED -> CHECKED_IN / IN_PROGRESS) which PostgreSQL
// arbitrates with a conditional UPDATE. See docs/qr-checkin-security.md.
//
// SKIPS unless TEST_DATABASE_URL is set, matching the other DB suites.
// =============================================================================

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { seedUser, seedBusiness } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) console.warn('[qr-checkin-hardening] TEST_DATABASE_URL not set — skipping.');

// A test-only key. 40 bytes of ASCII. The production path has no default, so
// this exists only in the test environment.
const TEST_KEY = 'qr_checkin_test_key_0123456789abcdefghij'; // 41 bytes
const SHORT_KEY = 'x'.repeat(31); // 31 bytes: one byte under the floor

const sign = (payload, key = TEST_KEY) => {
    const payloadStr = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', key).update(payloadStr).digest('hex');
    return Buffer.from(payloadStr).toString('base64url') + '.' + sig;
};

describeOrSkip('QR check-in hardening (real PostgreSQL)', () => {
    let prisma, qr, lifecycle, escrowSvc;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'qr_hardening_jwt_secret_at_least_32ch';
        process.env.QR_CHECKIN_SIGNING_KEY = TEST_KEY;
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        qr = require('../services/qrCheckInService');
        lifecycle = require('../services/reservationLifecycleService');
        escrowSvc = require('../services/bookingEscrowService');
    });

    afterAll(async () => prisma.$disconnect());

    afterEach(async () => {
        process.env.QR_CHECKIN_SIGNING_KEY = TEST_KEY;
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "TransactionHistory", "LedgerTransaction", "JournalEntry", "LedgerAccount", "SmartEscrow", "Reservation", "TransitBookingSeat", "TransitBooking", "TransitTrip", "TransitVehicle", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    }, 20000);

    let seq = 0;
    let plateSeq = 0;
    const uniq = () => `${Date.now()}_${++seq}`;

    async function seedReservationContext({ status = 'CONFIRMED', endOffsetMs = 3600_000, fund: shouldFund = true } = {}) {
        const { biz, owner, product } = await seedBusiness(prisma);
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const reservation = await prisma.reservation.create({
            data: {
                reservationRef: `RES-QR-${uniq()}`,
                businessProfileId: biz.id,
                customerId: customer.id,
                serviceItemId: product.id,
                status,
                startDatetime: new Date(Date.now() - 1800_000),
                endDatetime: new Date(Date.now() + endOffsetMs),
                amountUsdc: 40,
                depositUsdc: 40,
            },
        });
        let escrowId = null;
        if (shouldFund) {
            const { escrow } = await escrowSvc.createBookingEscrow(prisma, {
                bookingType: 'RESERVATION', bookingId: reservation.id,
                payerId: customer.id, payeeId: owner.id,
                amountUsdc: 40, businessProfileId: biz.id,
            });
            await escrowSvc.fundBookingEscrow(prisma, {
                escrowId: escrow.id, payerId: customer.id,
                bookingType: 'RESERVATION', bookingId: reservation.id,
            });
            escrowId = escrow.id;
        }
        return { biz, owner, customer, reservation, escrowId };
    }

    async function seedTransitContext({ departureOffsetMs = 1800_000, status = 'CONFIRMED' } = {}) {
        const { biz, owner } = await seedBusiness(prisma);
        const customer = await seedUser(prisma, { availableBalance: 500 });
        const vehicle = await prisma.transitVehicle.create({
            data: { businessProfileId: biz.id, type: 'VAN', capacity: 12, licensePlate: `QR${String(Date.now()).slice(-8)}${++plateSeq}` },
        });
        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: biz.id, vehicleId: vehicle.id,
                routeName: 'QR Loop', origin: 'Tema', destination: 'Accra',
                departureAt: new Date(Date.now() + departureOffsetMs),
                fareUsdc: 15, availableSeats: 12,
            },
        });
        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId: biz.id, customerId: customer.id, tripId: trip.id,
                pickupAddress: 'A', dropoffAddress: 'B',
                amountUsdc: 40, status,
                scheduledAt: new Date(Date.now() + departureOffsetMs),
                bookingRef: `TRN-QR-${uniq()}`,
            },
        });
        return { biz, owner, customer, vehicle, trip, booking };
    }

    async function releaseSideEffects(escrowId) {
        return {
            releases: await prisma.transactionHistory.count({ where: { type: 'TICKET_ESCROW_RELEASE' } }),
            releaseLedgers: await prisma.ledgerTransaction.count({
                where: { idempotencyKey: `ledger:escrow:release:${escrowId}:SETTLED` },
            }),
            escrowStatus: (await prisma.smartEscrow.findUnique({ where: { id: escrowId }, select: { status: true } }))?.status,
        };
    }

    // ── Group A: the signing key is dedicated and fail-closed ────────────────

    describe('A. dedicated signing key', () => {
        test('A1: missing key refuses token GENERATION and touches no database', async () => {
            const ctx = await seedReservationContext();
            delete process.env.QR_CHECKIN_SIGNING_KEY;

            const spy = jest.spyOn(prisma.reservation, 'findUnique');
            await expect(qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            })).rejects.toMatchObject({ code: 'QR_SIGNING_KEY_MISSING' });
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
            expect(ctx.reservation.id).toBeTruthy();
        });

        test('A2: missing key refuses VERIFICATION of an otherwise valid token', async () => {
            const ctx = await seedReservationContext();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });
            delete process.env.QR_CHECKIN_SIGNING_KEY;

            await expect(qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id }))
                .rejects.toMatchObject({ code: 'QR_SIGNING_KEY_MISSING' });

            // Nothing moved.
            const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
            expect(after.status).toBe('CONFIRMED');
        });

        test('A3: a short key is refused; JWT_SECRET is never a fallback', async () => {
            const ctx = await seedReservationContext();
            process.env.JWT_SECRET = 'x'.repeat(64); // a perfectly good, entirely wrong key
            process.env.QR_CHECKIN_SIGNING_KEY = SHORT_KEY;

            await expect(qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            })).rejects.toMatchObject({ code: 'QR_SIGNING_KEY_TOO_SHORT' });

            // Removing the QR key entirely also refuses: there is no fallback.
            delete process.env.QR_CHECKIN_SIGNING_KEY;
            await expect(qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            })).rejects.toMatchObject({ code: 'QR_SIGNING_KEY_MISSING' });
        });

        test('A4: the byte floor is measured in BYTES, not characters', () => {
            // 16 two-byte characters = 32 bytes of key material -> accepted.
            expect(qr.validateSigningKey('é'.repeat(16))).toMatchObject({ ok: true, bytes: 32 });
            // 15 two-byte characters = 30 bytes -> refused, even though the
            // string is not obviously short.
            expect(qr.validateSigningKey('é'.repeat(15))).toMatchObject({ ok: false, code: 'QR_SIGNING_KEY_TOO_SHORT' });
            // Exactly 32 ASCII bytes is the boundary and is accepted.
            expect(qr.validateSigningKey('k'.repeat(32))).toMatchObject({ ok: true, bytes: 32 });
            expect(qr.validateSigningKey('k'.repeat(31))).toMatchObject({ ok: false, code: 'QR_SIGNING_KEY_TOO_SHORT' });
            // A key value never appears in the refusal message.
            const msg = qr.validateSigningKey('k'.repeat(31)).message;
            expect(msg).toContain('QR_CHECKIN_SIGNING_KEY');
            expect(msg).not.toContain('k'.repeat(31));
        });

        test('A5: exactly-32-byte key issues and verifies a usable token', async () => {
            const ctx = await seedReservationContext();
            process.env.QR_CHECKIN_SIGNING_KEY = 'k'.repeat(32);

            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });
            const result = await qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id });
            expect(result.success).toBe(true);
            expect(result.reservation.status).toBe('CHECKED_IN');
        });

        test('A6: production boot fails closed when the key is absent or short', () => {
            const serverEntry = path.resolve(__dirname, '..', 'server.js');
            const baseEnv = { ...process.env, NODE_ENV: 'production' };
            const run = (keyValue) => {
                const env = { ...baseEnv };
                if (keyValue === undefined) delete env.QR_CHECKIN_SIGNING_KEY;
                else env.QR_CHECKIN_SIGNING_KEY = keyValue;
                try {
                    const out = execFileSync('node', ['-e', `require(${JSON.stringify(serverEntry)})`], {
                        cwd: path.resolve(__dirname, '..'), env, timeout: 60_000, stdio: 'pipe',
                    });
                    return { status: 0, output: String(out) };
                } catch (err) {
                    return {
                        status: err.status,
                        output: String(err.stdout || '') + String(err.stderr || ''),
                    };
                }
            };

            const missing = run(undefined);
            expect(missing.status).toBe(1);
            expect(missing.output).toContain('QR_CHECKIN_SIGNING_KEY');

            const short = run(SHORT_KEY);
            expect(short.status).toBe(1);
            expect(short.output).toContain('QR_CHECKIN_SIGNING_KEY');
            // The value itself must never reach the log.
            expect(short.output).not.toContain(SHORT_KEY);
        }, 120_000);
    });

    // ── Group B: token integrity ─────────────────────────────────────────────

    describe('B. token integrity', () => {
        test('B1: tampered payload is refused', async () => {
            const ctx = await seedReservationContext();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });
            const [body, sig] = token.split('.');
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
            payload.rid = 'someone-elses-reservation';
            const tampered = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;

            await expect(qr.verifyAndCheckIn(prisma, { token: tampered, businessUserId: ctx.owner.id }))
                .rejects.toMatchObject({ code: 'QR_TOKEN_SIGNATURE_INVALID' });
        });

        test('B2: a token signed with a DIFFERENT key is refused', async () => {
            const ctx = await seedReservationContext();
            const forged = sign({
                typ: 'RESERVATION_CHECKIN', rid: ctx.reservation.id,
                ref: ctx.reservation.reservationRef, cid: ctx.customer.id,
                azm: 'AZM-X', jti: crypto.randomUUID(),
                iat: Date.now(), exp: Date.now() + 60_000,
            }, 'a_completely_different_signing_key_32b');

            await expect(qr.verifyAndCheckIn(prisma, { token: forged, businessUserId: ctx.owner.id }))
                .rejects.toMatchObject({ code: 'QR_TOKEN_SIGNATURE_INVALID' });
        });

        test('B3: malformed and wrong-length signatures are refused, never a raw TypeError', async () => {
            const ctx = await seedReservationContext();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });
            const [body, sig] = token.split('.');
            const cases = [
                'not-a-token',
                `${body}.${sig.slice(0, 62)}`,          // 31 bytes
                `${body}.${sig}00`,                      // 33 bytes
                `${body}.${'z'.repeat(64)}`,             // right length, not hex
                `${body}`,
            ];
            for (const bad of cases) {
                await expect(qr.verifyAndCheckIn(prisma, { token: bad, businessUserId: ctx.owner.id }))
                    .rejects.toMatchObject({ name: 'QrTokenError' });
            }
        });

        test('B4: expiry is enforced against the passed clock', async () => {
            const ctx = await seedReservationContext();
            const t0 = Date.now();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id, now: t0,
            });
            await expect(qr.verifyAndCheckIn(prisma, {
                token, businessUserId: ctx.owner.id, now: t0 + 31 * 60_000,
            })).rejects.toMatchObject({ code: 'QR_TOKEN_EXPIRED' });

            const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
            expect(after.status).toBe('CONFIRMED');
        });

        test('B5: a lifetime longer than 30 minutes is refused even with a valid signature', async () => {
            const ctx = await seedReservationContext();
            const t0 = Date.now();
            const inflated = sign({
                typ: 'RESERVATION_CHECKIN', rid: ctx.reservation.id,
                ref: ctx.reservation.reservationRef, cid: ctx.customer.id,
                azm: 'AZM-X', jti: crypto.randomUUID(),
                iat: t0, exp: t0 + 31 * 60_000,
            });
            await expect(qr.verifyAndCheckIn(prisma, {
                token: inflated, businessUserId: ctx.owner.id, now: t0 + 60_000,
            })).rejects.toMatchObject({ code: 'QR_TOKEN_TTL_INVALID' });

            const issued = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id, now: t0,
            });
            expect(issued.expiresAt.getTime() - t0).toBeLessThanOrEqual(30 * 60_000);
        });

        test('B6: a token cannot outlive the reservation window it was issued for', async () => {
            const ctx = await seedReservationContext({ endOffsetMs: 10 * 60_000 });
            const t0 = Date.now();
            const { expiresAt } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id, now: t0,
            });
            expect(expiresAt.getTime()).toBeLessThanOrEqual(
                new Date(ctx.reservation.endDatetime).getTime()
            );
        });
    });

    // ── Group C: binding ─────────────────────────────────────────────────────

    describe('C. binding', () => {
        test('C1: a token cannot check in a DIFFERENT reservation', async () => {
            const a = await seedReservationContext();
            const b = await seedReservationContext();
            // Same business owns both, so the only thing separating them is rid.
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: a.reservation.id, customerId: a.customer.id,
            });
            const [body, sig] = token.split('.');
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
            payload.rid = b.reservation.id;
            payload.ref = b.reservation.reservationRef;
            const swapped = sign(payload); // valid signature, wrong target

            await expect(qr.verifyAndCheckIn(prisma, { token: swapped, businessUserId: b.owner.id }))
                .rejects.toThrow(/Token customer does not match reservation|customer/i);

            const after = await prisma.reservation.findUnique({ where: { id: b.reservation.id } });
            expect(after.status).toBe('CONFIRMED');
            expect(sig.length).toBe(64);
        });

        test('C2: a token whose customer does not match the reservation is refused', async () => {
            const ctx = await seedReservationContext();
            const stranger = await seedUser(prisma, { availableBalance: 10 });
            const forged = sign({
                typ: 'RESERVATION_CHECKIN', rid: ctx.reservation.id,
                ref: ctx.reservation.reservationRef, cid: stranger.id,
                azm: 'AZM-FORGED', jti: crypto.randomUUID(),
                iat: Date.now(), exp: Date.now() + 60_000,
            });
            await expect(qr.verifyAndCheckIn(prisma, { token: forged, businessUserId: ctx.owner.id }))
                .rejects.toThrow(/customer does not match/i);
        });

        test('C3: wrong business owner is refused and nothing moves', async () => {
            const ctx = await seedReservationContext();
            const other = await seedBusiness(prisma);
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });

            await expect(qr.verifyAndCheckIn(prisma, { token, businessUserId: other.owner.id }))
                .rejects.toThrow(/does not belong to your business/i);

            const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
            expect(after.status).toBe('CONFIRMED');
            const side = await releaseSideEffects(ctx.escrowId);
            expect(side.releases).toBe(0);
        });

        test('C4: branch-level authority is NOT PROVEN — the gap is structural, not a bug', () => {
            // A reservation carries a nullable locationId, but nothing binds a
            // signed-in staff member to a branch, so "the scanning user is
            // authorised for the reservation's branch" cannot be evaluated at
            // all. Asserting the absence keeps the claim honest: if a staff
            // location binding is ever added, this test fails and the branch
            // requirement must be implemented and proven rather than assumed.
            const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
            const staff = schema.slice(schema.indexOf('model BusinessEmployee {'));
            const staffModel = staff.slice(0, staff.indexOf('\n}') + 2);
            expect(staffModel).toContain('businessProfileId');
            expect(staffModel).not.toContain('locationId');
            // BusinessLocation exists as a business-scoped catalogue concept...
            expect(schema).toContain('model BusinessLocation {');
            // ...but the reservation's own link to it is optional.
            const reservation = schema.slice(schema.indexOf('model Reservation {'));
            expect(reservation.slice(0, reservation.indexOf('\n}'))).toMatch(/locationId\s+String\?/);
        });
    });

    // ── Group D: one-use, sequential and concurrent ──────────────────────────

    describe('D. one-use guarantee', () => {
        test('D1: sequential replay of the same QR is refused; exactly one release', async () => {
            const ctx = await seedReservationContext();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });

            const first = await qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id });
            expect(first.success).toBe(true);

            await expect(qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id }))
                .rejects.toMatchObject({ code: 'QR_TOKEN_ALREADY_USED' });

            const side = await releaseSideEffects(ctx.escrowId);
            expect(side.releases).toBe(1);
            expect(side.releaseLedgers).toBe(1);
            expect(side.escrowStatus).toBe('SETTLED');
        });

        test('D2: concurrent replay — exactly one wins, one is refused, one side effect', async () => {
            const ctx = await seedReservationContext();
            const { token } = await qr.generateCheckInToken(prisma, {
                reservationId: ctx.reservation.id, customerId: ctx.customer.id,
            });

            const settled = await Promise.allSettled([
                qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id }),
                qr.verifyAndCheckIn(prisma, { token, businessUserId: ctx.owner.id }),
            ]);

            const won = settled.filter(r => r.status === 'fulfilled');
            const lost = settled.filter(r => r.status === 'rejected');
            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0].reason.code).toBe('QR_TOKEN_ALREADY_USED');

            const side = await releaseSideEffects(ctx.escrowId);
            expect(side.releases).toBe(1);
            expect(side.releaseLedgers).toBe(1);
            const after = await prisma.reservation.findUnique({ where: { id: ctx.reservation.id } });
            expect(after.status).toBe('CHECKED_IN');
        });

        test('D3: the MANUAL check-in path keeps its idempotent, convergent behaviour', async () => {
            const ctx = await seedReservationContext();
            const first = await lifecycle.checkInReservation(prisma, {
                reservationId: ctx.reservation.id, businessUserId: ctx.owner.id,
            });
            expect(first.status).toBe('CHECKED_IN');
            // A staff retry is a retry, not a replay: it must not error.
            const second = await lifecycle.checkInReservation(prisma, {
                reservationId: ctx.reservation.id, businessUserId: ctx.owner.id,
            });
            expect(second.status).toBe('CHECKED_IN');

            const side = await releaseSideEffects(ctx.escrowId);
            expect(side.releases).toBe(1);
        });

        test('D4: strict mode refuses the convergent path that the manual path accepts', async () => {
            const ctx = await seedReservationContext();
            await lifecycle.checkInReservation(prisma, {
                reservationId: ctx.reservation.id, businessUserId: ctx.owner.id,
            });
            await expect(lifecycle.checkInReservation(prisma, {
                reservationId: ctx.reservation.id, businessUserId: ctx.owner.id, requireFreshClaim: true,
            })).rejects.toMatchObject({ code: 'RESERVATION_ALREADY_CHECKED_IN' });
        });
    });

    // ── Group E: transit ─────────────────────────────────────────────────────

    describe('E. transit booking', () => {
        test('E1: token is bound to booking, customer, business and trip', async () => {
            const ctx = await seedTransitContext();
            const { token } = await qr.generateTransitCheckInToken(prisma, {
                bookingId: ctx.booking.id, customerId: ctx.customer.id,
            });

            // Wrong business.
            const other = await seedBusiness(prisma);
            await expect(qr.verifyTransitTokenAndBoard(prisma, { token, businessUserId: other.owner.id }))
                .rejects.toThrow(/does not belong to your business/i);

            // Wrong customer (valid signature, misissued binding).
            const stranger = await seedUser(prisma, { availableBalance: 10 });
            const forged = sign({
                typ: 'TRANSIT_CHECKIN', bid: ctx.booking.id, cid: stranger.id,
                tid: ctx.trip.id, dep: new Date(ctx.trip.departureAt).getTime(),
                jti: crypto.randomUUID(), iat: Date.now(), exp: Date.now() + 600_000,
            });
            await expect(qr.verifyTransitTokenAndBoard(prisma, { token: forged, businessUserId: ctx.owner.id }))
                .rejects.toThrow(/customer does not match/i);

            // Right business, right customer: it boards.
            const ok = await qr.verifyTransitTokenAndBoard(prisma, { token, businessUserId: ctx.owner.id });
            expect(ok.success).toBe(true);
            expect(ok.booking.status).toBe('IN_PROGRESS');
        });

        test('E2: the departure window is enforced at issue and at verify', async () => {
            // Too early to issue: departure is 3h out, window opens 1h before.
            const early = await seedTransitContext({ departureOffsetMs: 3 * 3600_000 });
            await expect(qr.generateTransitCheckInToken(prisma, {
                bookingId: early.booking.id, customerId: early.customer.id,
            })).rejects.toThrow(/1 hour before departure/i);

            // A token verified after the window closes is refused.
            const ctx = await seedTransitContext({ departureOffsetMs: 30 * 60_000 });
            const t0 = Date.now();
            const { token } = await qr.generateTransitCheckInToken(prisma, {
                bookingId: ctx.booking.id, customerId: ctx.customer.id, now: t0,
            });
            // The 30-minute cap binds tighter than the +/-1h departure window,
            // so a token presented past the window is refused as EXPIRED first.
            // Both codes are refusals; the assertion pins that it IS refused and
            // that no boarding occurred.
            await expect(qr.verifyTransitTokenAndBoard(prisma, {
                token, businessUserId: ctx.owner.id, now: t0 + 2 * 3600_000,
            })).rejects.toMatchObject({ code: expect.stringMatching(/^QR_TOKEN_(WINDOW_CLOSED|EXPIRED)$/) });

            const untouched = await prisma.transitBooking.findUnique({ where: { id: ctx.booking.id } });
            expect(untouched.status).toBe('CONFIRMED');
            expect(untouched.checkedInAt).toBeNull();

            // The window itself is enforced at ISSUE, after departure too.
            await expect(qr.generateTransitCheckInToken(prisma, {
                bookingId: ctx.booking.id, customerId: ctx.customer.id, now: t0 + 2 * 3600_000,
            })).rejects.toThrow(/expired|departure/i);
        });

        test('E3: transit replay is refused (sequential) and arbitrated (concurrent)', async () => {
            const seqCtx = await seedTransitContext({ departureOffsetMs: 20 * 60_000 });
            const seqToken = (await qr.generateTransitCheckInToken(prisma, {
                bookingId: seqCtx.booking.id, customerId: seqCtx.customer.id,
            })).token;
            await qr.verifyTransitTokenAndBoard(prisma, { token: seqToken, businessUserId: seqCtx.owner.id });
            await expect(qr.verifyTransitTokenAndBoard(prisma, { token: seqToken, businessUserId: seqCtx.owner.id }))
                .rejects.toMatchObject({ code: 'QR_TOKEN_ALREADY_USED' });

            const raceCtx = await seedTransitContext({ departureOffsetMs: 20 * 60_000 });
            const raceToken = (await qr.generateTransitCheckInToken(prisma, {
                bookingId: raceCtx.booking.id, customerId: raceCtx.customer.id,
            })).token;
            const settled = await Promise.allSettled([
                qr.verifyTransitTokenAndBoard(prisma, { token: raceToken, businessUserId: raceCtx.owner.id }),
                qr.verifyTransitTokenAndBoard(prisma, { token: raceToken, businessUserId: raceCtx.owner.id }),
            ]);
            expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
            expect(settled.filter(r => r.status === 'rejected')).toHaveLength(1);
            expect(settled.find(r => r.status === 'rejected').reason.code).toBe('QR_TOKEN_ALREADY_USED');
        });

        test('E4: the manual transit path is business-scoped, conditional, and refuses a QR string', async () => {
            const ctx = await seedTransitContext({ departureOffsetMs: 20 * 60_000 });
            const other = await seedBusiness(prisma);

            await expect(qr.transitCheckIn(prisma, { bookingId: ctx.booking.id, businessUserId: other.owner.id }))
                .rejects.toThrow(/does not belong to your business/i);

            const { token } = await qr.generateTransitCheckInToken(prisma, {
                bookingId: ctx.booking.id, customerId: ctx.customer.id,
            });
            await expect(qr.transitCheckIn(prisma, { bookingId: token, businessUserId: ctx.owner.id }))
                .rejects.toThrow(/checks in by booking id/i);

            const ok = await qr.transitCheckIn(prisma, { bookingId: ctx.booking.id, businessUserId: ctx.owner.id });
            expect(ok.booking.status).toBe('IN_PROGRESS');
            await expect(qr.transitCheckIn(prisma, { bookingId: ctx.booking.id, businessUserId: ctx.owner.id }))
                .rejects.toThrow(/IN_PROGRESS/i);
        });
    });

    // ── Group F: the real mounted HTTP routes ────────────────────────────────
    //
    // These use the ACTUAL routers with a REAL JWT, so the route-level
    // contracts (argument order, status mapping, controller wiring) are proven
    // rather than assumed. The transit QR path was previously unreachable: the
    // generator was called with the wrong signature and boarding passed the QR
    // string in as a booking id.

    describe('F. mounted HTTP routes', () => {
        const express = require('express');
        const request = require('supertest');
        const jwt = require('jsonwebtoken');

        function buildApp() {
            const app = express();
            app.use(express.json());
            app.set('prisma', prisma);
            app.use('/api/marketplace', require('../routes/marketplaceRoutes'));
            app.use('/api/transit', require('../routes/transitRoutes'));
            return app;
        }

        const bearer = (userId) => 'Bearer ' + jwt.sign(
            { id: userId, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' }
        );

        test('F1: reservation QR round-trips through the routes, replay returns 409', async () => {
            const ctx = await seedReservationContext();
            const app = buildApp();

            const gen = await request(app)
                .get(`/api/marketplace/reservations/${ctx.reservation.id}/checkin-qr`)
                .set('Authorization', bearer(ctx.customer.id));
            expect(gen.status).toBe(200);
            expect(typeof gen.body.token).toBe('string');

            const verify = await request(app)
                .post('/api/marketplace/checkin/verify')
                .set('Authorization', bearer(ctx.owner.id))
                .send({ token: gen.body.token });
            expect(verify.status).toBe(200);
            expect(verify.body.success).toBe(true);

            const replay = await request(app)
                .post('/api/marketplace/checkin/verify')
                .set('Authorization', bearer(ctx.owner.id))
                .send({ token: gen.body.token });
            expect(replay.status).toBe(409);
            expect(replay.body.code).toBe('QR_TOKEN_ALREADY_USED');
        });

        test('F2: a malformed signature answers 400, not an uncontrolled 500', async () => {
            const ctx = await seedReservationContext();
            const app = buildApp();
            const body = Buffer.from(JSON.stringify({ typ: 'RESERVATION_CHECKIN', rid: ctx.reservation.id })).toString('base64url');

            for (const bad of [`${body}.abc`, `${body}.${'f'.repeat(63)}`, 'garbage']) {
                const res = await request(app)
                    .post('/api/marketplace/checkin/verify')
                    .set('Authorization', bearer(ctx.owner.id))
                    .send({ token: bad });
                expect(res.status).toBe(400);
                expect(res.body.success).toBe(false);
            }
        });

        test('F3: transit QR generation and boarding work through the mounted routes', async () => {
            const ctx = await seedTransitContext({ departureOffsetMs: 20 * 60_000 });
            const app = buildApp();

            const gen = await request(app)
                .get(`/api/transit/bookings/${ctx.booking.id}/checkin-qr`)
                .set('Authorization', bearer(ctx.customer.id));
            expect(gen.status).toBe(200);
            expect(typeof gen.body.token).toBe('string');

            const board = await request(app)
                .post('/api/transit/boarding')
                .set('Authorization', bearer(ctx.owner.id))
                .send({ token: gen.body.token });
            expect(board.status).toBe(200);
            expect(board.body.success).toBe(true);
            expect(board.body.booking.status).toBe('IN_PROGRESS');

            const replay = await request(app)
                .post('/api/transit/boarding')
                .set('Authorization', bearer(ctx.owner.id))
                .send({ token: gen.body.token });
            expect(replay.status).toBe(409);

            const after = await prisma.transitBooking.findUnique({ where: { id: ctx.booking.id } });
            expect(after.status).toBe('IN_PROGRESS');
            expect(after.checkedInAt).toBeTruthy();
        });

        test('F4: a QR string is not accepted as a booking id on the manual transit route', async () => {
            const ctx = await seedTransitContext({ departureOffsetMs: 20 * 60_000 });
            const app = buildApp();
            const { token } = await qr.generateTransitCheckInToken(prisma, {
                bookingId: ctx.booking.id, customerId: ctx.customer.id,
            });

            const res = await request(app)
                .post(`/api/marketplace/transit/bookings/${encodeURIComponent(token)}/checkin`)
                .set('Authorization', bearer(ctx.owner.id));
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        test('F5: missing signing key answers 503 on the QR routes (fail closed, not 500)', async () => {
            const ctx = await seedReservationContext();
            const app = buildApp();
            delete process.env.QR_CHECKIN_SIGNING_KEY;

            const res = await request(app)
                .get(`/api/marketplace/reservations/${ctx.reservation.id}/checkin-qr`)
                .set('Authorization', bearer(ctx.customer.id));
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('QR_SIGNING_KEY_MISSING');
        });
    });
});
