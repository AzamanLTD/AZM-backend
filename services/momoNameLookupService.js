// services/momoNameLookupService.js
// =============================================================================
// AZAMAN — MOMO NAME LOOKUP  (rewritten 2026-07-09)
//
// Resolves the registered name on a mobile-money number before the user
// saves it as a deposit/withdrawal target (POST /api/saved-momo/lookup).
//
// Originally wired to a Kotani Pay V3 stub that was never implemented and
// returned "Live name lookup not yet enabled." even in LIVE mode. Rewired
// to delegate directly to MoolreCollectionService.validateName(), which is
// already confirmed correct against docs.moolre.com/ai/validate-name.md and
// shares the same MOOLRE_PROVIDER / MOOLRE_API_* env vars.
//
// Provider must be one of: MTN | VODAFONE | TELECEL | AIRTELTIGO.
// Phone format: GH local (0XXXXXXXXX) or E.164 (+233XXXXXXXXX).
// =============================================================================

const MoolreCollectionService = require('./moolreCollectionService');

// Singleton — shares the same underlying instance as the deposit on-ramp
// so we don't create a second authenticated client with its own token state.
let _instance = null;

class MomoNameLookupService {
    /**
     * @param {MoolreCollectionService} [sharedInstance]
     *   If provided, reuses the already-initialised Moolre client instead of
     *   creating a second one. server.js passes moolreCollectionService here.
     *   Tests that call new MomoNameLookupService() with no argument get their
     *   own MOCK-mode instance, which is fine.
     */
    constructor(sharedInstance) {
        if (sharedInstance) {
            _instance = sharedInstance;
        } else if (!_instance) {
            _instance = new MoolreCollectionService();
        }
        this._moolre = _instance;
        this.mode = this._moolre.providerMode; // 'LIVE' or 'MOCK'
    }

    /**
     * Returns:
     *   { ok: true,  name: string, msisdn: string, provider: string }
     *   { ok: false, message: string }
     */
    async resolveName({ provider, phoneNumber }) {
        const normalisedPhone = this._normalize(phoneNumber);
        if (!normalisedPhone) {
            return { ok: false, message: 'Invalid phone number format.' };
        }

        // Canonical provider key (VALIDATE_CHANNEL_MAP uses these as keys).
        const network = this._canonicalNetwork(provider);
        if (!network) {
            return { ok: false, message: `Unsupported provider "${provider}". Use MTN, VODAFONE, TELECEL, or AIRTELTIGO.` };
        }

        try {
            const name = await this._moolre.validateName({
                payerPhone: normalisedPhone,
                network,
            });

            if (!name) {
                return { ok: false, message: 'Account not found on this network. Check the number and provider.' };
            }

            return { ok: true, name, msisdn: normalisedPhone, provider: network };
        } catch (err) {
            console.error('[MomoNameLookupService] validateName error:', err.message);
            return { ok: false, message: 'Name lookup failed. Please retry.' };
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Normalise to E.164 (+233XXXXXXXXX) or return null. */
    _normalize(input) {
        if (!input) return null;
        const digits = String(input).replace(/[^0-9+]/g, '');
        if (/^\+233[0-9]{9}$/.test(digits)) return digits;
        if (/^0[0-9]{9}$/.test(digits))      return '+233' + digits.substring(1);
        if (/^233[0-9]{9}$/.test(digits))     return '+' + digits;
        return null;
    }

    /** Map any accepted provider variant to MoolreCollectionService's canonical key. */
    _canonicalNetwork(provider) {
        if (!provider) return null;
        const map = {
            MTN:       'MTN',
            VODAFONE:  'VODAFONE',
            TELECEL:   'TELECEL',     // Vodafone rebranded → channel 6
            AIRTELTIGO:'AIRTELTIGO',  // channel 7
            AT:        'AIRTELTIGO',
            // Legacy form strings coming from the saved-momo add sheet
            MTN_MOMO:       'MTN',
            VODAFONE_CASH:  'VODAFONE',
            TELECEL_CASH:   'TELECEL',
            AIRTELTIGO_CASH:'AIRTELTIGO',
        };
        return map[provider.toUpperCase().replace(/[^A-Z_]/g, '')] ?? null;
    }
}

module.exports = { MomoNameLookupService };
