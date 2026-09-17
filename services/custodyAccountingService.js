// services/custodyAccountingService.js
// =============================================================================
// §P.3 CUSTODY ACCOUNTING — custody accounts, movements, evidence, journal.
//
// ONE accounting truth. This layer records custody assets and custody-linked
// flows. It does NOT restate the legacy mixed balance pool, does NOT create a
// second independent ledger (verified custody movements post to the existing
// double-entry JournalEntry tables with exact decimal values), and does NOT
// invent any balance that lacks accepted evidence.
//
// Evidence hierarchy (never interchangeable):
//   • TATUM_V3_TOKEN_BALANCE  — ACCOUNT_BALANCE observation. Aggregates the
//     Proof-of-Reserves numerator ONLY. Proves nothing about any individual
//     transaction.
//   • TATUM_V4_TX_BY_HASH     — TRANSACTION observation. The ONLY path by
//     which a webhook-identified deposit candidate becomes a VERIFIED
//     CustodyMovement (exact hash, polygon-mainnet, native USDC contract,
//     receiving deposit address, inbound direction, exact quantity, block
//     reference).
//   • CUSTODY_EXECUTION_VERIFIED_CHAIN — the §P.2 execution boundary's own
//     verified chain transfer (verifyChainTransfer with receipt evidence).
//     Execution-linked movements (sweeps, withdrawals) are created VERIFIED
//     inside the same DB transaction that completes the execution.
//
// A webhook credit identifies a candidate. It does NOT prove the movement:
// existing webhook credits are NOT retroactively "verified" by the existence of
// a CustodyMovement row — until the transaction evidence validation succeeds,
// the movement stays CANDIDATE and contributes ZERO to the evidence-linked
// liability subset.
//
// Exactness: every authoritative quantity here is an integer base unit
// (BigInt) or an exact Prisma.Decimal produced from a decimal string. No JS
// float is ever an authoritative custody value.
// =============================================================================

const { Prisma, PrismaClient } = require('@prisma/client');
const logger = require('../src/config/logger');
const {
    SOURCE_TX,
    EVIDENCE_ERRORS,
    CustodyEvidenceError,
    normalizeAddress,
} = require('./custodyEvidenceProvider');

const prisma = new PrismaClient();

const TIERS = {
    USER_DEPOSIT_ADDRESS: 'USER_DEPOSIT_ADDRESS',
    MASTER_HOT_WALLET: 'MASTER_HOT_WALLET',
};
const CONTROL = { PLATFORM_KMS_CUSTODY: 'PLATFORM_KMS_CUSTODY' };
const MOVEMENT_KINDS = { DEPOSIT_IN: 'DEPOSIT_IN', SWEEP: 'SWEEP', WITHDRAWAL_OUT: 'WITHDRAWAL_OUT' };
const MOVEMENT_STATUS = { CANDIDATE: 'CANDIDATE', VERIFIED: 'VERIFIED', FAILED: 'FAILED', RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED' };
const JOURNAL = {
    DEPOSIT: 'CUSTODY_DEPOSIT',
    SWEEP: 'CUSTODY_SWEEP',
    WITHDRAWAL: 'CUSTODY_WITHDRAWAL',
    custodyDepositAccount: 'custody:deposit:usdc',
    custodyHotAccount: 'custody:hot:usdc',
    userLiability: (userId) => `user:${userId}:liability`,
};

// ── exact arithmetic ───────────────────────────────────────────────────────
/** BigInt base units → EXACT decimal string ("100123456",6) → "100.123456". */
function decimalStringFromBaseUnits(baseUnits, decimals = 6) {
    if (typeof baseUnits !== 'bigint') throw new Error('baseUnits must be BigInt');
    const neg = baseUnits < 0n;
    const units = neg ? -baseUnits : baseUnits;
    const scale = 10n ** BigInt(decimals);
    const intPart = units / scale;
    const fracPart = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + intPart.toString() + (fracPart ? `.${fracPart}` : '');
}

/** BigInt base units → exact Prisma.Decimal (never Number()/1e6). */
function decimalFromBaseUnits(baseUnits, decimals = 6) {
    return new Prisma.Decimal(decimalStringFromBaseUnits(baseUnits, decimals));
}

// ── custody accounts ───────────────────────────────────────────────────────
/**
 * Idempotently ensure the custody account for a §P.1 registry deposit address.
 * The registry row is the authority: only its identity fields are stored.
 * Concurrent creators converge on the unique (address, network, asset,
 * contract) identity.
 */
async function ensureDepositAccount(tx, { walletAddress }) {
    if (!walletAddress || !walletAddress.address || !walletAddress.id) {
        throw new Error('ensureDepositAccount: registry WalletAddress row is required');
    }
    const data = {
        tier: TIERS.USER_DEPOSIT_ADDRESS,
        network: String(walletAddress.network || 'POLYGON').toUpperCase(),
        asset: String(walletAddress.asset || 'USDC').toUpperCase(),
        contractAddress: normalizeAddress(walletAddress.contractAddress),
        address: normalizeAddress(walletAddress.address),
        control: CONTROL.PLATFORM_KMS_CUSTODY,
        status: 'ACTIVE',
        userId: walletAddress.userId ?? null,
        walletAddressId: walletAddress.id,
    };
    try {
        return await tx.custodyAccount.upsert({
            where: {
                address_network_asset_contractAddress: {
                    address: data.address,
                    network: data.network,
                    asset: data.asset,
                    contractAddress: data.contractAddress,
                },
            },
            create: data,
            update: {
                status: 'ACTIVE',
                userId: data.userId,
                walletAddressId: data.walletAddressId,
            },
        });
    } catch (err) {
        // Unique race on walletAddressId (registry re-issued the address) —
        // converge by re-reading the authoritative identity row.
        if (err && err.code === 'P2002') {
            const existing = await tx.custodyAccount.findUnique({
                where: {
                    address_network_asset_contractAddress: {
                        address: data.address,
                        network: data.network,
                        asset: data.asset,
                        contractAddress: data.contractAddress,
                    },
                },
            });
            if (existing) {
                return tx.custodyAccount.update({
                    where: { id: existing.id },
                    data: { status: 'ACTIVE', userId: data.userId, walletAddressId: data.walletAddressId },
                });
            }
        }
        throw err;
    }
}

/** Idempotently ensure the MASTER_HOT_WALLET custody account. */
async function ensureHotWalletAccount(tx, { address, network = 'POLYGON', asset = 'USDC', contractAddress }) {
    const addr = normalizeAddress(address);
    if (!addr || !contractAddress) {
        throw new Error('ensureHotWalletAccount: address and contractAddress are required');
    }
    const data = {
        tier: TIERS.MASTER_HOT_WALLET,
        network: String(network).toUpperCase(),
        asset: String(asset).toUpperCase(),
        contractAddress: normalizeAddress(contractAddress),
        address: addr,
        control: CONTROL.PLATFORM_KMS_CUSTODY,
        status: 'ACTIVE',
    };
    return tx.custodyAccount.upsert({
        where: {
            address_network_asset_contractAddress: {
                address: data.address,
                network: data.network,
                asset: data.asset,
                contractAddress: data.contractAddress,
            },
        },
        create: data,
        update: { status: 'ACTIVE' },
    });
}

/**
 * Sync account status to the registry authority and return the accounts that
 * are ELIGIBLE for the reserve set:
 *   • MASTER_HOT_WALLET with the given configured address
 *   • USER_DEPOSIT_ADDRESS whose §P.1 registry row is ACTIVE
 * Accounts whose registry row retired are marked RETIRED here (derivable
 * metadata sync only — no economics are touched).
 */
async function syncAndListEligibleAccounts(db, { hotWalletAddress, hotWalletContractAddress }) {
    const accounts = await db.custodyAccount.findMany({ where: { status: 'ACTIVE' } });
    const eligible = [];
    for (const account of accounts) {
        if (account.tier === TIERS.MASTER_HOT_WALLET) {
            if (hotWalletAddress && normalizeAddress(account.address) === normalizeAddress(hotWalletAddress)) {
                eligible.push(account);
            }
            continue;
        }
        if (account.tier === TIERS.USER_DEPOSIT_ADDRESS) {
            if (!account.walletAddressId) continue;
            const registryRow = await db.walletAddress.findUnique({ where: { id: account.walletAddressId } });
            if (!registryRow || registryRow.status !== 'ACTIVE' || normalizeAddress(registryRow.address) !== normalizeAddress(account.address)) {
                // Registry authority says this address is no longer active.
                await db.custodyAccount.update({ where: { id: account.id }, data: { status: 'RETIRED' } });
                continue;
            }
            eligible.push(account);
        }
    }
    return eligible;
}

// ── custody journal (exact, idempotent, double-entry) ──────────────────────
/**
 * Post the balanced double-entry journal representation of a VERIFIED custody
 * movement, inside the caller's transaction. Exact Prisma.Decimal values are
 * produced from base units — parseFloat never touches the authoritative value.
 * Idempotent: the deterministic transactionId is checked first.
 */
async function postCustodyJournal(tx, { movement, userId = null }) {
    const transactionId = `CUSTODY-${movement.id}`;
    const existing = await tx.journalEntry.findFirst({ where: { transactionId }, select: { id: true } });
    if (existing) return { transactionId, alreadyPosted: true };

    const amount = decimalFromBaseUnits(BigInt(movement.amountBaseUnits), movement.decimals || 6);
    if (amount.lte(0)) throw new Error(`Custody journal refused: non-positive exact amount for movement ${movement.id}`);

    let entryType;
    let lines;
    let journalUserId = userId;
    if (movement.kind === MOVEMENT_KINDS.DEPOSIT_IN) {
        entryType = JOURNAL.DEPOSIT;
        // D custody:deposit:usdc / C user:{id}:liability
        journalUserId = journalUserId ?? null;
        lines = [
            { account: JOURNAL.custodyDepositAccount, debit: amount, credit: new Prisma.Decimal(0) },
            { account: JOURNAL.userLiability(journalUserId), debit: new Prisma.Decimal(0), credit: amount },
        ];
    } else if (movement.kind === MOVEMENT_KINDS.SWEEP) {
        entryType = JOURNAL.SWEEP;
        // D custody:hot:usdc / C custody:deposit:usdc
        lines = [
            { account: JOURNAL.custodyHotAccount, debit: amount, credit: new Prisma.Decimal(0) },
            { account: JOURNAL.custodyDepositAccount, debit: new Prisma.Decimal(0), credit: amount },
        ];
    } else if (movement.kind === MOVEMENT_KINDS.WITHDRAWAL_OUT) {
        entryType = JOURNAL.WITHDRAWAL;
        // D user:{id}:liability / C custody:hot:usdc
        journalUserId = journalUserId ?? null;
        lines = [
            { account: JOURNAL.userLiability(journalUserId), debit: amount, credit: new Prisma.Decimal(0) },
            { account: JOURNAL.custodyHotAccount, debit: new Prisma.Decimal(0), credit: amount },
        ];
    } else {
        throw new Error(`postCustodyJournal: unknown movement kind ${movement.kind}`);
    }

    const description = `§P.3 custody ${movement.kind} (${movement.status}) ${decimalStringFromBaseUnits(BigInt(movement.amountBaseUnits), movement.decimals || 6)} ${movement.asset}`;
    for (const line of lines) {
        await tx.journalEntry.create({
            data: {
                transactionId,
                entryType,
                account: line.account,
                debit: line.debit,
                credit: line.credit,
                description: description.slice(0, 500),
                reference: (movement.txHash || movement.idempotencyKey || '').slice(0, 100),
                userId: journalUserId ?? null,
                relatedEntity: 'custodyMovement',
                relatedEntityId: movement.id,
                metadata: {
                    custodyMovementId: movement.id,
                    evidenceSource: movement.evidenceSource || null,
                    network: movement.network,
                    asset: movement.asset,
                    contractAddress: movement.contractAddress,
                    amountBaseUnits: movement.amountBaseUnits.toString(),
                },
            },
        });
    }
    return { transactionId, alreadyPosted: false };
}

// ── deposit movements (webhook candidate → transaction-evidence verified) ───
/**
 * Record the deposit candidate identified by the (already-credited) webhook
 * flow, atomically with that credit. The webhook is an observation/candidate
 * source ONLY — it does not verify anything. The candidate contributes ZERO
 * to the evidence-linked liability subset until verifyDepositMovement
 * succeeds against transaction-specific chain evidence.
 * Idempotent on idempotencyKey = deposit:{network}:{txHash}.
 */
async function recordDepositCandidate(tx, { walletAddress, txHash, amountBaseUnits, transactionHistoryId, creditedAmountDecimalString }) {
    if (!walletAddress || !txHash || typeof amountBaseUnits !== 'bigint' || amountBaseUnits <= 0n) {
        throw new Error('recordDepositCandidate: walletAddress, txHash and positive amountBaseUnits are required');
    }
    const account = await ensureDepositAccount(tx, { walletAddress });
    const idempotencyKey = `deposit:${String(walletAddress.network || 'POLYGON').toUpperCase()}:${String(txHash).toLowerCase()}`;
    const existing = await tx.custodyMovement.findUnique({ where: { idempotencyKey } });
    if (existing) return { movement: existing, account, isNew: false };

    const movement = await tx.custodyMovement.create({
        data: {
            idempotencyKey,
            kind: MOVEMENT_KINDS.DEPOSIT_IN,
            status: MOVEMENT_STATUS.CANDIDATE,
            network: String(walletAddress.network || 'POLYGON').toUpperCase(),
            asset: String(walletAddress.asset || 'USDC').toUpperCase(),
            contractAddress: normalizeAddress(walletAddress.contractAddress),
            amountBaseUnits,
            decimals: 6,
            sourceAccountId: null, // external chain origin
            destinationAccountId: account.id,
            fromAddress: null, // unknown until transaction evidence verifies it
            toAddress: normalizeAddress(walletAddress.address),
            custodyExecutionId: null,
            transactionHistoryId: transactionHistoryId || null,
            txHash: String(txHash).toLowerCase(),
            evidenceSource: 'TATUM_WEBHOOK',
            metadata: {
                candidate: true,
                candidateSource: 'TATUM_WEBHOOK',
                creditedAmountDecimalString: creditedAmountDecimalString || null,
            },
        },
    });
    return { movement, account, isNew: true };
}

/**
 * Verify a deposit candidate against TRANSACTION-SPECIFIC chain evidence
 * (Tatum v4 tx-by-hash). The observation must establish, together:
 *   exact hash · polygon-mainnet · native USDC contract · the customer's
 *   deposit address · inbound direction · exact quantity · block reference.
 * A balance observation can NEVER verify a movement — provider sources are
 * structurally separated (SOURCE_TX only, here).
 *
 * Outcomes:
 *   verified            → movement CANDIDATE→VERIFIED (atomic with evidence row
 *                         + exact journal posting; concurrency-safe, exactly-once)
 *   definitive mismatch → movement →FAILED with an explicit failureReason
 *                         (candidate retained; the credit itself becomes an
 *                         ops reconciliation item — it is NOT auto-reversed)
 *   evidence unavailable → movement stays CANDIDATE (retryable)
 */
async function verifyDepositMovement(db, { movementId }, { txProvider } = {}) {
    const provider = txProvider || null;
    if (!provider || provider.source !== SOURCE_TX) {
        throw new Error('verifyDepositMovement: a TATUM_V4_TX_BY_HASH provider is required — balance evidence cannot verify a movement');
    }
    const movement = await db.custodyMovement.findUnique({ where: { id: movementId } });
    if (!movement) return { verified: false, reason: 'NOT_FOUND' };
    if (movement.kind !== MOVEMENT_KINDS.DEPOSIT_IN) return { verified: false, reason: 'NOT_A_DEPOSIT' };
    if (movement.status === MOVEMENT_STATUS.VERIFIED) return { verified: true, movement, alreadyVerified: true };
    if (movement.status !== MOVEMENT_STATUS.CANDIDATE) return { verified: false, reason: `STATUS_${movement.status}` };
    if (!movement.txHash) return { verified: false, reason: 'NO_TX_HASH' };

    // Defense in depth: the destination custody account must be an ACTIVE
    // registry-linked deposit account.
    const account = await db.custodyAccount.findUnique({ where: { id: movement.destinationAccountId } });
    if (!account || account.status !== 'ACTIVE' || account.tier !== TIERS.USER_DEPOSIT_ADDRESS) {
        return { verified: false, reason: 'DESTINATION_ACCOUNT_NOT_ELIGIBLE', retryable: false };
    }
    const registryRow = account.walletAddressId ? await db.walletAddress.findUnique({ where: { id: account.walletAddressId } }) : null;
    if (!registryRow || registryRow.status !== 'ACTIVE' || normalizeAddress(registryRow.address) !== normalizeAddress(account.address)) {
        return { verified: false, reason: 'REGISTRY_AUTHORITY_FAILED', retryable: false };
    }

    // Transaction-specific evidence fetch.
    let obs;
    try {
        obs = await provider.getTransaction({ network: movement.network, hash: movement.txHash, decimals: movement.decimals || 6 });
    } catch (err) {
        if (err instanceof CustodyEvidenceError) {
            // Provider down / rate-limited / malformed: fail closed, retryable.
            return { verified: false, reason: err.code, retryable: true, detail: err.detail };
        }
        throw err;
    }

    // Validate the transfer semantics against the movement's exact identity.
    const expectedAddress = normalizeAddress(account.address);
    const expectedContract = normalizeAddress(account.contractAddress);
    const failures = [];
    if (!obs.entries || obs.entries.length === 0) failures.push('TX_NOT_FOUND');
    const incoming = (obs.entries || []).filter((e) => e.transactionSubtype === 'incoming');
    if (incoming.length === 0) failures.push('NOT_INCOMING');
    const toUs = incoming.filter((e) => e.address === expectedAddress);
    if (toUs.length === 0) failures.push('ADDRESS_MISMATCH');
    const canonical = toUs.filter((e) => e.tokenAddress === expectedContract);
    if (canonical.length === 0) failures.push('WRONG_CONTRACT'); // bridged USDC.e is NEVER native USDC
    // Defense in depth: the evidence must be for the EXACT requested hash —
    // a provider (or a misbehaving proxy) returning a different transaction's
    // matching-looking transfer can never verify this movement.
    const hashBound = canonical.filter((e) => e.hash === movement.txHash);
    if (canonical.length > 0 && hashBound.length === 0) failures.push('HASH_MISMATCH');
    const entry = hashBound[0] || canonical[0] || null;
    if (entry && entry.blockNumber == null) failures.push('NOT_CONFIRMED');
    if (entry && entry.amountBaseUnits !== BigInt(movement.amountBaseUnits)) failures.push('AMOUNT_MISMATCH');

    if (failures.length > 0) {
        // Definitive mismatch: the candidate is retained as a FAILED record
        // with the explicit reason. The webhook credit is NOT auto-reversed —
        // reversing a customer credit is an auditable ops decision.
        const conditional = await db.custodyMovement.updateMany({
            where: { id: movement.id, status: MOVEMENT_STATUS.CANDIDATE },
            data: { status: MOVEMENT_STATUS.FAILED, failureReason: failures.join('+').slice(0, 60) },
        });
        logger.warn({ movementId: movement.id, txHash: movement.txHash, failures }, '[custody-accounting] deposit candidate FAILED transaction-evidence validation');
        return { verified: false, reason: failures.join('+'), retryable: false };
    }

    // Verified: atomic CANDIDATE→VERIFIED + evidence row + journal posting.
    const result = await db.$transaction(async (tx) => {
        const updated = await tx.custodyMovement.updateMany({
            where: { id: movement.id, status: MOVEMENT_STATUS.CANDIDATE },
            data: { status: MOVEMENT_STATUS.VERIFIED, verifiedAt: new Date() },
        });
        if (updated.count !== 1) {
            const current = await tx.custodyMovement.findUnique({ where: { id: movement.id } });
            return { concurrent: true, current };
        }
        const evidence = await tx.custodyEvidence.create({
            data: {
                custodyAccountId: account.id,
                source: SOURCE_TX,
                scope: 'TRANSACTION',
                network: movement.network,
                asset: movement.asset,
                contractAddress: expectedContract,
                address: expectedAddress,
                amountBaseUnits: entry.amountBaseUnits,
                txHash: movement.txHash,
                blockReference: String(entry.blockNumber),
                observedAt: obs.observedAt,
                status: 'ACTIVE',
                raw: {
                    chain: entry.chain || null,
                    counterAddress: entry.counterAddress || null,
                    timestamp: entry.timestamp || null,
                    blockNumber: entry.blockNumber,
                },
            },
        });
        const fresh = await tx.custodyMovement.update({
            where: { id: movement.id },
            data: {
                evidenceId: evidence.id,
                evidenceSource: SOURCE_TX,
                fromAddress: entry.counterAddress || null,
                verifiedAt: new Date(),
                verificationDetail: {
                    blockNumber: entry.blockNumber,
                    chain: entry.chain || null,
                    counterAddress: entry.counterAddress || null,
                    amountBaseUnits: entry.amountBaseUnits.toString(),
                    observedAt: obs.observedAt.toISOString(),
                },
            },
        });
        await postCustodyJournal(tx, { movement: fresh, userId: account.userId });
        return { concurrent: false, movement: fresh, evidence };
    });
    if (result.concurrent) {
        // Another verifier won the race — converge (exactly-once journal).
        if (result.current && result.current.status === MOVEMENT_STATUS.VERIFIED) {
            return { verified: true, movement: result.current, concurrent: true };
        }
        return { verified: false, reason: `STATUS_${result.current ? result.current.status : 'GONE'}`, retryable: true };
    }
    logger.info({ movementId: movement.id, txHash: movement.txHash, block: entry.blockNumber }, '[custody-accounting] deposit movement VERIFIED against transaction evidence');
    return { verified: true, movement: result.movement, evidence: result.evidence };
}

/** Batch-verify pending candidates (ops/worker entry point). */
async function verifyPendingDepositMovements(db, { txProvider, limit = 25 } = {}) {
    const pending = await db.custodyMovement.findMany({
        where: { kind: MOVEMENT_KINDS.DEPOSIT_IN, status: MOVEMENT_STATUS.CANDIDATE },
        orderBy: { createdAt: 'asc' },
        take: limit,
    });
    const results = [];
    for (const movement of pending) {
        try {
            const outcome = await verifyDepositMovement(db, { movementId: movement.id }, { txProvider });
            results.push({ movementId: movement.id, ...outcome });
        } catch (err) {
            logger.warn({ err: err.message, movementId: movement.id }, '[custody-accounting] deposit verify error');
            results.push({ movementId: movement.id, verified: false, reason: 'ERROR', detail: err.message });
        }
    }
    return results;
}

// ── execution-linked movements (§P.2 settlement integration) ───────────────
/**
 * Create the VERIFIED custody movement for a §P.2 execution that is completing
 * with verified chain evidence — called INSIDE settleExecution's transaction,
 * so settlement, movement, and journal commit atomically or not at all. The
 * unique (custodyExecutionId) index guarantees one movement per execution.
 * Idempotent: re-invocation converges on the existing movement.
 */
async function recordExecutionMovement(tx, { execution, hotWalletAddress }) {
    if (!execution || !execution.id) throw new Error('recordExecutionMovement: execution is required');
    const idempotencyKey = `execution:${execution.id}`;
    const existing = await tx.custodyMovement.findUnique({ where: { idempotencyKey } });
    if (existing) return { movement: existing, isNew: false };

    const network = String(execution.network || 'POLYGON').toUpperCase();
    const asset = String(execution.asset || 'USDC').toUpperCase();
    const contract = normalizeAddress(execution.contractAddress);
    const hotAccount = await ensureHotWalletAccount(tx, { address: hotWalletAddress, network, asset, contractAddress: contract });

    let kind;
    let sourceAccount = null;
    let destinationAccount = null;
    let fromAddress = null;
    let toAddress = null;

    if (execution.kind === 'DEPOSIT_SWEEP') {
        kind = MOVEMENT_KINDS.SWEEP;
        if (!execution.walletAddressId) throw new Error(`settlement refused: sweep execution ${execution.id} lacks its registry walletAddressId`);
        const registryRow = await tx.walletAddress.findUnique({ where: { id: execution.walletAddressId } });
        if (!registryRow) throw new Error(`settlement refused: registry row ${execution.walletAddressId} not found for sweep execution ${execution.id}`);
        sourceAccount = await ensureDepositAccount(tx, { walletAddress: registryRow });
        destinationAccount = hotAccount;
        fromAddress = normalizeAddress(execution.fromAddress);
        toAddress = normalizeAddress(execution.toAddress);
    } else if (execution.kind === 'CUSTOMER_WITHDRAWAL') {
        kind = MOVEMENT_KINDS.WITHDRAWAL_OUT;
        sourceAccount = hotAccount; // funds leave the master hot wallet
        destinationAccount = null;  // external destination — never a custody account
        fromAddress = normalizeAddress(execution.fromAddress);
        toAddress = normalizeAddress(execution.toAddress);
    } else {
        throw new Error(`recordExecutionMovement: unsupported execution kind ${execution.kind}`);
    }

    const movement = await tx.custodyMovement.create({
        data: {
            idempotencyKey,
            kind,
            status: MOVEMENT_STATUS.VERIFIED, // §P.2 verified chain transfer IS transaction evidence
            network,
            asset,
            contractAddress: contract,
            amountBaseUnits: BigInt(execution.amountBaseUnits),
            decimals: execution.decimals || 6,
            sourceAccountId: sourceAccount ? sourceAccount.id : null,
            destinationAccountId: destinationAccount ? destinationAccount.id : null,
            fromAddress,
            toAddress,
            custodyExecutionId: execution.id,
            transactionHistoryId: (execution.kind === 'CUSTOMER_WITHDRAWAL' && execution.refId) ? execution.refId : null,
            txHash: execution.txHash ? String(execution.txHash).toLowerCase() : null,
            evidenceSource: 'CUSTODY_EXECUTION_VERIFIED_CHAIN',
            verifiedAt: new Date(),
            metadata: { executionKind: execution.kind, settlement: 'settleExecution' },
        },
    });
    await postCustodyJournal(tx, { movement, userId: execution.userId ?? null });
    return { movement, isNew: true };
}

/**
 * Idempotent recovery: create movements for COMPLETED executions that settled
 * without one (crash windows). Never duplicates (unique custodyExecutionId).
 */
async function backfillMovementsForCompletedExecutions(db, { hotWalletAddress } = {}) {
    if (!hotWalletAddress) {
        return { skipped: true, reason: 'HOT_WALLET_NOT_CONFIGURED' };
    }
    const completed = await db.custodyExecution.findMany({ where: { status: 'COMPLETED' }, take: 200 });
    let created = 0;
    for (const execution of completed) {
        const existing = await db.custodyMovement.findFirst({ where: { custodyExecutionId: execution.id } });
        if (existing) continue;
        await db.$transaction(async (tx) => {
            await recordExecutionMovement(tx, { execution, hotWalletAddress });
        });
        created += 1;
    }
    return { created };
}

// ── balance evidence (custody-account PoR observations) ────────────────────
/**
 * Record a fresh ACCOUNT_BALANCE observation for a custody account. The new
 * observation supersedes (never silently overwrites) the previous accepted
 * one; the previous row is retained as SUPERSEDED for audit. Out-of-order and
 * exact-duplicate observations converge idempotently; concurrent observations
 converge on the partial unique ACTIVE index.
 */
async function observeAccountBalance(db, { account, provider }) {
    if (!provider || provider.source !== 'TATUM_V3_TOKEN_BALANCE') {
        throw new Error('observeAccountBalance: a TATUM_V3_TOKEN_BALANCE provider is required');
    }
    let obs;
    try {
        obs = await provider.getBalance({
            network: account.network,
            contractAddress: account.contractAddress,
            address: account.address,
            decimals: 6,
        });
    } catch (err) {
        if (err instanceof CustodyEvidenceError) {
            return { recorded: false, reason: err.code, retryable: true };
        }
        throw err;
    }
    // Bind the observation to exactly what was requested — fail closed.
    if (
        normalizeAddress(obs.address) !== normalizeAddress(account.address) ||
        normalizeAddress(obs.contractAddress) !== normalizeAddress(account.contractAddress) ||
        String(obs.network).toUpperCase() !== String(account.network).toUpperCase()
    ) {
        return { recorded: false, reason: EVIDENCE_ERRORS.MALFORMED_RESPONSE, retryable: false };
    }
    return db.$transaction(async (tx) => {
        const current = await tx.custodyEvidence.findFirst({
            where: { custodyAccountId: account.id, status: 'ACTIVE' },
        });
        if (current) {
            if (current.observedAt.getTime() === obs.observedAt.getTime() && current.balanceBaseUnits === obs.balanceBaseUnits) {
                return { recorded: false, evidence: current, idempotent: true };
            }
            if (current.observedAt.getTime() > obs.observedAt.getTime()) {
                // Conflicting/out-of-order observation: recorded for audit but
                // never allowed to silently overwrite a newer accepted value.
                await tx.custodyEvidence.create({
                    data: {
                        custodyAccountId: account.id,
                        source: obs.source,
                        scope: 'ACCOUNT_BALANCE',
                        network: account.network,
                        asset: account.asset,
                        contractAddress: normalizeAddress(account.contractAddress),
                        address: normalizeAddress(account.address),
                        balanceBaseUnits: obs.balanceBaseUnits,
                        observedAt: obs.observedAt,
                        status: 'REJECTED',
                        rejectionReason: 'OUT_OF_ORDER_OBSERVATION',
                    },
                });
                return { recorded: false, reason: 'OUT_OF_ORDER_OBSERVATION', retryable: false };
            }
        }
        // Supersede the current ACTIVE row BEFORE creating the new one — the
        // partial unique index (one ACTIVE per custodyAccount) forbids two
        // in-flight ACTIVE rows even inside a single transaction.
        if (current) {
            await tx.custodyEvidence.update({
                where: { id: current.id },
                data: { status: 'SUPERSEDED' },
            });
        }
        const fresh = await tx.custodyEvidence.create({
            data: {
                custodyAccountId: account.id,
                source: obs.source,
                scope: 'ACCOUNT_BALANCE',
                network: account.network,
                asset: account.asset,
                contractAddress: normalizeAddress(account.contractAddress),
                address: normalizeAddress(account.address),
                balanceBaseUnits: obs.balanceBaseUnits,
                observedAt: obs.observedAt,
                blockReference: null,
                status: 'ACTIVE',
                raw: { balance: obs.balanceBaseUnits.toString() },
            },
        });
        if (current) {
            await tx.custodyEvidence.update({
                where: { id: current.id },
                data: { status: 'SUPERSEDED', supersededById: fresh.id },
            });
        }
        return { recorded: true, evidence: fresh };
    }).catch(async (err) => {
        // Concurrency convergence: a parallel observer won the ACTIVE slot
        // between our read and our create. Postgres aborts the whole
        // transaction on the unique violation, so recovery happens AFTER the
        // rollback, against the winner's committed row.
        if (err && err.code === 'P2002') {
            const winner = await db.custodyEvidence.findFirst({
                where: { custodyAccountId: account.id, status: 'ACTIVE' },
            });
            // The concurrent winner recorded the SAME balance → idempotent
            // with the winner's row; the caller aggregates the identical
            // accepted state. A DIFFERENT balance is a genuine conflict.
            if (winner && winner.balanceBaseUnits === obs.balanceBaseUnits) {
                return { recorded: false, evidence: winner, idempotent: true };
            }
            return { recorded: false, reason: 'CONCURRENT_OBSERVATION', retryable: true };
        }
        throw err;
    });
}

/** The accepted evidence for an account IF it is still fresh; else null. */
async function getFreshAcceptedEvidence(db, { custodyAccountId, maxAgeMs }) {
    const evidence = await db.custodyEvidence.findFirst({
        where: { custodyAccountId, status: 'ACTIVE' },
    });
    if (!evidence) return null;
    const age = Date.now() - evidence.observedAt.getTime();
    if (age > maxAgeMs) return null;
    return evidence;
}

// ── USDC liability flow classification (denomination-honest) ───────────────
/**
 * Classify the USDC-denominated customer obligation from authoritative
 * TransactionHistory rows. This is a FLOW classification, NOT a re-interpretation
 * of the mixed balance pool:
 *
 *   X (usdcLiabilityTotal) = classified USDC-denominated external credits
 *         (DEPOSIT_CRYPTO + USDC-settled DEPOSIT_FIAT quote paths, COMPLETED)
 *       − classified USDC-denominated external debits
 *         (WITHDRAWAL_CRYPTO + WITHDRAWAL_FIAT, COMPLETED, amount + fee)
 *
 *   Y (evidenceLinked) = transaction-evidence-verified deposit movements
 *       − evidence-gated WITHDRAWAL_CRYPTO net payouts
 *
 *   Z (unclassified exposure) is computed by the caller as the mixed-pool
 *   liability total minus X — it can only be POSITIVE evidence that the pool
 *   contains claims this classification does not explain. Z is NEVER silently
 *   dropped from the report; it forces the attestation to INCOMPLETE.
 *
 * All arithmetic is exact Prisma.Decimal (SQL numeric aggregates — never
 * JS floats). Returns exact Decimal components; the caller composes them.
 */
async function classifyUsdcLiabilityFlows(db) {
    const creditAgg = await db.transactionHistory.aggregate({
        where: { type: { in: ['DEPOSIT_CRYPTO', 'DEPOSIT_FIAT'] }, status: 'COMPLETED' },
        _sum: { amountUsdc: true },
    });
    const withdrawCryptoAgg = await db.transactionHistory.aggregate({
        where: { type: 'WITHDRAWAL_CRYPTO', status: 'COMPLETED' },
        _sum: { amountUsdc: true, feeUsdc: true },
    });
    const withdrawFiatAgg = await db.transactionHistory.aggregate({
        where: { type: 'WITHDRAWAL_FIAT', status: 'COMPLETED' },
        _sum: { amountUsdc: true, feeUsdc: true },
    });

    const zero = new Prisma.Decimal(0);
    const usdcCredits = creditAgg._sum.amountUsdc || zero;
    const cryptoDebitNet = withdrawCryptoAgg._sum.amountUsdc || zero;
    const cryptoDebitFee = withdrawCryptoAgg._sum.feeUsdc || zero;
    const fiatDebitNet = withdrawFiatAgg._sum.amountUsdc || zero;
    const fiatDebitFee = withdrawFiatAgg._sum.feeUsdc || zero;

    // Customer obligation decreased by the FULL debit (net payout + fee).
    const usdcDebits = cryptoDebitNet.plus(cryptoDebitFee).plus(fiatDebitNet).plus(fiatDebitFee);
    const xRaw = usdcCredits.minus(usdcDebits);
    const x = xRaw.gt(zero) ? xRaw : zero;

    // Evidence-linked subset: verified deposits − evidence-gated crypto payouts
    // (net on-chain outflow; the fee never left the chain).
    const verifiedDepositAgg = await db.custodyMovement.aggregate({
        where: { kind: MOVEMENT_KINDS.DEPOSIT_IN, status: MOVEMENT_STATUS.VERIFIED },
        _sum: { amountBaseUnits: true },
    });
    const verifiedDepositsBase = verifiedDepositAgg._sum.amountBaseUnits
        ? decimalFromBaseUnits(BigInt(verifiedDepositAgg._sum.amountBaseUnits))
        : zero;
    const yRaw = verifiedDepositsBase.minus(cryptoDebitNet);

    return {
        usdcCredits,
        usdcDebits,
        usdcLiabilityTotal: x,           // X — exact, floored at zero
        usdcLiabilityTotalSigned: xRaw,
        evidenceLinkedUsdcObligation: yRaw, // Y — exact signed
        verifiedDepositsTotal: verifiedDepositsBase,
        cryptoWithdrawalsNet: cryptoDebitNet,
        fiatWithdrawalsNet: fiatDebitNet,
        fiatWithdrawalsFees: fiatDebitFee,
        cryptoWithdrawalsFees: cryptoDebitFee,
    };
}

/**
 * Build candidate movements for historical COMPLETED DEPOSIT_CRYPTO rows that
 * lack one — identity derivable from authoritative rows (txHash, credited
 * amount, owner's registry address). Candidates still require transaction
 * evidence verification before they contribute anywhere. Idempotent.
 */
async function buildDepositCandidatesFromHistory(db, { limit = 100 } = {}) {
    const rows = await db.transactionHistory.findMany({
        where: { type: 'DEPOSIT_CRYPTO', status: 'COMPLETED', txHash: { not: null } },
        orderBy: { createdAt: 'asc' },
        take: limit * 2, // filter to those without movements below
    });
    let created = 0;
    for (const row of rows.slice(0, limit * 2)) {
        if (created >= limit) break;
        const idempotencyKey = `deposit:POLYGON:${String(row.txHash).toLowerCase()}`;
        const existing = await db.custodyMovement.findUnique({ where: { idempotencyKey } });
        if (existing) continue;
        // Owner's ACTIVE registry deposit address — derivable identity only.
        const walletAddress = await db.walletAddress.findFirst({
            where: { userId: row.userId, status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
        });
        if (!walletAddress) continue; // not derivable — stays in X, never in Y
        const amountBaseUnits = (() => {
            const str = new Prisma.Decimal(row.amountUsdc || 0).toFixed(6);
            const [intPart, fracPart = ''] = str.split('.');
            return BigInt(intPart + fracPart.padEnd(6, '0'));
        })();
        if (amountBaseUnits <= 0n) continue;
        await db.$transaction(async (tx) => {
            await recordDepositCandidate(tx, {
                walletAddress,
                txHash: row.txHash,
                amountBaseUnits,
                transactionHistoryId: row.id,
                creditedAmountDecimalString: new Prisma.Decimal(row.amountUsdc || 0).toFixed(6),
            });
        });
        created += 1;
    }
    return { created };
}

module.exports = {
    prisma,
    TIERS,
    CONTROL,
    MOVEMENT_KINDS,
    MOVEMENT_STATUS,
    JOURNAL,
    decimalStringFromBaseUnits,
    decimalFromBaseUnits,
    ensureDepositAccount,
    ensureHotWalletAccount,
    syncAndListEligibleAccounts,
    postCustodyJournal,
    recordDepositCandidate,
    verifyDepositMovement,
    verifyPendingDepositMovements,
    recordExecutionMovement,
    backfillMovementsForCompletedExecutions,
    observeAccountBalance,
    getFreshAcceptedEvidence,
    classifyUsdcLiabilityFlows,
    buildDepositCandidatesFromHistory,
};
