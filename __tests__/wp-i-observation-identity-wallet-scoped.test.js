// __tests__/wp-i-observation-identity-wallet-scoped.test.js
// =============================================================================
// §WP-I §2 — WALLET-SCOPED OBSERVATION IDENTITY
//
// Moolre documents that `externalref` must be unique PER WALLET, and that a
// reference is reused across retries of the same payment. The v1 key
// (`moolre|collection|<ref>`) assumed global uniqueness and carried no wallet,
// so two wallets sharing a reference collapsed into one identity.
//
// These tests pin the v2 contract:
//   • the same wallet + reference is ONE identity (retries converge);
//   • different wallets + the same reference are DIFFERENT identities;
//   • a missing/unusable wallet is a typed refusal, never a guess;
//   • v1 keys stay recognisable and blocking, and can never be forged;
//   • a caller cannot smuggle a composite value into the key.
// =============================================================================
'use strict';

const {
    canonicalObservationIdentityV2,
    legacyObservationKey,
    classifyObservationKey,
    normalizeWalletAccount,
    WALLET_SCOPED_KEY_VERSION,
} = require('../src/services/providerObservationIdentity');

const WALLET_A = '1000000001';
const WALLET_B = '1000000002';
const REF = 'AZM-DEP-0001';

describe('wallet-scoped identity (v2)', () => {
    test('the same wallet and reference produce exactly one identity', () => {
        const a = canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber: WALLET_A });
        const b = canonicalObservationIdentityV2({ provider: 'MOOLRE', reference: `  ${REF}  `, accountNumber: WALLET_A });
        expect(a.observationKey).toBe(b.observationKey);
        expect(a.observationKey).toBe(`moolre|collection|v2|${WALLET_A}|${REF}`);
        expect(a.keyVersion).toBe(WALLET_SCOPED_KEY_VERSION);
        expect(a.accountKey).toBe(WALLET_A);
    });

    test('two wallets may legitimately share one reference without colliding', () => {
        const a = canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber: WALLET_A });
        const b = canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber: WALLET_B });
        expect(a.observationKey).not.toBe(b.observationKey);
        expect(classifyObservationKey(a.observationKey).walletAccount).toBe(WALLET_A);
        expect(classifyObservationKey(b.observationKey).walletAccount).toBe(WALLET_B);
    });

    test('a missing wallet is a typed refusal, never a default', () => {
        for (const accountNumber of [undefined, null, '', '   ']) {
            expect(() => canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber }))
                .toThrow(/trusted wallet account is established/);
            try {
                canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber });
            } catch (err) {
                expect(err.code).toBe('OBSERVATION_WALLET_MISSING');
            }
        }
    });

    test('an unusable wallet value is refused rather than coerced into a key', () => {
        const bad = ['abc12345', '1000', '1000000001|1000000002', '1000000001 v2', 12.5];
        for (const accountNumber of bad) {
            expect(() => canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber }))
                .toThrow(/trusted wallet account/);
        }
        expect(normalizeWalletAccount(1000000001)).toBe('1000000001');
        expect(normalizeWalletAccount(' 1000000001 ')).toBe('1000000001');
        expect(normalizeWalletAccount('1000')).toBeNull();
    });

    test('a missing reference is still refused before any wallet question', () => {
        try {
            canonicalObservationIdentityV2({ provider: 'moolre', reference: '', accountNumber: WALLET_A });
            throw new Error('should have thrown');
        } catch (err) {
            expect(err.code).toBe('OBSERVATION_REFERENCE_MISSING');
        }
    });

    test('a reference cannot forge a v2 key by embedding the separator', () => {
        // normalizeReference rejects '|' so a caller cannot hand us
        // "v2|<other wallet>|REF" and have it accepted as a key segment.
        expect(() => canonicalObservationIdentityV2({
            provider: 'moolre', reference: `v2|${WALLET_B}|${REF}`, accountNumber: WALLET_A,
        })).toThrow(/cannot be used in a wallet-scoped key/);
    });

    test('v1 keys are recognised as legacy and carry no wallet', () => {
        const legacy = legacyObservationKey({ provider: 'moolre', reference: REF });
        expect(legacy).toBe(`moolre|collection|${REF}`);
        const cls = classifyObservationKey(legacy);
        expect(cls.version).toBe(1);
        expect(cls.walletAccount).toBeNull();
        expect(cls.reference).toBe(REF);
    });

    test('the v2 identity still names its legacy sibling so both can be checked', () => {
        const v2 = canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber: WALLET_A });
        expect(v2.legacyObservationKey).toBe(`moolre|collection|${REF}`);
        expect(classifyObservationKey(v2.legacyObservationKey).version).toBe(1);
        expect(classifyObservationKey(v2.observationKey).version).toBe(2);
    });

    test('an unrecognised key shape is classified as version 0, not guessed', () => {
        for (const key of ['', 'garbage', 'moolre|collection', 'moolre|collection|v2|notawallet|REF', null]) {
            const cls = classifyObservationKey(key);
            expect(cls.version).toBe(0);
            expect(cls.walletAccount).toBeNull();
        }
    });

    test('a provider-generated transaction id is not interchangeable with the reference', () => {
        // The identity is built from the merchant reference only. Passing a
        // provider txid here produces a DIFFERENT key, so a caller cannot
        // substitute one identity for the other and expect a match.
        const byRef = canonicalObservationIdentityV2({ provider: 'moolre', reference: REF, accountNumber: WALLET_A });
        const byTxid = canonicalObservationIdentityV2({ provider: 'moolre', reference: 'TP13-TX-9931', accountNumber: WALLET_A });
        expect(byRef.observationKey).not.toBe(byTxid.observationKey);
    });
});
