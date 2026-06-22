// __tests__/zod-schemas.test.js
// =============================================================================
// Zod schema regression tests — pure unit, no database required.
//
// Every schema EXPORTED by services/validation/financialSchemas.js is tested
// with both valid and invalid inputs. If a developer edits a schema to be more
// permissive than intended, this suite catches it immediately. Runs in ALL
// environments (no TEST_DATABASE_URL guard).
//
// Written against the ACTUAL exports (verified), NOT the design-doc shapes:
//   • initiateFiatDepositSchema uses { amountGhs, provider } where provider is
//     the enum MTN_MOMO|VODAFONE_CASH|AIRTELTIGO|BANK_TRANSFER (not a generic
//     `paymentMethod: 'MOMO'`).
//   • fiatWithdrawalSchema requires only `amount`; payoutMethod is optional and
//     recipientPhone has a 9-char minimum.
//   • cryptoWithdrawalSchema uses `destination` (0x+40 hex), not
//     `destinationAddress`.
//   • raiseDisputeSchema.reason is trim().min(1) (not min(10)); evidenceUrls
//     max 5.
//   • banUserSchema uses `action` (BAN_24H|BAN_1W|BAN_INDEF|UNBAN), not a
//     `duration`.
//   • The doc's sendFundsSchema / createVaultSchema are NOT exported by this
//     module, so they are intentionally not tested here.
// =============================================================================
const schemas = require('../services/validation/financialSchemas');

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';
const VALID_ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'; // 0x + 40 hex

describe('Zod financial schemas — regression guard', () => {
    // ── initiateFiatDepositSchema ──────────────────────────────────────────────
    describe('initiateFiatDepositSchema', () => {
        const s = schemas.initiateFiatDepositSchema;
        test('valid: positive amount + known provider', () => {
            expect(s.safeParse({ amountGhs: 100, provider: 'MTN_MOMO' }).success).toBe(true);
        });
        test('invalid: negative amount', () => {
            expect(s.safeParse({ amountGhs: -10, provider: 'MTN_MOMO' }).success).toBe(false);
        });
        test('invalid: unknown provider', () => {
            expect(s.safeParse({ amountGhs: 100, provider: 'BITCOIN' }).success).toBe(false);
        });
        test('invalid: missing amountGhs', () => {
            expect(s.safeParse({ provider: 'MTN_MOMO' }).success).toBe(false);
        });
    });

    // ── fiatWithdrawalSchema ───────────────────────────────────────────────────
    describe('fiatWithdrawalSchema', () => {
        const s = schemas.fiatWithdrawalSchema;
        test('valid', () => {
            expect(s.safeParse({ amount: 50, payoutMethod: 'MOMO', recipientPhone: '0241234567' }).success).toBe(true);
        });
        test('invalid: zero amount', () => {
            expect(s.safeParse({ amount: 0, payoutMethod: 'MOMO' }).success).toBe(false);
        });
        test('invalid: recipientPhone too short', () => {
            expect(s.safeParse({ amount: 50, recipientPhone: '123' }).success).toBe(false);
        });
    });

    // ── cryptoWithdrawalSchema ────────────────────────────────────────────────
    describe('cryptoWithdrawalSchema', () => {
        const s = schemas.cryptoWithdrawalSchema;
        test('valid Polygon address', () => {
            expect(s.safeParse({ amount: 10, destination: VALID_ADDR, network: 'POLYGON' }).success).toBe(true);
        });
        test('invalid: bad address (no 0x prefix)', () => {
            expect(s.safeParse({ amount: 10, destination: VALID_ADDR.slice(2) }).success).toBe(false);
        });
        test('invalid: address too short', () => {
            expect(s.safeParse({ amount: 10, destination: '0xAbCd' }).success).toBe(false);
        });
        test('invalid: negative amount', () => {
            expect(s.safeParse({ amount: -1, destination: VALID_ADDR }).success).toBe(false);
        });
    });

    // ── fundEscrowSchema ──────────────────────────────────────────────────────
    describe('fundEscrowSchema', () => {
        const s = schemas.fundEscrowSchema;
        test('valid UUID', () => {
            expect(s.safeParse({ escrowId: VALID_UUID }).success).toBe(true);
        });
        test('invalid: non-UUID string', () => {
            expect(s.safeParse({ escrowId: 'not-a-uuid' }).success).toBe(false);
        });
        test('invalid: missing field', () => {
            expect(s.safeParse({}).success).toBe(false);
        });
    });

    // ── raiseDisputeSchema ────────────────────────────────────────────────────
    describe('raiseDisputeSchema', () => {
        const s = schemas.raiseDisputeSchema;
        test('valid', () => {
            expect(s.safeParse({ escrowId: VALID_UUID, reason: 'Vendor did not deliver the goods as agreed' }).success).toBe(true);
        });
        test('invalid: empty reason', () => {
            expect(s.safeParse({ escrowId: VALID_UUID, reason: '   ' }).success).toBe(false);
        });
        test('invalid: too many evidenceUrls', () => {
            const urls = ['http://a.com', 'http://b.com', 'http://c.com', 'http://d.com', 'http://e.com', 'http://f.com'];
            expect(s.safeParse({ escrowId: VALID_UUID, reason: 'A valid reason that is long enough', evidenceUrls: urls }).success).toBe(false);
        });
    });

    // ── approveKycSchema ──────────────────────────────────────────────────────
    describe('approveKycSchema', () => {
        const s = schemas.approveKycSchema;
        test('valid', () => {
            expect(s.safeParse({ userId: 42 }).success).toBe(true);
        });
        test('invalid: non-positive userId', () => {
            expect(s.safeParse({ userId: 0 }).success).toBe(false);
        });
        test('invalid: string that is not a number', () => {
            expect(s.safeParse({ userId: 'abc' }).success).toBe(false);
        });
    });

    // ── rejectKycSchema ───────────────────────────────────────────────────────
    describe('rejectKycSchema', () => {
        const s = schemas.rejectKycSchema;
        test('valid with reason', () => {
            expect(s.safeParse({ userId: 1, reason: 'Docs unclear' }).success).toBe(true);
        });
        test('valid without reason', () => {
            expect(s.safeParse({ userId: 1 }).success).toBe(true);
        });
        test('invalid: non-positive userId', () => {
            expect(s.safeParse({ userId: 0, reason: 'Docs unclear' }).success).toBe(false);
        });
    });

    // ── banUserSchema ─────────────────────────────────────────────────────────
    describe('banUserSchema', () => {
        const s = schemas.banUserSchema;
        test('valid: BAN_24H', () => {
            expect(s.safeParse({ action: 'BAN_24H', reason: 'Repeated violations of ToS' }).success).toBe(true);
        });
        test('valid: BAN_INDEF', () => {
            expect(s.safeParse({ action: 'BAN_INDEF', reason: 'Fraud confirmed by investigation' }).success).toBe(true);
        });
        test('invalid: unknown action', () => {
            expect(s.safeParse({ action: '48h', reason: 'Some reason here long enough' }).success).toBe(false);
        });
    });

    // ── forceReleaseSchema ────────────────────────────────────────────────────
    describe('forceReleaseSchema', () => {
        const s = schemas.forceReleaseSchema;
        test('valid', () => {
            expect(s.safeParse({ tradeId: '12345', adminNotes: 'Reviewed evidence' }).success).toBe(true);
        });
        test('valid without adminNotes', () => {
            expect(s.safeParse({ tradeId: '12345' }).success).toBe(true);
        });
        test('invalid: missing tradeId', () => {
            expect(s.safeParse({}).success).toBe(false);
        });
    });
});
