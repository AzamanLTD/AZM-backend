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
 *   AZM_RECONCILER_PROVIDER_USER + AZM_RECONCILER_PROVIDER_PUBKEY           provider API credential
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

/**
 * Fetch the provider's own view of a payment.
 *
 * DOCUMENTED CONTRACT (docs.moolre.com Payment Status API):
 *   X-API-USER + X-API-PUBKEY (the PUBLIC key), body { type, idtype, id, accountnumber }.
 * The previous implementation sent a private key and omitted `accountnumber`,
 * which is not the documented type-1 request.
 *
 * Bounded by a timeout: an unbounded provider call would hold the reconciler
 * open indefinitely and hide an ambiguous outcome behind a hung process.
 */
async function fetchProviderStatus(reference, accountNumber) {
    const user = requireEnv('AZM_RECONCILER_PROVIDER_USER');
    const pubkey = requireEnv('AZM_RECONCILER_PROVIDER_PUBKEY');
    const timeoutMs = Number(process.env.AZM_RECONCILER_TIMEOUT_MS || 10000);

    const res = await fetch(PROVIDER_STATUS_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-USER': user,
            'X-API-PUBKEY': pubkey,
        },
        body: JSON.stringify({ type: 1, idtype: 1, id: reference, accountnumber: accountNumber }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    return { httpStatus: res.status, raw };
}

/**
 * Reconcile one treasury opening against the provider's own settlement record.
 *
 * The caller supplies ONLY the opening identity. Every economic field comes
 * from the provider response, never from the request.
 */
async function witnessOpening(prisma, { openingDedupKey, walletAccount }) {
    const { parseMoolreStatusResponse, extractObservation, ADAPTER_DOCUMENTED } =
        require('../src/services/providers/moolreStatusAdapter');

    // The opening is the ONLY input. Its funding reference and amount come from
    // persisted state, so a caller cannot point the reconciler at a payment of
    // its choosing.
    const opening = await prisma.fiatLiquidityReceipt.findUnique({ where: { dedupKey: openingDedupKey } });
    if (!opening) return { witnessed: false, reason: 'OPENING_NOT_FOUND' };
    if (String(opening.status) !== 'RECEIVED') return { witnessed: false, reason: `OPENING_NOT_ELIGIBLE_${opening.status}` };
    if (!opening.providerRef) return { witnessed: false, reason: 'OPENING_HAS_NO_PROVIDER_REFERENCE' };

    // The wallet comes from the OPENING, not from the caller and not from the
    // environment. `evidence` is JSON the runtime can write, so it is not a
    // source of truth either: an opening without a stored account is refused
    // rather than reconciled against a guessed wallet.
    const accountNumber = String(opening.walletAccount || '').trim();
    if (!accountNumber) {
        return { witnessed: false, reason: 'OPENING_HAS_NO_WALLET_ACCOUNT' };
    }
    // Optional guard for a single-wallet deployment: if the operator has pinned
    // the wallet, a mismatched opening means the reconciler is pointed at the
    // wrong wallet's money and must refuse instead of querying the wrong account.
    const pinnedWallet = String(process.env.AZM_RECONCILER_ACCOUNT_NUMBER || '').trim();
    if (pinnedWallet && pinnedWallet !== accountNumber) {
        return { witnessed: false, reason: 'RECONCILER_WALLET_MISMATCH' };
    }
    const fetchedAt = new Date();
    let response;
    try {
        response = await fetchProviderStatus(String(opening.providerRef), accountNumber);
    } catch (err) {
        // Ambiguous outcome: no witness, no retry with a different reference.
        return { witnessed: false, reason: `PROVIDER_TRANSPORT_ERROR_${err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED'}` };
    }

    const parsed = parseMoolreStatusResponse({ httpStatus: response.httpStatus, rawBody: response.raw });
    if (!parsed.transportOk) return { witnessed: false, reason: `PROVIDER_TRANSPORT_${parsed.reason}` };
    if (parsed.settlement !== 'SETTLED') return { witnessed: false, reason: `PROVIDER_NOT_SETTLED_${parsed.settlement}_${parsed.reason}` };

    let observation;
    try {
        observation = extractObservation(parsed.data);
    } catch (err) {
        return { witnessed: false, reason: `PROVIDER_DATA_${err.code}` };
    }

    const witness = await prisma.$transaction((tx) => recordProviderSettlementWitness(tx, {
        openingDedupKey,
        provider: 'MOOLRE',
        fundingType: FUNDING_TYPE,
        endpoint: PROVIDER_STATUS_ENDPOINT,
        requestParams: { type: 1, idtype: 1, id: String(opening.providerRef), accountnumber: accountNumber },
        rawResponse: response.raw,
        providerPayload: parsed.data,
        settlementState: parsed.settlement,
        adapterRule: parsed.adapter,
        fetchedAt,
        walletAccount: accountNumber,
    }));
    return { witnessed: true, witnessId: witness.id, netPesewas: witness.netPesewas, adapter: parsed.adapter };
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
            // ONE authority: witnessOpening reads the opening, decides eligibility,
            // resolves the wallet and the reference from the row, and returns a
            // stable reason. The loop must not pre-read or fill gaps from
            // `evidence` JSON, which the runtime can write.
            try {
                results.push({
                    openingDedupKey: key,
                    ...(await witnessOpening(prisma, { openingDedupKey: key })),
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
