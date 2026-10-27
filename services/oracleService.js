// services/oracleService.js
const logger = require('../src/config/logger');
const axios = require('axios');
const {
    saveValidatedRateSnapshot,
    FX_SAVED_RATE_PAIR,
} = require('../src/services/fxRateSnapshotService');

const KOTANI_DEFAULT_BASE_URL = 'https://sandbox-api.kotanipay.io/api/v3';

// ── §1 VERIFIED PRODUCTION HOST ALLOWLIST (review follow-up 2026-10-18) ──
//
// A production transaction-rate endpoint must be HTTPS AND on a host that
// Kotani has CONFIRMED in writing during onboarding. We do not invent the
// production hostname: this allowlist ships EMPTY and production arming
// fails closed (UNVERIFIED_PRODUCTION_HOST) until the verified host is
// added here by the platform operator as the explicit onboarding step.
//
// TO ARM PRODUCTION (one line, one commit, auditable): push the host Kotani
// confirmed, e.g.  KOTANI_VERIFIED_PRODUCTION_HOSTS.push('api.kotanipay.io')
// — ONLY once Kotani onboarding has confirmed that exact hostname in writing.
// The array is exported so policy tests can exercise the armed path with a
// simulated verified host and restore it afterwards.
const KOTANI_VERIFIED_PRODUCTION_HOSTS = [];

// ── P0 HARD-BOUND CANONICAL PAIR (review follow-up 2026-10-18) ──────────────
//
// The canonical transaction-rate slot (globalSettings.liveRetailRate) is
// defined as the USDC/GHS rate and NOTHING ELSE. These constants are the
// single source of truth for the pair the oracle requests, validates and
// writes; an operator cannot retarget the canonical slot at another pair.
const CANONICAL_RATE_FROM = 'USDC';
const CANONICAL_RATE_TO = 'GHS';

const asFinitePositive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};

// ── KOTANI V3 RESPONSE CONTRACT (2026-10-17 hardening, A2) ────────────────
//
// The documented POST /api/v3/rate/offramp response shape is
//   { "success": true, "message": "Available exchange rate.",
//     "data": { "from": "USDC", "to": "GHS", "value": "15.53",
//               "fiatAmount": ..., "cryptoAmount": ..., "fee": ... } }
// (https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate).
// The rate lives in data.value AS A STRING; the pair is echoed in
// data.from/data.to. Auth/quota failures can arrive as HTTP 200 with
// success:false and an empty data object — so an explicit success:false
// must fail closed, and the echoed pair must be validated before an
// observation is trusted: a misconfigured from/to (or an off-target
// response) must never write a foreign-pair rate into the canonical
// USDC/GHS slot.
const extractKotaniRate = (payload) => {
    // P0 review (2026-10-18): the canonical transaction rate may come ONLY
    // from the documented v3 field — data.value as a string. Legacy or
    // unexpected rate fields (rate/exchangeRate at any depth) and a
    // fiatAmount/cryptoAmount derivation are NO LONGER accepted: deriving a
    // canonical USDC/GHS rate from an undocumented shape is exactly how a
    // foreign or mislabeled number could be laundered into the canonical
    // slot. When data.value is absent or malformed the observation is
    // UNPARSEABLE — fail closed, never guess.
    //
    // Strict-schema review (2026-10-23): the success declaration must be an
    // EXPLICIT true (not merely "not false"), and data.value must be a
    // STRING per the documented v3 contract — a JSON number, boolean or null
    // is an envelope-shape violation, not an observation. JavaScript
    // coercion makes this load-bearing: Number(true) === 1 and
    // Number('15.53') === 15.53, so asFinitePositive silently "parsed"
    // numbers and even true. Only a trimmed, positive, finite decimal
    // string is accepted (no exponent, no separators, no sign).
    if (payload?.success !== true) return null;
    const raw = payload?.data?.value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    return asFinitePositive(trimmed);
};

// EXACT pair validation (lead review 2026-10-17): the provider contract
// (https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate)
// is unambiguous — `from` is an ENUM of stablecoin codes (USDC, USDT, CGHS,
// CKES, ...) and `to` is the FIAT payout code ("GHS" for a cedi offramp;
// CGHS is a stablecoin listed under `from`, NOT the fiat code). A CGHS echo
// for a GHS request is therefore a DIFFERENT instrument, not an alias: codes
// are related, but the codes do not describe the same instrument, so a
// "related code" equivalence is exactly how a foreign-pair rate could be
// laundered into the canonical USDC/GHS slot. Validation is EXACT
// (case-insensitive, trimmed) — no prefix, no "near enough" families.
const sameCurrencyCode = (requested, echoed) => {
    if (requested === undefined || requested === null || echoed === undefined || echoed === null) {
        return false;
    }
    const a = String(requested).trim().toUpperCase();
    const b = String(echoed).trim().toUpperCase();
    return a === b && a.length > 0;
};

// Validates that the response echoes the pair we requested. Fail-closed
// semantics: a response with NO echoed pair, or a mismatched one, must
// never be trusted as the requested rate.
const kotaniPairMatches = (payload, expectedFrom, expectedTo) => {
    // Strict-schema review (2026-10-23): the documented v3 envelope echoes
    // the pair ONLY at data.from/data.to. The earlier root-level from/to
    // fallback accepted an undocumented shape; a strict envelope must not
    // be lenient about WHERE validation fields live, or a foreign shape can
    // satisfy the pair check while smuggling an unvalidated rate.
    const echoedFrom = payload?.data?.from;
    const echoedTo = payload?.data?.to;
    if (!sameCurrencyCode(expectedFrom, echoedFrom)) return false;
    if (!sameCurrencyCode(expectedTo, echoedTo)) return false;
    return true;
};

class OracleService {
    constructor(prisma) {
        this.prisma = prisma;
        this.updateInterval = 10 * 60 * 1000;
        this.rateAlertService = null;
    }

    startOracle() {
        logger.info('🌐 Azaman Live Market Oracle: INITIALIZED');
        this.logKotaniConfigAudit();
        this.fetchAndUpdateRates();
        setInterval(() => this.fetchAndUpdateRates(), this.updateInterval);
    }

    // ── SANDBOX-FALLBACK HARDENING (review follow-up on PR #353) ──────────
    //
    // Risk A — a misconfigured deployment is silent. `provider !== 'LIVE'`
    // or a placeholder token made the oracle return null and collapse
    // into the SAME generic fail-closed log as a Kotani outage: a
    // production deployment missing KOTANI_PROVIDER/KOTANI_API_TOKEN was
    // indistinguishable from an outage until quotes began failing
    // RATE_STALE. The arm state is now computed in ONE place, logged ONCE
    // LOUDLY at startup, and every cycle's fail-closed log names WHICH of
    // the two states it is (CONFIG_DISABLED vs UNAVAILABLE).
    //
    // Risk B — the DEFAULT base URL is the SANDBOX endpoint. A LIVE
    // provider with KOTANI_API_BASE_URL unset silently sent production
    // traffic to sandbox-api.kotanipay.io — a sandbox fallback baked into
    // the default. Using the sandbox during onboarding is legitimate, but
    // it must be an EXPLICIT choice: the startup audit names the endpoint
    // and says when it is the default-sandbox one, so promotion can be
    // checked from the logs at a glance.
    // Production endpoint policy (lead review 2026-10-17, fix A):
    //
    // A sandbox endpoint must NEVER become the production transaction-rate
    // source — not by default and not even by explicit configuration.
    //   • In PRODUCTION (NODE_ENV=production), a LIVE provider is armed ONLY
    //     with an explicitly configured endpoint that is not a sandbox host.
    //     No KOTANI_API_BASE_URL → NOT ARMED (the previous behavior silently
    //     sent production traffic to the sandbox default). An explicit
    //     sandbox endpoint in production → NOT ARMED (rejected by policy).
    //   • OUTSIDE production (development/onboarding), the sandbox default
    //     remains available for explicit onboarding/testing, but it is
    //     always named loudly in the audit log as the ONBOARDING SANDBOX —
    //     it can never silently become production authority because
    //     production arming requires the explicit approved endpoint.
    kotaniConfigState() {
        const provider = String(process.env.KOTANI_PROVIDER || 'MOCK').toUpperCase();
        const token = process.env.KOTANI_API_TOKEN || process.env.KOTANI_API_KEY;
        const explicitBaseUrl = process.env.KOTANI_API_BASE_URL
            ? String(process.env.KOTANI_API_BASE_URL).replace(/\/$/, '')
            : null;
        const isProduction = process.env.NODE_ENV === 'production';
        // Fail-closed match: ANY 'sandbox' marker anywhere in the endpoint
        // URL (host or path) marks it as a sandbox endpoint. False
        // positives (a production URL that contains 'sandbox') fail CLOSED
        // — the operator must configure a clean production endpoint.
        const isSandboxEndpoint = (url) => String(url).toLowerCase().includes('sandbox');
        const baseUrl = explicitBaseUrl || KOTANI_DEFAULT_BASE_URL;

        if (provider !== 'LIVE') {
            return {
                armed: false,
                state: 'CONFIG_DISABLED',
                detail: `KOTANI_PROVIDER='${provider}' — the canonical transaction-rate source is DISABLED BY CONFIGURATION. `
                    + 'Quotes fail closed (RATE_UNAVAILABLE/RATE_STALE) once the cached observation ages out. '
                    + 'Set KOTANI_PROVIDER=LIVE with a real KOTANI_API_TOKEN to arm it.',
                provider,
                baseUrl,
                baseUrlExplicit: !!explicitBaseUrl,
            };
        }
        if (!token || token === 'mock-key') {
            return {
                armed: false,
                state: 'MISSING_TOKEN',
                detail: `KOTANI_PROVIDER=LIVE but the token is ${token ? "the placeholder 'mock-key'" : 'not set'} `
                    + '(KOTANI_API_TOKEN/KOTANI_API_KEY). The canonical transaction-rate source is DISABLED BY '
                    + 'CONFIGURATION; quotes fail closed once the cached observation ages out.',
                provider,
                baseUrl,
                baseUrlExplicit: !!explicitBaseUrl,
            };
        }
        // LIVE + a real token. From here the ENDPOINT decides arming.
        if (isProduction) {
            if (!explicitBaseUrl) {
                return {
                    armed: false,
                    state: 'MISSING_ENDPOINT',
                    detail: 'KOTANI_PROVIDER=LIVE in PRODUCTION but KOTANI_API_BASE_URL is NOT SET. '
                        + 'A production transaction-rate provider FAILS CLOSED without an explicitly configured '
                        + 'production endpoint: the sandbox default is NOT a production source, so no Kotani '
                        + 'observation will be attempted and quotes fail closed (RATE_UNAVAILABLE/RATE_STALE). '
                        + 'Set the verified production KOTANI_API_BASE_URL to arm it.',
                    provider,
                    baseUrl: null,
                    baseUrlExplicit: false,
                };
            }
            if (isSandboxEndpoint(explicitBaseUrl)) {
                return {
                    armed: false,
                    state: 'SANDBOX_ENDPOINT_REJECTED',
                    detail: `KOTANI_API_BASE_URL='${explicitBaseUrl}' is a SANDBOX endpoint and is REJECTED BY POLICY `
                        + 'in production: a sandbox observation must never be the production transaction-rate '
                        + 'authority. The provider is NOT armed; quotes fail closed (RATE_UNAVAILABLE/RATE_STALE). '
                        + 'Configure the verified production endpoint to arm it.',
                    provider,
                    baseUrl: null,
                    baseUrlExplicit: true,
                };
            }
            // §1 (review follow-up 2026-10-18): production arming additionally
            // requires an HTTPS endpoint ON A HOST KOTANI HAS VERIFIED. A
            // plaintext endpoint (credential/rate interception) or an
            // unverified host (typosquat / lookalike provider) must NEVER
            // become the production rate authority. Until Kotani onboarding
            // confirms the production hostname, this fails CLOSED for every
            // host — by design.
            let parsedEndpoint;
            try {
                parsedEndpoint = new URL(explicitBaseUrl);
            } catch (err) {
                return {
                    armed: false,
                    state: 'INVALID_ENDPOINT',
                    detail: `KOTANI_API_BASE_URL='${explicitBaseUrl}' is not a parseable URL and is REJECTED BY POLICY `
                        + 'in production. The provider is NOT armed; quotes fail closed. Configure the verified '
                        + 'production endpoint to arm it.',
                    provider,
                    baseUrl: null,
                    baseUrlExplicit: true,
                };
            }
            if (parsedEndpoint.protocol !== 'https:') {
                return {
                    armed: false,
                    state: 'NON_HTTPS_ENDPOINT_REJECTED',
                    detail: `KOTANI_API_BASE_URL='${explicitBaseUrl}' is NOT an https:// endpoint and is REJECTED `
                        + 'BY POLICY in production: transaction-rate credentials and observations must travel over '
                        + 'TLS. The provider is NOT armed; quotes fail closed. Configure the verified https:// '
                        + 'production endpoint to arm it.',
                    provider,
                    baseUrl: null,
                    baseUrlExplicit: true,
                };
            }
            if (!KOTANI_VERIFIED_PRODUCTION_HOSTS.includes(parsedEndpoint.hostname)) {
                return {
                    armed: false,
                    state: 'UNVERIFIED_PRODUCTION_HOST',
                    detail: `KOTANI_API_BASE_URL host '${parsedEndpoint.hostname}' is NOT on the verified production `
                        + 'host allowlist (services/oracleService.js KOTANI_VERIFIED_PRODUCTION_HOSTS). Production '
                        + 'arming fails CLOSED until Kotani onboarding confirms the production hostname in writing '
                        + 'and the operator adds it to the allowlist. The provider is NOT armed; quotes fail closed '
                        + '(RATE_UNAVAILABLE/RATE_STALE).',
                    provider,
                    baseUrl: null,
                    baseUrlExplicit: true,
                };
            }
            return {
                armed: true,
                state: 'ARMED',
                detail: `Kotani LIVE provider ARMED against the explicitly configured verified production endpoint `
                    + `${explicitBaseUrl} (host confirmed by Kotani onboarding, https-only policy satisfied).`,
                provider,
                baseUrl: explicitBaseUrl,
                baseUrlExplicit: true,
            };
        }

        // Non-production (development/onboarding): the sandbox default is
        // available, but it is always NAMED as the onboarding sandbox — it
        // can never silently become production authority because production
        // arming requires the explicit approved endpoint (see above).
        return {
            armed: true,
            state: explicitBaseUrl ? 'ARMED' : 'ARMED_ONBOARDING_SANDBOX',
            detail: explicitBaseUrl
                ? `Kotani LIVE provider ARMED against ${explicitBaseUrl} (non-production).`
                : `Kotani LIVE provider ARMED in ONBOARDING SANDBOX mode — KOTANI_API_BASE_URL is NOT SET, so the `
                    + `DEFAULT SANDBOX endpoint is in use (${KOTANI_DEFAULT_BASE_URL}). Legitimate for onboarding `
                    + 'and testing outside production only.',
            provider,
            baseUrl: baseUrl,
            baseUrlExplicit: !!explicitBaseUrl,
        };
    }

    // One loud, startup-visible statement of the arm state (Risk A/B).
    logKotaniConfigAudit() {
        const cfg = this.kotaniConfigState();
        if (cfg.armed) {
            const log = cfg.baseUrlExplicit ? logger.info : logger.warn;
            log(`[Oracle] Kotani config audit: ${cfg.detail}`);
        } else {
            logger.error(`[Oracle] Kotani config audit: ${cfg.detail}`);
        }
        return cfg;
    }

    // P0 review (2026-10-18) — HARD-BOUND canonical currency pair.
    //
    // The canonical transaction rate slot (liveRetailRate) describes
    // USDC/GHS and nothing else. KOTANI_RATE_FROM/KOTANI_RATE_TO overrides
    // are NO LONGER honored as a way to request a different pair: any
    // override value other than exactly USDC -> GHS is a deployment error
    // and fails closed BEFORE Kotani is called, so a valid USDT/GHS (or
    // any other pair) response can never be accepted as a USDC/GHS quote.
    // Empty/unset values fall back to the canonical pair.
    _canonicalKotaniPair() {
        const rawFrom = process.env.KOTANI_RATE_FROM;
        const rawTo = process.env.KOTANI_RATE_TO;
        const from = (rawFrom === undefined || String(rawFrom).trim() === '')
            ? CANONICAL_RATE_FROM
            : String(rawFrom).trim().toUpperCase();
        const to = (rawTo === undefined || String(rawTo).trim() === '')
            ? CANONICAL_RATE_TO
            : String(rawTo).trim().toUpperCase();
        if (from !== CANONICAL_RATE_FROM || to !== CANONICAL_RATE_TO) {
            throw new Error(
                `[KOTANI_PAIR_OVERRIDE_REJECTED] KOTANI_RATE_FROM/KOTANI_RATE_TO `
                + `override "${from}->${to}" is not the canonical transaction pair `
                + `${CANONICAL_RATE_FROM}->${CANONICAL_RATE_TO}; refusing to request a foreign `
                + 'pair — the canonical USDC/GHS slot can never be fed from another pair.'
            );
        }
        return { from: CANONICAL_RATE_FROM, to: CANONICAL_RATE_TO };
    }

    async fetchKotaniUsdcToGhsRate() {
        const cfg = this.kotaniConfigState();
        if (!cfg.armed) {
            // Distinct, greppable per-cycle tag: an operator can tell a
            // DISABLED-BY-CONFIG deployment from a Kotani outage instantly.
            logger.error(
                `[Oracle] [KOTANI_CONFIG_DISABLED] ${cfg.state}: no Kotani observation will be attempted this cycle. ${cfg.detail}`
            );
            return null;
        }

        const baseUrl = cfg.baseUrl;
        // P0 (2026-10-18): the pair is HARD-BOUND to the canonical
        // USDC -> GHS transaction pair. _canonicalKotaniPair() throws
        // (fail-closed, greppable) if an operator override tries to point
        // the canonical slot at any other pair — the request is never sent.
        const { from, to } = this._canonicalKotaniPair();
        const response = await axios.post(`${baseUrl}/rate/offramp`, {
            from,
            to,
            cryptoAmount: 1,
        }, {
            headers: { Authorization: `Bearer ${process.env.KOTANI_API_TOKEN || process.env.KOTANI_API_KEY}` },
            timeout: 8000,
        });

        // A2/D hardening: the documented v3 envelope must EXPLICITLY declare
        // success (auth/quota failures arrive as HTTP 200 with
        // success:false, and an envelope with NO success field is not the
        // documented response of this endpoint — a missing declaration is
        // treated as an unvalidated observation, not as success). Then the
        // echoed pair and the rate value are validated; anything else fails
        // closed with a distinct, greppable tag.
        if (response.data?.success !== true) {
            throw new Error(
                `[KOTANI_RATE_REJECTED] Kotani did not explicitly declare success:true `
                + `(success=${JSON.stringify(response.data?.success ?? null)}, message=${JSON.stringify(response.data?.message ?? null)}) `
                + '— the observation is rejected, not parsed.'
            );
        }
        if (!kotaniPairMatches(response.data, from, to)) {
            const echoedFrom = response.data?.data?.from;
            const echoedTo = response.data?.data?.to;
            throw new Error(
                `[KOTANI_RATE_PAIR_MISMATCH] requested ${from}->${to} but Kotani echoed `
                + `${JSON.stringify(echoedFrom ?? null)}->${JSON.stringify(echoedTo ?? null)} `
                + '— a foreign-pair response must never write the canonical USDC/GHS rate.'
            );
        }
        const rate = extractKotaniRate(response.data);
        if (!rate) throw new Error('[KOTANI_RATE_UNPARSEABLE] Kotani Pay rate response did not contain a usable USDC/GHS rate.');
        return rate;
    }

    // §Kotani-only transaction-rate authority (2026-10-16 hardening wave).
    //
    // Kotani Pay is the single canonical USDC/GHS transaction-rate provider.
    // The contract, preserved from the §271 per-source isolation work and
    // tightened from "fallback allowed" to "Kotani-only":
    //
    //   • ONLY a successfully validated Kotani observation may write the
    //     transaction-eligible liveRetailRate, the canonical liveRateSource
    //     ('KOTANI_PAY') and the freshness timestamps
    //     (lastRateSync === lastExternalSync, one observation, both fields —
    //     the 271B contract).
    //
    //   • The legacy CoinGecko USDC/USD × external USD/GHS FX composite is
    //     RETIRED as a rate source: it must never write liveRetailRate /
    //     liveRateSource and must never refresh canonical transaction-rate
    //     freshness. A successful supplementary feed must not launder the
    //     cached rate into "fresh" — a cached old value stays old.
    //
    //   • Stablecoin prices (tether/usdc/dai vs USD) remain SUPPLEMENTARY
    //     DISPLAY-ONLY data: cached in their dedicated non-authoritative
    //     GlobalSettings fields, never blocking the canonical write, and
    //     never advancing any freshness timestamp. When Kotani is missing
    //     (unconfigured/MOCK), fails, returns malformed data, or is stale,
    //     the sync performs at most this supplementary display refresh and
    //     NOTHING else — new rate-dependent financial quotes fail closed at
    //     the /rateFreshness gate (RATE_STALE / RATE_UNAVAILABLE).
    //
    //   Repeated Kotani failure: cached values and ALL timestamps stay
    //   untouched — no code path can present the frozen number as fresh.
    //   Recovery: the next successful Kotani observation simply resumes.
    async fetchStablecoinUsdPrices() {
        const cryptoResponse = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin,dai&vs_currencies=usd',
            { timeout: 8000 }
        );
        const tetherPrice = asFinitePositive(cryptoResponse.data?.tether?.usd);
        const usdcPrice = asFinitePositive(cryptoResponse.data?.['usd-coin']?.usd);
        const daiPrice = asFinitePositive(cryptoResponse.data?.dai?.usd);
        if (!tetherPrice || !usdcPrice || !daiPrice) {
            throw new Error('CoinGecko returned incomplete stablecoin rates.');
        }
        return { tetherPrice, usdcPrice, daiPrice };
    }

    // Supplementary display-only refresh. Deliberately uses update (not
    // upsert): a supplementary-only observation may never create or reshape
    // the canonical GlobalSettings row. Deliberately touches ONLY the
    // dedicated stablecoin display fields — no canonical rate, no source,
    // no freshness timestamp.
    async _updateSupplementaryDisplayRates() {
        let stablecoins = null;
        try {
            stablecoins = await this.fetchStablecoinUsdPrices();
        } catch (err) {
            logger.warn(
                { err },
                '[Oracle] Supplementary stablecoin prices unavailable; prior display values preserved.'
            );
            return;
        }
        try {
            await this.prisma.globalSettings.update({
                where: { id: 1 },
                data: {
                    liveUsdtToUsd: stablecoins.tetherPrice,
                    liveUsdcToUsd: stablecoins.usdcPrice,
                    liveDaiToUsd: stablecoins.daiPrice,
                },
            });
            logger.info(
                '[Oracle] Supplementary display rates refreshed (non-authoritative; transaction-rate freshness untouched).'
            );
        } catch (err) {
            logger.warn(
                { err },
                '[Oracle] Supplementary display update skipped (settings row unavailable or DB error); canonical fields untouched.'
            );
        }
    }

    async fetchAndUpdateRates() {
        try {
            // ── CANONICAL source: Kotani direct USDC/GHS ───────────────────
            let usdcToGhsRate = null;
            try {
                usdcToGhsRate = await this.fetchKotaniUsdcToGhsRate();
            } catch (kotaniErr) {
                logger.warn(
                    { err: kotaniErr },
                    '[Oracle] [KOTANI_UNAVAILABLE] the LIVE provider is armed but the canonical USDC/GHS observation failed — outage path, NOT a configuration problem.'
                );
            }

            if (!usdcToGhsRate) {
                // Kotani is missing (unconfigured/MOCK), failed, or returned
                // a malformed response. There is NO fallback transaction rate:
                // the retired FX × CoinGecko composite must never write the
                // canonical fields or refresh freshness. At most the
                // supplementary display cache is refreshed; the cached
                // canonical rate, its source and every freshness timestamp
                // stay untouched, so the 271C gate fails new quotes closed
                // once the last genuine Kotani observation ages out.
                logger.error(
                    '[Oracle] No valid Kotani USDC/GHS observation — canonical retail rate, source and freshness preserved (fail-closed; no fallback rate).'
                );
                await this._updateSupplementaryDisplayRates();
                return;
            }

            // ── SUPPLEMENTARY source: stablecoin USD prices (display-only) ──
            // Never blocking the canonical write; failure leaves the prior
            // display values preserved.
            let stablecoins = null;
            try {
                stablecoins = await this.fetchStablecoinUsdPrices();
            } catch (err) {
                logger.warn(
                    { err },
                    '[Oracle] Stablecoin price update unavailable (non-blocking); prior values preserved.'
                );
            }

            // ── ONE success-only canonical write (Kotani observation) ─────
            // One observation timestamp for both freshness fields (issue
            // #271 / PR 271B): the oracle is the canonical success-only
            // EXTERNAL writer, so lastRateSync and lastExternalSync always
            // describe the same successful Kotani observation. On failure
            // the cached rate and both timestamps are left untouched (see
            // the fail-closed branch above).
            // SERVICE-OBSERVATION freshness policy (fix D): the documented
            // v3 response carries NO provider-side observation time and no
            // expiry field, so there is no provider timestamp to copy or
            // trust. lastRateSync/lastExternalSync therefore mean exactly
            // what their names say: the SERVICE time at which a validated
            // Kotani observation was received and written. No provider
            // timestamp is ever invented, and no future/expired
            // provider-time claim is possible on this contract.
            const observationTimestamp = new Date();
            // B fix (lead review 2026-10-17): liveUsdToGhs is the LEGACY
            // USD/GHS compatibility field — a USDC/GHS observation must
            // NEVER be written into it merely to keep the two fields equal.
            // The canonical transaction rate (1 USDC → X GHS) lives in
            // liveRetailRate alone; liveUsdToGhs is left untouched by the
            // oracle (it remains whatever the admin override or the legacy
            // era left there, and is never refreshed by this service).
            const update = {
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: 'KOTANI_PAY',
            };
            const create = {
                id: 1,
                liveRetailRate: usdcToGhsRate,
                lastRateSync: observationTimestamp,
                lastExternalSync: observationTimestamp,
                liveRateSource: 'KOTANI_PAY',
            };
            if (stablecoins) {
                update.liveUsdtToUsd = stablecoins.tetherPrice;
                update.liveUsdcToUsd = stablecoins.usdcPrice;
                update.liveDaiToUsd = stablecoins.daiPrice;
                create.liveUsdtToUsd = stablecoins.tetherPrice;
                create.liveUsdcToUsd = stablecoins.usdcPrice;
                create.liveDaiToUsd = stablecoins.daiPrice;
            }
            await this.prisma.globalSettings.upsert({
                where: { id: 1 },
                update,
                create,
            });

            logger.info(`📈 Oracle Sync: 1 USDC ≈ ${usdcToGhsRate} GHS | source=KOTANI_PAY`);

            // FX-balance workstream — persist the LAST SUCCESSFULLY VALIDATED
            // observation as the display-only saved-rate snapshot. This call
            // sits AFTER the canonical GlobalSettings write and is strictly
            // failure-isolated: the canonical current rate + freshness
            // timestamps above remain the 271B/271C authority, and a snapshot
            // persistence problem must never turn a successful oracle sync
            // into a failure (or leave the upsert half-described). The
            // snapshot is a separate display concept and is never transaction
            // authorization.
            try {
                // Provenance is the SAME literal the canonical write
                // stamps (liveRateSource: 'KOTANI_PAY'). Post-#353 this
                // sync path is Kotani-only: no FALLBACK_FX observation can
                // reach it, so the snapshot provenance is identical to the
                // canonical one by construction — never a separate or
                // client-supplied value.
                const result = await saveValidatedRateSnapshot({
                    prisma: this.prisma,
                    pair: FX_SAVED_RATE_PAIR,
                    rate: usdcToGhsRate,
                    source: 'KOTANI_PAY',
                    observedAt: observationTimestamp,
                    validation: {
                        validationStatus: 'CANONICAL',
                        oracleWrite: 'SUCCESS_ONLY_EXTERNAL',
                        freshnessField: 'lastExternalSync',
                    },
                });
                if (!result.saved) {
                    logger.warn(
                        `[Oracle] Saved-rate snapshot not updated: ${result.reason}`
                    );
                }
            } catch (snapshotErr) {
                logger.error(
                    { err: snapshotErr },
                    '[Oracle] Saved-rate snapshot persistence failed (non-fatal) — canonical rate write is unaffected.'
                );
            }

            if (this.rateAlertService && usdcToGhsRate) {
                setImmediate(() => {
                    this.rateAlertService.checkAlerts(usdcToGhsRate, 'USDC_GHS')
                        .catch(err => logger.error({ err }, '[Oracle] alert check error'));
                });
            }
        } catch (error) {
            logger.error({ err: error }, '🚨 Oracle Sync Failed. Existing cached rate and every freshness timestamp preserved.');
        }
    }
}

module.exports = OracleService;
module.exports.extractKotaniRate = extractKotaniRate;
module.exports.kotaniPairMatches = kotaniPairMatches;
module.exports.KOTANI_VERIFIED_PRODUCTION_HOSTS = KOTANI_VERIFIED_PRODUCTION_HOSTS;
