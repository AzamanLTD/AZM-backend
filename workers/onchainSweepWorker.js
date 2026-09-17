// workers/onchainSweepWorker.js
// =============================================================================
// AZAMAN — ON-CHAIN SWEEP WORKER (Phase 2: Scalability & Security)
//
// Periodically consolidates USDC balances from individual user deposit
// addresses into the platform's master treasury wallet on Polygon.
//
// Why: When users deposit USDC on Polygon, funds land at their derived HD
// wallet address. For security and operational efficiency, these funds should
// be swept into the platform's cold/hot treasury wallet rather than sitting
// scattered across hundreds of addresses.
//
// Strategy:
//   1. Query all canonical ACTIVE Polygon native-USDC WalletAddress rows
//      (the AUTHORITATIVE address registry — §P.1; User.tatumPolygonAddress is
//      no longer a discovery source)
//   2. For each, check on-chain USDC balance via Tatum API
//   3. If balance > SWEEP_THRESHOLD_USDC, broadcast a sweep transaction
//      (from user's derived address → treasury master address)
//   4. Record the sweep in a new OnchainSweep record for audit trail
//
// Modes:
//   - LIVE (TATUM_PROVIDER=LIVE): real on-chain sweeps via Tatum
//   - MOCK (default): logs what would be swept, no actual transactions
//
// No-op safe in test mode (NODE_ENV=test).
// =============================================================================

const logger = require('../src/config/logger');
const axios = require('axios');
const custody = require('../services/tatumCustodyExecutionService');
const { CustodyExecutionError } = require('../services/custodyExecutionErrors');

const INTERVAL_MS = 60 * 60 * 1000; // every hour
const SWEEP_THRESHOLD_USDC = 10;    // don't sweep dust below $10

class OnchainSweepWorker {
    constructor(prisma, tatumService, { intervalMs = INTERVAL_MS } = {}) {
        this.prisma = prisma;
        this.tatumService = tatumService;
        this.intervalMs = intervalMs;
        this.interval = null;
        this._running = false;

        this.treasuryAddress = process.env.TATUM_TREASURY_ADDRESS || null;
        this.tatumKey = process.env.TATUM_API_KEY || null;
        this.tatumBase = process.env.TATUM_BASE_URL || 'https://api.tatum.io/v3';
        this.isLive = process.env.TATUM_PROVIDER === 'LIVE' && !!this.tatumKey;
    }

    start() {
        if (this.interval) return;
        logger.info(`[OnchainSweepWorker] scheduled (every ${this.intervalMs / 1000}s, mode: ${this.isLive ? 'LIVE' : 'MOCK'})`);
        // First sweep 2 minutes after boot
        setTimeout(() => this._tick().catch(err => logger.error({ err }, '[OnchainSweepWorker] initial tick')), 120_000);
        this.interval = setInterval(() => this._tick().catch(err => logger.error({ err }, '[OnchainSweepWorker] tick error')), this.intervalMs);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async _tick() {
        if (this._running) return;
        this._running = true;

        try {
            // Address DISCOVERY comes from the authoritative WalletAddress
            // registry (canonical ACTIVE Polygon native-USDC rows only). Real
            // signing/broadcast belongs to §P.2 and is deliberately absent here.
            const addresses = await this.prisma.walletAddress.findMany({
                where: {
                    status:          'ACTIVE',
                    network:         'POLYGON',
                    contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
                },
                select: { id: true, userId: true, address: true, derivationIndex: true },
            });

            // P2: also advance any in-flight custody executions (withdrawals
            // and sweeps) one lifecycle step using real provider/chain
            // evidence. Non-destructive, idempotent; fails closed unless the
            // full LIVE+KMS+execution gate is on.
            try {
                const advanced = await custody.reconcilePendingExecutions(this.prisma);
                if (advanced.length > 0) {
                    logger.info({ advanced }, '[OnchainSweepWorker] custody executions reconciled');
                }
            } catch (err) {
                if (err.errorClass !== 'CONFIGURATION_ERROR') {
                    logger.warn({ err: err.message }, '[OnchainSweepWorker] custody reconciliation pass failed');
                }
            }

            if (addresses.length === 0) {
                logger.debug('[OnchainSweepWorker] No addresses to sweep');
                return;
            }

            let sweptCount = 0;
            let sweptTotal = 0;

            for (const entry of addresses) {
                try {
                    const balanceRaw = await this._getOnchainBalanceRaw(entry.address);
                    const balanceBase = custody.toBaseUnits(balanceRaw); // exact integer units

                    if (balanceBase < BigInt(Math.trunc(SWEEP_THRESHOLD_USDC * 1e6))) continue;

                    if (!this.isLive) {
                        logger.info(
                            `[OnchainSweepWorker] MOCK: would sweep ${balanceRaw} USDC from user ${entry.userId} (${entry.address})`
                        );
                        sweptCount++;
                        sweptTotal += parseFloat(balanceRaw);
                        continue;
                    }

                    // LIVE mode — real KMS-capable execution
                    const swept = await this._executeSweep(entry, balanceBase);
                    if (swept) {
                        sweptCount++;
                        sweptTotal += parseFloat(balanceRaw);
                    }
                } catch (err) {
                    if (err instanceof CustodyExecutionError && err.errorClass === 'INVALID_ASSET') continue; // unusable provider amount shape — skip
                    logger.warn({ err: err.message, userId: entry.userId }, '[OnchainSweepWorker] per-address error');
                }
            }

            if (sweptCount > 0) {
                logger.info(
                    `[OnchainSweepWorker] Swept ${sweptCount} address(es), total ${sweptTotal} USDC (mode: ${this.isLive ? 'LIVE' : 'MOCK'})`
                );
            }
        } finally {
            this._running = false;
        }
    }

    /**
     * Get the USDC balance for an address on Polygon.
     * In MOCK mode, returns a deterministic pseudo-balance.
     */
    async _getOnchainBalanceRaw(address) {
        if (!this.isLive) {
            // Mock: deterministic pseudo-balance based on address hash
            const hash = require('crypto').createHash('md5').update(address).digest('hex');
            const pseudo = (parseInt(hash.substring(0, 8), 16) % 50000000) / 1000000;
            return pseudo.toFixed(6);
        }

        // LIVE: query Tatum for the USDC balance of the NATIVE contract only.
        const resp = await axios.get(
            `${this.tatumBase}/polygon/account/balance/${address}`,
            { headers: { 'x-api-key': this.tatumKey }, timeout: 10000 }
        );

        // Tatum returns an array of { asset, balance } per token. Match the
        // exact canonical identity — bridged USDC.e is a DIFFERENT asset and
        // is never swept as native USDC.
        const native = resp.data?.find?.(
            (e) => (e.asset === 'USDC' || e.asset === custody.CANONICAL.contractAddress)
                && custody.toBaseUnits(String(e.balance || '0')) > 0n
        );
        return native ? String(native.balance) : '0';
    }

    // Back-compat helper for existing callers/tests.
    async _getOnchainBalance(address) {
        return parseFloat(await this._getOnchainBalanceRaw(address));
    }

    /**
     * P2 REAL sweep execution (LIVE mode only).
     *
     * The on-chain balance (observed by the tick) is authoritative. Flow:
     *   1. atomic claim via the partial unique index (one in-flight sweep per
     *      WalletAddress no matter how many workers overlap — losers converge
     *      on the winner's execution and NEVER double-send);
     *   2. OnchainSweep audit row;
     *   3. durable four-eye approval of the EXACT intended transfer;
     *   4. submit through the KMS boundary (signer/address correspondence
     *      proven first: signatureId + derivationIndex must control the
     *      WalletAddress address, or the execution is a hard failure);
     *   5. tx evidence persisted; CONFIRMED only after verified chain
     *      evidence (reconcilePendingExecutions / advanceExecution).
     *
     * A sweep can no longer claim completion without a real execution
     * result: this returns true only when a durable CustodyExecution exists.
     */
    async _executeSweep(entry, balanceBaseUnits) {
        const gate = custody.executionGateStatus();
        if (!gate.enabled) {
            logger.warn('[OnchainSweepWorker] live sweep requested but execution gates are OFF — skipping (fail-closed, no fabricated result)');
            return false;
        }

        const cfg = custody.getConfig();
        if (!cfg.hotWalletAddress) {
            logger.warn('[OnchainSweepWorker] master hot wallet address not configured — skipping live sweep (fail-closed)');
            return false;
        }

        const pre = await custody.preflight(this.prisma);
        if (!pre.readyForLiveExecution) {
            logger.warn({ checks: pre.checks }, '[OnchainSweepWorker] custody preflight failed — skipping live sweep (fail-closed)');
            return false;
        }

        // Atomic claim BEFORE any construction of the transfer.
        const sweepAudit = await this.prisma.onchainSweep.create({
            data: {
                userId:      entry.userId,
                fromAddress: entry.address,
                toAddress:   cfg.hotWalletAddress,
                amountUsdc:  Number(balanceBaseUnits) / 1e6, // exact — BigInt division would TRUNCATE
                status:      'BROADCASTING',
                txHash:      null,
            },
        }).catch(() => null); // audit-row failure never blocks the real claim

        const { execution, isNew } = await custody.claimSweepExecution(this.prisma, {
            walletAddressId: entry.id,
            userId:          entry.userId,
            fromAddress:     entry.address,
            toAddress:      cfg.hotWalletAddress,
            amountBaseUnits: balanceBaseUnits,
            onchainSweepId: sweepAudit ? sweepAudit.id : null,
            metadata: {
                derivationIndex: entry.derivationIndex,
                source:          'onchain-sweep-worker',
            },
        });
        if (!isNew) {
            // A concurrent worker already owns this address's in-flight sweep.
            return false;
        }

        try {
            // Durable four-eye approval of the exact intended transfer.
            await custody.approveKmsRequest(this.prisma, {
                executionId: execution.id,
                expected: {
                    kind:            'DEPOSIT_SWEEP',
                    refId:           sweepAudit ? String(sweepAudit.id) : null,
                    userId:          entry.userId,
                    fromAddress:     entry.address,
                    toAddress:       cfg.hotWalletAddress,
                    contractAddress: custody.CANONICAL.contractAddress,
                    amountBaseUnits: balanceBaseUnits,
                },
            });

            const submission = await custody.submitExecution(this.prisma, { executionId: execution.id });
            logger.info({ executionId: execution.id, status: submission.status, txHash: submission.txHash || null },
                '[OnchainSweepWorker] sweep submitted through KMS boundary');
            return true;
        } catch (err) {
            if (err instanceof CustodyExecutionError && err.definitivePreBroadcast) {
                // Definitive pre-broadcast failure: nothing was sent, no
                // customer money moved (sweeps claim no internal funds). Mark
                // FAILED so the address is claimable again next tick.
                await custody.failExecution(this.prisma, {
                    executionId:  execution.id,
                    errorClass:   err.errorClass,
                    errorMessage: err.message,
                });
                if (sweepAudit) {
                    await this.prisma.onchainSweep.update({
                        where: { id: sweepAudit.id },
                        data:  { status: 'FAILED' },
                    }).catch(() => {});
                }
                logger.warn({ err: err.message, executionId: execution.id }, '[OnchainSweepWorker] sweep definitively rejected pre-broadcast');
                return false;
            }
            // Ambiguous: the execution is already RECONCILIATION_REQUIRED —
            // never blindly re-send the same balance; reconciliation decides.
            if (sweepAudit) {
                await this.prisma.onchainSweep.update({
                    where: { id: sweepAudit.id },
                    data:  { status: 'RECONCILIATION_REQUIRED' },
                }).catch(() => {});
            }
            logger.error({ err: err.message, executionId: execution.id },
                '[OnchainSweepWorker] sweep outcome AMBIGUOUS — reconciliation required, no retry');
            return false;
        }
    }
}

module.exports = OnchainSweepWorker;
