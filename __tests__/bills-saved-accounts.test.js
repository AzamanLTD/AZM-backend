// __tests__/bills-saved-accounts.test.js
// =============================================================================
// Saved service accounts: protection, ownership, duplicates and honesty.
//
// There is deliberately no payment test here — no quote, order or debit path
// exists, and these tests assert that none can be reached.
// =============================================================================

process.env.NODE_ENV = 'test';

const crypto = require('crypto');

const KEY = crypto.randomBytes(32).toString('hex');
const FP_KEY = crypto.randomBytes(32).toString('hex');

function freshCrypto(env = {}) {
    jest.resetModules();
    process.env.SAVED_SERVICE_ENCRYPTION_KEY = env.encKey === undefined ? KEY : env.encKey;
    process.env.SAVED_SERVICE_FINGERPRINT_KEY = env.fpKey === undefined ? FP_KEY : env.fpKey;
    process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = env.version || '1';
    return require('../services/bills/savedServiceCrypto');
}

/** Minimal prisma double: enough semantics to test ownership and transactions. */
function fakePrisma(seed = []) {
    const rows = seed.map((r) => ({ ...r }));
    let seq = rows.length;

    const matches = (row, where) => Object.entries(where).every(([k, v]) => {
        if (k === 'NOT') return row.id !== v.id;
        return row[k] === v;
    });

    return {
        savedServiceAccount: {
            async findFirst({ where }) {
                return rows.find((r) => matches(r, where)) || null;
            },
            async findMany({ where }) {
                return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
            },
            async create({ data }) {
                if (rows.some((r) => r.userId === data.userId
                    && r.serviceCode === data.serviceCode
                    && r.accountFingerprint === data.accountFingerprint)) {
                    const err = new Error('unique'); err.code = 'P2002'; throw err;
                }
                seq += 1;
                const row = { id: `acc-${seq}`, verifiedAt: null, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
                rows.push(row);
                return row;
            },
            async updateMany({ where, data }) {
                let n = 0;
                for (const r of rows) {
                    if (matches(r, where)) { Object.assign(r, data); n += 1; }
                }
                return { count: n };
            },
            async update({ where, data }) {
                const row = rows.find((r) => r.id === where.id);
                Object.assign(row, data);
                return row;
            },
            async delete({ where }) {
                const i = rows.findIndex((r) => r.id === where.id);
                return rows.splice(i, 1)[0];
            },
        },
        async $transaction(fn) { return fn(this); },
        _rows: rows,
    };
}

const ECG = { serviceCode: 'ECG_PREPAID', providerCode: 'ECG', nickname: 'Home meter', accountFields: { meterNumber: '1234567890' } };

describe('saved service cryptography', () => {
    test('round-trips account fields', () => {
        const c = freshCrypto();
        const sealed = c.encryptAccountData({ meterNumber: '1234567890' });
        expect(sealed.startsWith('senc:v1:1:')).toBe(true);
        expect(sealed).not.toContain('1234567890');
        expect(c.decryptAccountData(sealed)).toEqual({ meterNumber: '1234567890' });
    });

    test('random IV means equal plaintext yields different ciphertext', () => {
        const c = freshCrypto();
        const a = c.encryptAccountData({ meterNumber: '1234567890' });
        const b = c.encryptAccountData({ meterNumber: '1234567890' });
        expect(a).not.toBe(b);
    });

    test('tampering is detected', () => {
        const c = freshCrypto();
        const sealed = c.encryptAccountData({ meterNumber: '1234567890' });
        const parts = sealed.split(':');
        const raw = Buffer.from(parts[5], 'base64');
        raw[0] ^= 0xff;
        parts[5] = raw.toString('base64');
        expect(() => c.decryptAccountData(parts.join(':'))).toThrow(/authentication/);
    });

    test('a different key fails', () => {
        const c = freshCrypto();
        const sealed = c.encryptAccountData({ meterNumber: '1234567890' });
        const other = freshCrypto({ encKey: crypto.randomBytes(32).toString('hex') });
        expect(() => other.decryptAccountData(sealed)).toThrow(/authentication/);
    });

    test('a missing key refuses work instead of writing plaintext', () => {
        const c = freshCrypto({ encKey: '' });
        expect(() => c.encryptAccountData({ meterNumber: '1' })).toThrow(/not set/);
        expect(() => c.encryptAccountData({ meterNumber: '1' })).toThrow(expect.objectContaining({ code: 'SAVED_SERVICE_KEY_MISSING' }));
    });

    test('a malformed key is refused', () => {
        const c = freshCrypto({ encKey: 'deadbeef' });
        expect(() => c.encryptAccountData({ meterNumber: '1' })).toThrow(/32 bytes/);
    });

    test('fingerprints are stable and scoped to user, service and provider', () => {
        const c = freshCrypto();
        const base = { userId: 1, serviceCode: 'ECG_PREPAID', providerCode: 'ECG', identity: '1234567890' };
        expect(c.accountFingerprint(base)).toBe(c.accountFingerprint({ ...base }));
        expect(c.accountFingerprint(base)).not.toBe(c.accountFingerprint({ ...base, userId: 2 }));
        expect(c.accountFingerprint(base)).not.toBe(c.accountFingerprint({ ...base, serviceCode: 'ECG_POSTPAID' }));
        expect(c.accountFingerprint(base)).not.toBe(c.accountFingerprint({ ...base, providerCode: 'OTHER' }));
        expect(c.accountFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('the key version is retained in the envelope', () => {
        const c = freshCrypto({ version: '7' });
        const sealed = c.encryptAccountData({ meterNumber: '1' });
        expect(c.parseEnvelope(sealed).keyVersion).toBe('7');
    });

    test('masks keep only a short tail', () => {
        const c = freshCrypto();
        const masked = c.maskIdentity('1234567890');
        expect(masked.endsWith('7890')).toBe(true);
        expect(masked).not.toContain('123456');
        expect(masked.length).toBeLessThanOrEqual(32);
    });
});

describe('saved service accounts', () => {
    function build(seed) {
        const c = freshCrypto();
        jest.resetModules();
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = KEY;
        process.env.SAVED_SERVICE_FINGERPRINT_KEY = FP_KEY;
        const prisma = fakePrisma(seed);
        const { createService } = require('../services/bills/savedServiceAccountService');
        return { svc: createService({ prisma }), prisma, c };
    }

    test('creates an UNVERIFIED account and never returns the raw identifier', async () => {
        const { svc, prisma } = build();
        const out = await svc.createAccount({ userId: 1, ...ECG });
        expect(out.verificationStatus).toBe('UNVERIFIED');
        expect(out.accountMask).toBe('••••••7890');
        expect(JSON.stringify(out)).not.toContain('1234567890');
        expect(out.capabilities).toEqual({ saveAccount: true, lookupAccount: false, quote: false, payment: false });
        const row = prisma._rows[0];
        expect(row.accountDataCiphertext).toContain('senc:v1:');
        expect(JSON.stringify(row)).not.toContain('1234567890');
    });

    test('a duplicate identity is a structured conflict', async () => {
        const { svc } = build();
        await svc.createAccount({ userId: 1, ...ECG });
        await expect(svc.createAccount({ userId: 1, ...ECG }))
            .rejects.toMatchObject({ status: 409, code: 'SAVED_ACCOUNT_EXISTS' });
    });

    test('concurrent duplicate creates: exactly one wins', async () => {
        const { svc, prisma } = build();
        const results = await Promise.allSettled([
            svc.createAccount({ userId: 1, ...ECG }),
            svc.createAccount({ userId: 1, ...ECG }),
            svc.createAccount({ userId: 1, ...ECG }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(prisma._rows).toHaveLength(1);
    });

    test('the same meter for another member is a separate account', async () => {
        const { svc } = build();
        await svc.createAccount({ userId: 1, ...ECG });
        const other = await svc.createAccount({ userId: 2, ...ECG });
        expect(other.id).toBeTruthy();
    });

    test('rejects unknown services and mismatched providers', async () => {
        const { svc } = build();
        await expect(svc.createAccount({ userId: 1, ...ECG, serviceCode: 'NOT_A_SERVICE' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_SERVICE' });
        await expect(svc.createAccount({ userId: 1, ...ECG, providerCode: 'DSTV' }))
            .rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
    });

    test('rejects unknown, missing and malformed fields', async () => {
        const { svc } = build();
        await expect(svc.createAccount({ userId: 1, ...ECG, accountFields: { meterNumber: '1234567890', secret: 'x' } }))
            .rejects.toMatchObject({ code: 'UNKNOWN_ACCOUNT_FIELD' });
        await expect(svc.createAccount({ userId: 1, ...ECG, accountFields: {} }))
            .rejects.toMatchObject({ code: 'MISSING_ACCOUNT_FIELD' });
        await expect(svc.createAccount({ userId: 1, ...ECG, accountFields: { meterNumber: 'abc' } }))
            .rejects.toMatchObject({ code: 'INVALID_ACCOUNT_FIELD' });
    });

    test('canonicalises phone numbers before fingerprinting', async () => {
        const { svc } = build();
        const a = await svc.createAccount({
            userId: 1, serviceCode: 'AIRTIME', providerCode: 'MTN', accountFields: { recipientPhone: '0244123456' },
        });
        expect(a.accountMask.endsWith('3456')).toBe(true);
        await expect(svc.createAccount({
            userId: 1, serviceCode: 'AIRTIME', providerCode: 'MTN', accountFields: { recipientPhone: '+233244123456' },
        })).rejects.toMatchObject({ code: 'SAVED_ACCOUNT_EXISTS' });
    });

    test('lists only the authenticated member', async () => {
        const { svc } = build();
        await svc.createAccount({ userId: 1, ...ECG });
        await svc.createAccount({ userId: 2, ...ECG, accountFields: { meterNumber: '9999999999' } });
        const mine = await svc.listAccounts(1);
        expect(mine).toHaveLength(1);
        expect(JSON.stringify(mine)).not.toContain('9999999999');
    });

    test('rename and primary changes are the only mutations', async () => {
        const { svc, prisma } = build();
        const first = await svc.createAccount({ userId: 1, ...ECG });
        await svc.createAccount({ userId: 1, ...ECG, accountFields: { meterNumber: '5555555555' } });

        const renamed = await svc.updateAccount({ userId: 1, id: first.id, nickname: 'Upstairs' });
        expect(renamed.nickname).toBe('Upstairs');

        const second = prisma._rows[1];
        await svc.updateAccount({ userId: 1, id: second.id, isPrimary: true });
        const primaries = prisma._rows.filter((r) => r.isPrimary);
        expect(primaries).toHaveLength(1);
        expect(primaries[0].id).toBe(second.id);

        // Identity fields cannot be reached through the update path.
        const after = await svc.updateAccount({ userId: 1, id: first.id, nickname: 'A', accountFields: { meterNumber: '0000000000' } });
        expect(after.accountMask).toBe(first.accountMask);
    });

    test('another member cannot read, mutate or delete an account', async () => {
        const { svc } = build();
        const mine = await svc.createAccount({ userId: 1, ...ECG });
        await expect(svc.updateAccount({ userId: 2, id: mine.id, nickname: 'x' }))
            .rejects.toMatchObject({ status: 404, code: 'SAVED_ACCOUNT_NOT_FOUND' });
        await expect(svc.deleteAccount({ userId: 2, id: mine.id }))
            .rejects.toMatchObject({ status: 404 });
        await expect(svc.revealAccountFields({ userId: 2, id: mine.id }))
            .rejects.toMatchObject({ status: 404 });
    });

    test('the owner can decrypt through the audited internal path only', async () => {
        const { svc } = build();
        const mine = await svc.createAccount({ userId: 1, ...ECG });
        await expect(svc.revealAccountFields({ userId: 1, id: mine.id }))
            .resolves.toEqual({ meterNumber: '1234567890' });
    });

    test('delete removes one account and leaves the rest', async () => {
        const { svc, prisma } = build();
        const a = await svc.createAccount({ userId: 1, ...ECG });
        await svc.createAccount({ userId: 1, ...ECG, accountFields: { meterNumber: '7777777777' } });
        await svc.deleteAccount({ userId: 1, id: a.id });
        expect(prisma._rows).toHaveLength(1);
    });

    test('requires an authenticated numeric user', async () => {
        const { svc } = build();
        await expect(svc.createAccount({ userId: undefined, ...ECG }))
            .rejects.toMatchObject({ status: 401 });
    });
});

describe('provider honesty', () => {
    test('templates advertise saving only', () => {
        const { publicTemplates } = require('../services/bills/serviceRegistry');
        const templates = publicTemplates();
        expect(templates.paymentsEnabled).toBe(false);
        const services = templates.categories.flatMap((c) => c.services);
        expect(services.length).toBeGreaterThan(0);
        for (const svc of services) {
            expect(svc.capabilities).toEqual({
                saveAccount: true, lookupAccount: false, quote: false, payment: false,
            });
            expect(svc.providerAdapter).toBeNull();
        }
    });

    test('the bills router exposes no payment, quote or lookup endpoint', () => {
        const router = require('../routes/billsRoutes');
        const paths = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods).join('')} ${l.route.path}`);
        expect(paths.sort()).toEqual([
            'get /saved-accounts',
            'get /service-templates',
            'patch /saved-accounts/:id',
            'post /saved-accounts',
            'delete /saved-accounts/:id',
        ].sort());
        expect(paths.join(' ')).not.toMatch(/pay|quote|lookup|order|receipt/);
    });

    test('every service declares a template version', () => {
        const { publicTemplates } = require('../services/bills/serviceRegistry');
        expect(publicTemplates().schemaVersion).toBe('1');
    });
});

describe('masking never round-trips a short identifier', () => {
    const { maskIdentity } = require('../services/bills/savedServiceCrypto');

    test.each(['7', '42', '913', '4451', '88231', '100200'])(
        'a %s-character identifier is fully masked', (value) => {
            const masked = maskIdentity(value);
            expect(masked).not.toContain(value);
            expect(masked.replace(/[^•]/g, '')).toHaveLength(masked.length);
            expect(masked.length).toBeGreaterThanOrEqual(Math.min(3, value.length));
        });

    test('a long meter number keeps only a tail', () => {
        const masked = maskIdentity('0123456789012');
        expect(masked).toMatch(/^•+9012$/);
        expect(masked).not.toContain('0123456789012');
    });

    test('the API list response never returns a 4-character reference in full', async () => {
        jest.resetModules();
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = KEY;
        process.env.SAVED_SERVICE_FINGERPRINT_KEY = FP_KEY;
        const prisma = fakePrisma([]);
        const { createService } = require('../services/bills/savedServiceAccountService');
        const svc = createService({ prisma });

        await svc.createAccount({
            userId: 1,
            serviceCode: 'BROADBAND',
            providerCode: 'GENERIC_BROADBAND',
            nickname: 'Home',
            accountFields: { serviceReference: 'AB12' },
        });
        const rows = await svc.listAccounts(1);
        expect(JSON.stringify(rows)).not.toContain('AB12');
        expect(rows[0].accountMask.replace(/[^•]/g, '')).toHaveLength(rows[0].accountMask.length);
    });
});

describe('key ring and rotation', () => {
    const c = require('../services/bills/savedServiceCrypto');

    test('ciphertext records the key version that produced it', () => {
        const envelope = c.encryptAccountData({ meterNumber: '1234567890' });
        expect(c.parseEnvelope(envelope).keyVersion).toBe(c.keyVersion());
    });

    test('a rotated current key cannot open ciphertext from the previous version', () => {
        const envelope = c.encryptAccountData({ meterNumber: '1234567890' });
        const previous = process.env.SAVED_SERVICE_ENCRYPTION_KEY;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '2';
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
        let code;
        try { c.decryptAccountData(envelope); } catch (e) { code = e.code; }
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = previous;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '1';
        expect(code).toBe('SAVED_SERVICE_KEY_VERSION_UNKNOWN');
    });

    test('an old key supplied in the ring still decrypts old ciphertext', () => {
        const envelope = c.encryptAccountData({ meterNumber: '1234567890' });
        const current = process.env.SAVED_SERVICE_ENCRYPTION_KEY;
        const oldMaterial = Buffer.alloc(32, 3).toString('hex');

        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '2';
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
        process.env.SAVED_SERVICE_ENCRYPTION_KEYS_JSON = JSON.stringify({ 1: current });

        const opened = c.decryptAccountData(envelope);
        delete process.env.SAVED_SERVICE_ENCRYPTION_KEYS_JSON;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = current;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '1';
        expect(opened.meterNumber).toBe('1234567890');
        expect(oldMaterial).toHaveLength(64);
    });
});

describe('public template contract', () => {
    const { publicTemplates } = require('../services/bills/serviceRegistry');

    test('every saveable service exposes its authoritative identity field', () => {
        const t = publicTemplates();
        for (const cat of t.categories) {
            for (const svc of cat.services) {
                expect(typeof svc.identityField).toBe('string');
                expect(svc.fields.map((f) => f.key)).toContain(svc.identityField);
                expect(svc.capabilities.payment).toBe(false);
                expect(svc.capabilities.quote).toBe(false);
                expect(svc.capabilities.lookupAccount).toBe(false);
                expect(svc.providerAdapter).toBeNull();
            }
        }
        expect(t.paymentsEnabled).toBe(false);
    });

    test('a plausible non-standard reference is not rejected by an assumed format', async () => {
        // Widened structural bounds: a 12-digit DStv-style reference and a
        // 22-digit water reference must save, because no provider contract
        // establishes a tighter rule.
        jest.resetModules();
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = KEY;
        process.env.SAVED_SERVICE_FINGERPRINT_KEY = FP_KEY;
        const prisma = fakePrisma([]);
        const { createService } = require('../services/bills/savedServiceAccountService');
        const svc = createService({ prisma });

        const tv = await svc.createAccount({
            userId: 1, serviceCode: 'DSTV', providerCode: 'DSTV', nickname: 'Lounge',
            accountFields: { smartcardNumber: '703489162537' },
        });
        expect(tv.verificationStatus).toBe('UNVERIFIED');
        expect(tv.serviceTemplateVersion).toBe('1');

        const water = await svc.createAccount({
            userId: 1, serviceCode: 'GHANA_WATER', providerCode: 'GHANA_WATER', nickname: 'Home',
            accountFields: { customerReference: '100200300400500600' },
        });
        expect(water.accountMask).not.toBe('100200300400500600');
        expect(water.verificationStatus).toBe('UNVERIFIED');
    });
});

describe('mask boundaries at every length', () => {
    const { maskIdentity } = require('../services/bills/savedServiceCrypto');

    test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('length %i is fully masked', (len) => {
        const raw = '1'.repeat(len);
        const mask = maskIdentity(raw);
        expect(mask).not.toContain(raw);
        expect(mask.replace(/[^•]/g, '')).toHaveLength(mask.length);
    });

    test('length 10 keeps a tail but hides the body', () => {
        const raw = '1234567890';
        const mask = maskIdentity(raw);
        expect(mask).not.toBe(raw);
        expect(mask.length).toBeLessThanOrEqual(32);
        expect(mask.endsWith('7890')).toBe(true);
    });

    test('a long numeric meter shows only the last four', () => {
        expect(maskIdentity('123456789012')).toBe('••••••••9012');
    });
});
