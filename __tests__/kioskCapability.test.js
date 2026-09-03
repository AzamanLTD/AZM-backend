const jwt = require('jsonwebtoken');
const {
    KIOSK_SCOPE,
    KIOSK_TOKEN_TTL,
    signCapability,
    verifyCapability,
    assertShiftBinding,
} = require('../services/businessOS/kioskCapability');

describe('kiosk capability', () => {
    const originalSecret = process.env.JWT_SECRET;

    beforeEach(() => {
        process.env.JWT_SECRET = 'test_secret_exactly_32_characters_long';
    });

    afterAll(() => {
        process.env.JWT_SECRET = originalSecret;
    });

    test('signs a clock-only capability with tenant and location binding', () => {
        const token = signCapability({ employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-1' });
        const decoded = jwt.decode(token);

        expect(decoded.scope).toBe(KIOSK_SCOPE);
        expect(decoded.employeeId).toBe('emp-1');
        expect(decoded.userId).toBe(7);
        expect(decoded.businessProfileId).toBe('biz-1');
        expect(decoded.locationId).toBe('loc-1');
        expect(decoded.sub).toBe('kiosk:emp-1');
        expect(decoded.exp - decoded.iat).toBe(300);
        expect(KIOSK_TOKEN_TTL).toBe('5m');
    });

    test('rejects a token with a non-kiosk scope', () => {
        const token = jwt.sign({ scope: 'full_business_access', employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1' }, process.env.JWT_SECRET);
        expect(() => verifyCapability(token)).toThrow('Invalid kiosk authorization scope.');
    });

    test('reports expired kiosk capabilities distinctly', () => {
        const token = jwt.sign(
            { scope: KIOSK_SCOPE, employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1' },
            process.env.JWT_SECRET,
            { expiresIn: -1, subject: 'kiosk:emp-1' },
        );
        expect(() => verifyCapability(token)).toThrow('Kiosk authorization expired.');
    });

    test('requires employee, user, business and optional location to match the shift', () => {
        const capability = { employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-1' };
        expect(() => assertShiftBinding({ employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-1' }, capability)).not.toThrow();
        expect(() => assertShiftBinding({ employeeId: 'emp-2', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-1' }, capability)).toThrow('Kiosk shift employee mismatch.');
        expect(() => assertShiftBinding({ employeeId: 'emp-1', userId: 8, businessProfileId: 'biz-1', locationId: 'loc-1' }, capability)).toThrow('Kiosk shift employee user mismatch.');
        expect(() => assertShiftBinding({ employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-2', locationId: 'loc-1' }, capability)).toThrow('Kiosk shift business mismatch.');
        expect(() => assertShiftBinding({ employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-2' }, capability)).toThrow('Kiosk location mismatch.');
    });

    test('allows an unbound kiosk capability to operate any shift location for the bound employee', () => {
        const capability = { employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: null };
        expect(() => assertShiftBinding({ employeeId: 'emp-1', userId: 7, businessProfileId: 'biz-1', locationId: 'loc-9' }, capability)).not.toThrow();
    });
});
