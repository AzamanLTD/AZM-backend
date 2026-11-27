#!/usr/bin/env node
'use strict';

/**
 * WP-I — operator entrypoint for the separate provider settlement reconciler.
 *
 *   node workers/run-provider-settlement-reconciler.js <openingDedupKey> [more...]
 *
 * This runs OUTSIDE the API process on purpose. A second credential inside the
 * API process would be theatre (a compromised process reads it from memory);
 * a separate component with its own provider credential and its own database
 * login is what actually limits a runtime compromise.
 *
 * It refuses to start without every one of its own credentials. Nothing here
 * is scheduled automatically: wiring this to a cron or a Render cron job is an
 * explicit activation decision, not a side effect of deploying the API.
 *
 * Environment (all required, all distinct from the API process):
 *   AZM_RECONCILER_MODE=1              writer guard
 *   AZM_RECONCILER_PROVIDER_USER + AZM_RECONCILER_PROVIDER_PUBKEY        provider API credential
 *   WITNESS_DATABASE_URL               reconciler DB login (INSERT on the witness only)
 *   WITNESS_ACCOUNT_CURRENCY_MAP       {"WALLET-ACCOUNT":"GHS", ...}
 *
 * EXIT CONTRACT (machine-readable, because a scheduler reads the code, not the
 * log). A refused opening is NOT a reconciliation: exiting 0 while an opening
 * went unwitnessed would report a successful run over money never proved.
 *
 *   0  every requested opening was witnessed, or was already authoritatively
 *      witnessed, in this run
 *   1  usage or credential refusal - nothing was attempted
 *   2  fatal error - the run could not complete
 *   3  one or more requested openings did NOT receive a witness (refused,
 *      parked, not found, not eligible, provider not settled, transport
 *      unknown), or the batch came back empty or shorter than requested.
 *      Per-opening reasons are in the JSON on stdout.
 *
 * 3 is deliberately distinct from 2: a refusal is a truthful answer about the
 * provider, not a broken run, and an alert triager must tell them apart.
 */

const { reconcileTreasuryOpenings } = require('./providerSettlementReconciler');

// One entry per variable the process actually needs. An earlier version listed
// the two provider credentials as a single combined string, so process.env[...]
// was always undefined and this entrypoint could never start. The old test could
// not see it: deleting a name that is not set is a no-op, so every deletion
// "proved" a refusal.
const EXIT = Object.freeze({
    OK: 0,
    USAGE: 1,
    FATAL: 2,
    NOT_WITNESSED: 3,
});

/**
 * Map a completed batch to its exit code.
 *
 * Only a batch where EVERY requested opening came back with `witnessed === true`
 * may exit 0. A refusal, a pending provider state, an unknown opening or a
 * thrown per-opening error is NOT_WITNESSED. So is an EMPTY batch (the
 * invocation required at least one key, so no results means the request was
 * not honoured) and a PARTIAL batch (an opening silently dropped somewhere must
 * not be reported as funded). A non-array result is a broken run: FATAL.
 */
function exitCodeForResults(results, requested = null) {
    if (!Array.isArray(results)) return EXIT.FATAL;
    if (results.length === 0) return EXIT.NOT_WITNESSED;
    if (!results.every((r) => r && r.witnessed === true)) return EXIT.NOT_WITNESSED;
    // Key-exact when the requested keys are known: every requested opening must
    // have its OWN witnessed result. Two results for key A cannot stand in for
    // a missing key B, which a count comparison would allow.
    if (Array.isArray(requested)) {
        const witnessedKeys = new Set(results.map((r) => r.openingDedupKey));
        return requested.every((key) => witnessedKeys.has(key)) ? EXIT.OK : EXIT.NOT_WITNESSED;
    }
    if (Number.isInteger(requested) && results.length < requested) return EXIT.NOT_WITNESSED;
    return EXIT.OK;
}

const REQUIRED_ENV = [
    'AZM_RECONCILER_MODE',
    'AZM_RECONCILER_PROVIDER_USER',
    'AZM_RECONCILER_PROVIDER_PUBKEY',
    'WITNESS_DATABASE_URL',
    'WITNESS_ACCOUNT_CURRENCY_MAP',
];

function main(argv) {
    const openingDedupKeys = argv.slice(2).filter((a) => a && !a.startsWith('-'));
    if (openingDedupKeys.length === 0) {
        process.stderr.write('usage: node workers/run-provider-settlement-reconciler.js <openingDedupKey> [...]\n');
        return EXIT.USAGE;
    }
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        // Fail closed and say exactly what is missing. Running with a partial
        // credential set would mean guessing at authority.
        process.stderr.write(`[wp-i reconciler] refusing to run: missing ${missing.join(', ')}\n`);
        return EXIT.USAGE;
    }
    // Presence is not consent: AZM_RECONCILER_MODE=0 or "true" must not open the
    // writer guard, so the VALUE is checked here and again in the worker.
    if (process.env.AZM_RECONCILER_MODE !== '1') {
        process.stderr.write(
            `[wp-i reconciler] refusing to run: AZM_RECONCILER_MODE must be exactly 1, got ${JSON.stringify(process.env.AZM_RECONCILER_MODE)}\n`
        );
        return EXIT.USAGE;
    }

    return reconcileTreasuryOpenings({ openingDedupKeys })
        .then((results) => {
            // Machine-readable: the operator (or an alert) reads this, so it
            // states per-opening truth rather than a summary that hides refusals.
            // netPesewas is a BigInt (exact money), which JSON.stringify
            // refuses by default. Serialize it as a decimal STRING so no
            // precision is lost on the way to the operator.
            const json = JSON.stringify({ results }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
            process.stdout.write(`${json}\n`);
            const code = exitCodeForResults(results, openingDedupKeys);
            if (code !== EXIT.OK) {
                // Also on stderr: an operator tailing the log must not have to
                // parse JSON to learn that nothing was reconciled.
                const list = Array.isArray(results) ? results : [];
                const witnessedKeys = new Set(list.filter((r) => r && r.witnessed === true).map((r) => r.openingDedupKey));
                const returnedKeys = new Set(list.map((r) => r && r.openingDedupKey));
                const requested = openingDedupKeys.length;
                const witnessed = openingDedupKeys.filter((k) => witnessedKeys.has(k)).length;
                const missing = openingDedupKeys.filter((k) => !returnedKeys.has(k)).length;
                process.stderr.write(
                    `[wp-i reconciler] ${requested - witnessed} of ${requested} opening(s) were NOT witnessed` +
                    `${missing > 0 ? ` (${missing} never returned a result)` : ''}; this run is not a successful reconciliation\n`
                );
            }
            return code;
        })
        .catch((err) => {
            process.stderr.write(`[wp-i reconciler] fatal: ${err?.message || err}\n`);
            return EXIT.FATAL;
        });
}

if (require.main === module) {
    Promise.resolve(main(process.argv)).then((code) => process.exit(code));
}

module.exports = { REQUIRED_ENV, EXIT, exitCodeForResults, main };
