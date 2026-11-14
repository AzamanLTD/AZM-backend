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
 *   AZM_RECONCILER_PROVIDER_KEY        provider API credential
 *   WITNESS_DATABASE_URL               reconciler DB login (INSERT on the witness only)
 *   WITNESS_ACCOUNT_CURRENCY_MAP       {"WALLET-ACCOUNT":"GHS", ...}
 *
 * Exit codes: 0 all requested openings processed (witnessed or truthfully
 * refused), 1 usage/credential failure, 2 fatal error.
 */

const { reconcileTreasuryOpenings } = require('./providerSettlementReconciler');

const REQUIRED_ENV = [
    'AZM_RECONCILER_MODE',
    'AZM_RECONCILER_PROVIDER_KEY',
    'WITNESS_DATABASE_URL',
    'WITNESS_ACCOUNT_CURRENCY_MAP',
];

function main(argv) {
    const openingDedupKeys = argv.slice(2).filter((a) => a && !a.startsWith('-'));
    if (openingDedupKeys.length === 0) {
        process.stderr.write('usage: node workers/run-provider-settlement-reconciler.js <openingDedupKey> [...]\n');
        return 1;
    }
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        // Fail closed and say exactly what is missing. Running with a partial
        // credential set would mean guessing at authority.
        process.stderr.write(`[wp-i reconciler] refusing to run: missing ${missing.join(', ')}\n`);
        return 1;
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
            return results.every((r) => r.witnessed) ? 0 : 0;
        })
        .catch((err) => {
            process.stderr.write(`[wp-i reconciler] fatal: ${err?.message || err}\n`);
            return 2;
        });
}

if (require.main === module) {
    Promise.resolve(main(process.argv)).then((code) => process.exit(code));
}

module.exports = { REQUIRED_ENV, main };
