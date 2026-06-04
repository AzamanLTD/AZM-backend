// services/momoNameLookupService.js
// =============================================================================
// AZAMAN — MOMO NAME LOOKUP  (Master Sprint v2, 2026-05-27)
//
// Resolves the registered name on a mobile-money number BEFORE the user
// saves it as a deposit/withdrawal target. Today this is mocked because
// the Kotani Pay V3 name-lookup endpoint hasn't been wired yet — but the
// service surface is stable so the caller (savedMomo controller) doesn't
// have to change when LIVE goes online.
//
// Provider must be one of: MTN | VODAFONE | TELECEL.
// Phone format: GH local (0XXXXXXXXX) or E.164 (+233XXXXXXXXX).
// =============================================================================

class MomoNameLookupService {
    constructor() {
        this.mode = process.env.KOTANI_PROVIDER === 'LIVE' ? 'LIVE' : 'MOCK';
    }

    /**
     * Returns: { ok: true, name } | { ok: false, message }
     */
    async resolveName({ provider, phoneNumber }) {
        const normalisedPhone = this._normalize(phoneNumber);
        if (!normalisedPhone) {
            return { ok: false, message: 'Invalid phone number format.' };
        }
        const supportedProviders = ['MTN', 'VODAFONE', 'TELECEL'];
        if (!supportedProviders.includes(provider)) {
            return { ok: false, message: 'Unsupported provider.' };
        }

        if (this.mode === 'MOCK') {
            return this._mockLookup(provider, normalisedPhone);
        }

        // TODO: wire Kotani Pay V3 name-lookup endpoint when ready.
        // The contract returns { msisdn, registeredName, status }.
        return { ok: false, message: 'Live name lookup not yet enabled.' };
    }

    _normalize(input) {
        if (!input) return null;
        const digits = String(input).replace(/[^0-9+]/g, '');
        if (/^\+233[0-9]{9}$/.test(digits)) return digits;
        if (/^0[0-9]{9}$/.test(digits)) return '+233' + digits.substring(1);
        if (/^233[0-9]{9}$/.test(digits)) return '+' + digits;
        return null;
    }

    _mockLookup(provider, msisdn) {
        // Deterministic mock — same number always returns the same name so
        // the FE save-flow renders a stable preview during testing.
        const seed = msisdn.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const firsts = ['Kwame', 'Akosua', 'Yaw', 'Adwoa', 'Kojo', 'Esi', 'Kofi', 'Ama'];
        const lasts = ['Mensah', 'Boateng', 'Owusu', 'Asante', 'Adjei', 'Kumi', 'Sarpong'];
        const first = firsts[seed % firsts.length];
        const last = lasts[(seed >> 1) % lasts.length];
        return {
            ok: true,
            name: `${first} ${last}`,
            provider,
            msisdn,
            mocked: true,
        };
    }
}

module.exports = { MomoNameLookupService };
