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
// Provider must be one of: MTN | TELECEL | AIRTELTIGO (VODAFONE accepted as legacy alias).
// Phone format: GH local (0XXXXXXXXX) or E.164 (+233XXXXXXXXX).
// =============================================================================

const logger = require('../src/config/logger');
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
            return { ok: false, message: `Unsupported provider "${provider}". Use MTN, TELECEL, or AIRTELTIGO.` };
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
            logger.error('[MomoNameLookupService] validateName error:', err.message, err.raw || '');
            // Return a user-friendly message — do not expose raw API internals to the client.
            const friendly = err.message?.includes('status 0')
                ? 'Number not found on this network. Check the number and provider.'
                : 'Could not verify account. Please try again.';
            return { ok: false, message: friendly };
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Normalise to E.164 (+233XXXXXXXXX) or return null. */
    _normalize(input) {
        // Return 0-prefixed local format (0XXXXXXXXX) — this matches what
        // moolreCollectionService._sanitizeMsisdn expects, since that helper
        // strips non-digits and then checks for '0' or '233' prefix.
        // Previously returned E.164 (+233...) which caused _sanitizeMsisdn to
        // strip the '+' and produce a 12-digit '2330XXXXXXXX' string that matched
        // no branch, falling through as-is and confusing the Moolre API.
        if (!input) return null;
        const digits = String(input).replace(/\D/g, '');
        if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3);
        if (digits.startsWith('0')   && digits.length === 10) return digits;
        return null;
    }

    /** Map any accepted provider variant to MoolreCollectionService's canonical key. */
    _canonicalNetwork(provider) {
        if (!provider) return null;
        const map = {
            MTN:       'MTN',
            TELECEL:   'TELECEL',     // Telecel Ghana (formerly Vodafone) → channel 6
            VODAFONE:  'TELECEL',     // LEGACY ALIAS — Vodafone rebranded to Telecel
            AIRTELTIGO:'AIRTELTIGO',  // channel 7
            AT:        'AIRTELTIGO',
            // Legacy form strings coming from the saved-momo add sheet
            MTN_MOMO:        'MTN',
            TELECEL_CASH:    'TELECEL',
            VODAFONE_CASH:   'TELECEL',  // LEGACY ALIAS
            AIRTELTIGO_CASH: 'AIRTELTIGO',
        };
        return map[provider.toUpperCase().replace(/[^A-Z_]/g, '')] ?? null;
    }
}

module.exports = { MomoNameLookupService };
