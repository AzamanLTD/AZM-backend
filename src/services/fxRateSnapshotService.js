'use strict';

// FX saved-rate snapshot service (FX-balance workstream).
//
// Persists the LAST SUCCESSFULLY VALIDATED external USDC/GHS observation and
// exposes it as a strictly DISPLAY-ONLY fallback. The canonical CURRENT rate
// remains GlobalSettings.liveRetailRate + lastExternalSync (271B/271C
// authority); this snapshot is a separate concept and must never be labelled
// fresh, current or executable.
//
// Hard contracts proven by __tests__/fx-rate-snapshot.test.js:
//   • saveValidatedRateSnapshot writes ONLY a validated observation: the
//     canonical pair, a positive finite rate, a real source, and a parseable
//     non-future observedAt. A failed/stale/malformed/noncanonical update is
//     refused and NEVER overwrites a valid saved rate.
//   • A DEMO seed (isDemoSeed = true, source DEMO_SEED) never overwrites a
//     genuine saved observation; a genuine observation DOES replace a demo
//     seed (reality supersedes demo).
//   • Display eligibility (getSavedRateForDisplay) is evaluated SERVER-SIDE
//     from the persisted observedAt against the fxDisplayPolicy maximum age,
//     with the exact boundary age == max → eligible, age > max → ineligible.
//     Repeated requests or client clocks cannot extend eligibility.
//   • Demo rows are display-eligible only in explicit demo/test environments
//     and NEVER make any transaction gate pass.

const { Prisma } = require('@prisma/client');
const {
    FX_SAVED_RATE_PAIR,
    FX_SAVED_RATE_MAX_AGE_MS,
} = require('../config/fxDisplayPolicy');
const {
    DEMO_RATE_GHS_PER_USDC,
    DEMO_RATE_SOURCE,
    demoModeRateSeedEnabled,
} = require('../config/demoRateSeed');

const SNAPSHOT_CLOCK_SKEW_ALLOWANCE_MS = 5_000;

class SnapshotValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SnapshotValidationError';
    }
}

function _coerceDecimal(value, label) {
    let d;
    try {
        d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    } catch (_) {
        throw new SnapshotValidationError(`${label} is not a finite decimal: ${String(value)}`);
    }
    if (!d.isFinite() || !d.greaterThan(0)) {
        throw new SnapshotValidationError(`${label} must be a positive finite decimal: ${String(value)}`);
    }
    return d;
}

/**
 * Persist a VALIDATED external observation as the saved-rate snapshot.
 *
 * Called ONLY from the oracle's success-only external write path (and from
 * the demo seeder via `isDemoSeed: true`). A throw here must be isolated by
 * the caller (log-only) — a snapshot persistence failure never fails the
 * canonical GlobalSettings write, which remains the authoritative current
 * rate.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {string} args.pair            canonical pair 'USDC/GHS' (GHS per 1 USDC)
 * @param {string|number|Decimal} args.rate positive finite GHS-per-USDC
 * @param {string} args.source          provider provenance (KOTANI_PAY, FALLBACK_FX, ...)
 * @param {Date}    args.observedAt     external observation timestamp (UTC)
 * @param {boolean} [args.isDemoSeed]   true only for the explicit demo seed
 * @param {object}  [args.validation]   freshness/canonicality metadata to retain
 * @param {Date}    [args.now]          clock override for tests
 */
async function saveValidatedRateSnapshot({
    prisma,
    pair,
    rate,
    source,
    observedAt,
    isDemoSeed = false,
    validation,
    now = new Date(),
}) {
    if (!prisma) throw new SnapshotValidationError('prisma client is required');
    if (pair !== FX_SAVED_RATE_PAIR) {
        throw new SnapshotValidationError(
            `noncanonical pair "${pair}" — the snapshot authority is ${FX_SAVED_RATE_PAIR} only`
        );
    }
    const rateExact = _coerceDecimal(rate, 'rate');
    if (typeof source !== 'string' || source.trim() === '') {
        throw new SnapshotValidationError('source provenance is required');
    }
    const observedMs = observedAt instanceof Date ? observedAt.getTime() : NaN;
    if (!Number.isFinite(observedMs)) {
        throw new SnapshotValidationError('observedAt must be a parseable Date (UTC)');
    }
    const nowMs = new Date(now).getTime();
    if (observedMs > nowMs + SNAPSHOT_CLOCK_SKEW_ALLOWANCE_MS) {
        throw new SnapshotValidationError(
            'observation timestamp is in the future beyond clock-skew allowance — untrusted, never saved'
        );
    }

    const existing = await prisma.fxSavedRate.findUnique({ where: { pair } });

    // DEMO never overwrites REALITY: a demo seed is refused when a genuine
    // saved observation exists. A genuine observation replaces a demo seed.
    if (isDemoSeed && existing && !existing.isDemoSeed) {
        return { saved: false, reason: 'GENUINE_SAVED_RATE_PRESENT', snapshot: existing };
    }
    if (isDemoSeed && existing && existing.isDemoSeed) {
        // Idempotent demo re-seed: keep the original observedAt provenance.
        return { saved: false, reason: 'DEMO_SEED_ALREADY_PRESENT', snapshot: existing };
    }

    const data = {
        pair,
        rate: rateExact,
        source: isDemoSeed ? DEMO_RATE_SOURCE : source,
        observedAt: new Date(observedMs),
        isDemoSeed,
        validation: {
            pairValidated: true,
            positiveFiniteRate: true,
            savedBy: isDemoSeed ? 'DEMO_SEEDER' : 'ORACLE_SUCCESS_PATH',
            validationStatus: 'CANONICAL',
            ...(validation ?? {}),
        },
    };

    const snapshot = await prisma.fxSavedRate.upsert({
        where: { pair },
        update: { ...data, savedAt: new Date(nowMs) },
        create: { ...data, savedAt: new Date(nowMs) },
    });

    return { saved: true, snapshot };
}

/**
 * Seed the explicit demo rate (1 USDC = GHS 12.03) as a DEMO-ONLY saved
 * snapshot. Refuses to touch a genuine observation (see above). This is the
 * only writer that sets isDemoSeed = true; it is intended for demo/test
 * provisioning (overlay installer, disposable CI DB) — never production.
 */
async function seedDemoRateSnapshot({ prisma, now = new Date() }) {
    return saveValidatedRateSnapshot({
        prisma,
        pair: FX_SAVED_RATE_PAIR,
        rate: new Prisma.Decimal(DEMO_RATE_GHS_PER_USDC),
        source: DEMO_RATE_SOURCE,
        // A demo seed's "observation" time is the moment it was seeded — it
        // is honestly NOT a market observation, and the display contract
        // marks the row isDemoSeed so the UI says so.
        observedAt: now,
        isDemoSeed: true,
        now,
        validation: { demoSeed: true, demoRateGhsPerUsdc: DEMO_RATE_GHS_PER_USDC },
    });
}

function _serializeSnapshot(row, { eligible }) {
    return {
        pair: row.pair,
        rate: Number(row.rate),
        rateExact: new Prisma.Decimal(row.rate).toFixed(8),
        source: row.source,
        observedAt: row.observedAt,
        savedAt: row.savedAt,
        isDemoSeed: row.isDemoSeed,
        eligibleForDisplayFallback: eligible,
    };
}

/**
 * Resolve the saved-rate snapshot for DISPLAY purposes.
 *
 * Returns null when there is no row, or when the row is ineligible:
 *   • beyond the fxDisplayPolicy maximum age (boundary-exact, server-side),
 *   • a demo seed outside an explicit demo/test environment.
 *
 * The result is display-only metadata — it must never be fed to any
 * transaction gate.
 */
async function getSavedRateForDisplay({ prisma, now = new Date(), maxAgeMs = FX_SAVED_RATE_MAX_AGE_MS }) {
    if (!prisma) throw new SnapshotValidationError('prisma client is required');
    const row = await prisma.fxSavedRate.findUnique({ where: { pair: FX_SAVED_RATE_PAIR } });
    if (!row) return null;

    // Demo rows are display-eligible ONLY in explicit demo/test environments.
    if (row.isDemoSeed && !demoModeRateSeedEnabled()) return null;

    // Boundary contract, evaluated server-side from persisted observedAt:
    //   age <= maxAgeMs → eligible; age > maxAgeMs → ineligible. There is no
    // client-supplied input anywhere in the comparison.
    const ageMs = new Date(now).getTime() - new Date(row.observedAt).getTime();
    const eligible = Number.isFinite(ageMs) && ageMs <= maxAgeMs;

    return _serializeSnapshot(row, { eligible });
}

module.exports = {
    SnapshotValidationError,
    saveValidatedRateSnapshot,
    seedDemoRateSnapshot,
    getSavedRateForDisplay,
    FX_SAVED_RATE_PAIR,
};
