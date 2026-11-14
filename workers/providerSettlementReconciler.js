'use strict';

/**
 * WP-I — separate provider settlement reconciler.
 *
 * This is the ONLY component permitted to write a settlement witness. It is
 * deliberately NOT wired into server.js: nothing calls it at boot, and it runs
 * only when an operator invokes it with its own credentials.
 *
 * Why a separate process matters (stated so the control is not over-read):
 * a second credential inside the API process would be theatre — a compromised
 * process reads it from memory. A separate component with its own provider
 * credential and its own database login is what actually limits the blast
 * radius of a runtime compromise.
 *
 * Required environment (all distinct from the API process):
 *   AZM_RECONCILER_MODE=1                 enables the writer guard
 *   AZM_RECONCILER_PROVIDER_KEY           provider API credential
 *   WITNESS_DATABASE_URL                  reconciler DB login (INSERT only)
 *   WITNESS_ACCOUNT_CURRENCY_MAP          authoritative account -> currency JSON
 */

const { PrismaClient } = require('@prisma/client');
const { recordProviderSettlementWitness } = require('../src/services/providerSettlementWitnessService');

const PROVIDER_STATUS_ENDPOINT = 'https://api.moolre.com/open/transact/status';
const FUNDING_TYPE = 'COLLECTION';

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`[wp-i reconciler] missing ${name}; refusing to run without its own credentials`);
    return v;
}

/** Fetch the provider's own view of a payment. Returns the raw bytes + parsed body. */
async function fetchProviderStatus(reference) {
    const key = requireEnv('AZM_RECONCILER_PROVIDER_KEY');
    const res = await fetch(PROVIDER_STATUS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({ type: 1, idtype: 1, id: reference }),
    });
    const raw = await res.text();
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        parsed = null;
    }
    return { status: res.status, raw, parsed };
}

/**
 * Reconcile one treasury opening against the provider's own settlement record.
 *
 * The caller supplies ONLY the opening identity. Every economic field comes
 * from the provider response, never from the request.
 */
async function witnessOpening(prisma, { openingDedupKey, fundingReference, walletAccount }) {
    const fetchedAt = new Date();
    const { status, raw, parsed } = await fetchProviderStatus(fundingReference);
    if (status !== 200 || !parsed) {
        return { witnessed: false, reason: `provider status ${status}` };
    }
    const payload = parsed?.data ?? parsed;
    const witness = await prisma.$transaction((tx) => recordProviderSettlementWitness(tx, {
        openingDedupKey,
        provider: 'MOOLRE',
        fundingType: FUNDING_TYPE,
        endpoint: PROVIDER_STATUS_ENDPOINT,
        requestParams: { type: 1, idtype: 1, id: fundingReference },
        rawResponse: raw,
        providerPayload: payload,
        fetchedAt,
        walletAccount,
    }));
    return { witnessed: true, witnessId: witness.id, netPesewas: witness.netPesewas };
}

/**
 * Operator entrypoint. Never scheduled automatically; wiring it to a cron is
 * an explicit activation decision.
 */
async function reconcileTreasuryOpenings({ openingDedupKeys = [] } = {}) {
    requireEnv('AZM_RECONCILER_MODE');
    requireEnv('WITNESS_ACCOUNT_CURRENCY_MAP');
    const prisma = new PrismaClient({
        datasources: { db: { url: requireEnv('WITNESS_DATABASE_URL') } },
    });
    const results = [];
    try {
        for (const key of openingDedupKeys) {
            const opening = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: key } });
            if (!opening) {
                results.push({ openingDedupKey: key, witnessed: false, reason: 'unknown opening' });
                continue;
            }
            const reference = opening.providerRef || opening.evidence?.fundingReference;
            if (!reference) {
                results.push({ openingDedupKey: key, witnessed: false, reason: 'opening has no provider reference' });
                continue;
            }
            try {
                results.push({
                    openingDedupKey: key,
                    ...(await witnessOpening(prisma, {
                        openingDedupKey: key,
                        fundingReference: reference,
                        walletAccount: opening.evidence?.walletAccount,
                    })),
                });
            } catch (e) {
                results.push({ openingDedupKey: key, witnessed: false, reason: e.code || e.message });
            }
        }
        return results;
    } finally {
        await prisma.$disconnect();
    }
}

module.exports = { reconcileTreasuryOpenings, witnessOpening, fetchProviderStatus };

if (require.main === module) {
    reconcileTreasuryOpenings().then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
    }).catch((e) => {
        console.error('[wp-i reconciler] failed:', e.message);
        process.exit(1);
    });
}
