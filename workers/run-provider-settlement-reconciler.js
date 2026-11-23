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
 * EXIT CONTRACT (honest by construction — a refusal is a correctly handled
 * result, but it is NEVER reported as proof of funding):
 *
 *   0  EXIT_ALL_WITNESSED   every requested opening was successfully witnessed
 *   1  EXIT_INVALID         invalid invocation, or a required credential or
 *                           configuration value is missing/invalid
 *   2  EXIT_FATAL           fatal process/database/initialization failure: the
 *                           batch could not be attempted to completion
 *   3  EXIT_INCOMPLETE      the batch COMPLETED but one or more openings were
 *                           refused, pending, unknown, mismatched or otherwise
 *                           not witnessed
 *
 * The old contract collapsed 0 and 3 into a single 0 (`every(...) ? 0 : 0`),
 * which meant a batch where NOTHING was witnessed exited successfully. A
 * monitoring system reading that code would have concluded the treasury had
 * been reconciled. Exit 0 now means exactly one thing: every requested opening
 * has a durable witness row.
 *
 * The complete JSON results are still written to stdout on exit 0 and 3, with
 * exact BigInt Pesewas serialized as decimal strings. Provider credentials and
 * the database URL are never printed.
 */

const { reconcileTreasuryOpenings } = require('./providerSettlementReconciler');

// One entry per variable the process actually needs. An earlier version listed
// the two provider credentials as a single combined string, so process.env[...]
// was always undefined and this entrypoint could never start. The old test could
// not see it: deleting a name that is not set is a no-op, so every deletion
// "proved" a refusal.
/**
 * The documented exit contract. Frozen so a caller cannot drift from it, and
 * exported so tests and monitoring assert the SAME values the CLI uses.
 */
const EXIT = Object.freeze({
    EXIT_ALL_WITNESSED: 0,
    EXIT_INVALID: 1,
    EXIT_FATAL: 2,
    EXIT_INCOMPLETE: 3,
});

/**
 * Map a completed batch to its exit code.
 *
 * Only a batch where EVERY result carries `witnessed === true` may exit 0.
 * Anything else — a refusal, a pending provider state, an unknown opening, a
 * thrown per-opening error — is EXIT_INCOMPLETE. An empty batch is not a
 * vacuous success either: the invocation required at least one key, so no
 * results means the request was not honoured.
 */
function exitCodeForResults(results, requestedCount = null) {
    if (!Array.isArray(results)) return EXIT.EXIT_FATAL;
    if (results.length === 0) return EXIT.EXIT_INCOMPLETE;
    // A PARTIAL batch is not a success. If two openings were requested and only
    // one came back witnessed, the other was silently dropped somewhere — and a
    // 0 there would tell monitoring that both are funded.
    if (Number.isInteger(requestedCount) && results.length < requestedCount) {
        return EXIT.EXIT_INCOMPLETE;
    }
    return results.every((r) => r && r.witnessed === true)
        ? EXIT.EXIT_ALL_WITNESSED
        : EXIT.EXIT_INCOMPLETE;
}

/** A one-line, credential-free summary for operators and alerts. */
function summariseResults(results, requestedCount = null) {
    const list = Array.isArray(results) ? results : [];
    const witnessed = list.filter((r) => r && r.witnessed === true).length;
    const refused = list.length - witnessed;
    const requested = Number.isInteger(requestedCount) ? requestedCount : list.length;
    const missing = Math.max(0, requested - list.length);
    const tail = missing > 0 ? `, ${missing} unaccounted for` : '';
    return `[wp-i reconciler] ${witnessed} witnessed, ${refused} not witnessed, ${requested} requested${tail}`;
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
        return EXIT.EXIT_INVALID;
    }
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        // Fail closed and say exactly what is missing. Running with a partial
        // credential set would mean guessing at authority.
        process.stderr.write(`[wp-i reconciler] refusing to run: missing ${missing.join(', ')}\n`);
        return EXIT.EXIT_INVALID;
    }
    // Presence is not consent: AZM_RECONCILER_MODE=0 or "true" must not open the
    // writer guard, so the VALUE is checked here and again in the worker.
    if (process.env.AZM_RECONCILER_MODE !== '1') {
        process.stderr.write(
            `[wp-i reconciler] refusing to run: AZM_RECONCILER_MODE must be exactly 1, got ${JSON.stringify(process.env.AZM_RECONCILER_MODE)}\n`
        );
        return EXIT.EXIT_INVALID;
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
            const code = exitCodeForResults(results, openingDedupKeys.length);
            // Non-zero means "this run is not proof that the openings are
            // funded". Say so on stderr too, so a human reading logs and an
            // alert keyed on stderr both see it without parsing the JSON.
            if (code !== EXIT.EXIT_ALL_WITNESSED) {
                process.stderr.write(`${summariseResults(results, openingDedupKeys.length)}\n`);
            }
            return code;
        })
        .catch((err) => {
            process.stderr.write(`[wp-i reconciler] fatal: ${err?.message || err}\n`);
            return EXIT.EXIT_FATAL;
        });
}

if (require.main === module) {
    Promise.resolve(main(process.argv)).then((code) => process.exit(code));
}

module.exports = { REQUIRED_ENV, EXIT, exitCodeForResults, summariseResults, main };
