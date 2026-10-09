// controllers/warRoomController.js
// =============================================================================
// AZAMAN V2 — WAR ROOM CONTROLLER (Admin)   (Phase B updates)
//
// Operates on the four V2 system singletons (SystemMasterCrypto,
// SystemHotWallet, SystemFiatPool, SystemProfitFees). The legacy
// `systemLedger` model is GONE — every reference here uses the V2 singletons.
//
// Endpoints (mounted at /api/war-room, all admin-only):
//   POST /corporate-purchase       — log Yellow Card / OTC top-up + credit master crypto (manual)
//   POST /corporate-purchase/api   — Phase B: Kotani-quoted automated corporate purchase
//   POST /liquidate-profits        — delegate to finance.service.liquidateProfits
//   POST /cold-storage             — log hardware-wallet movement (audit trail only)
// =============================================================================

const logger = require('../src/config/logger');
const crypto         = require('crypto');
const ledger         = require('../services/ledgerService');
const { commitOperation } = require('../middleware/idempotency');
const financeService = require('../services/finance.service');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lazy-upsert SystemMasterCrypto singleton (id = 1). */
const _ensureMasterCrypto = (tx) =>
    tx.systemMasterCrypto.upsert({
        where:  { id: 1 },
        update: {},
        create: { id: 1, balance: 0.0 }
    });

// =============================================================================
// POST /api/war-room/corporate-purchase
//
// Body: { usdcAmount, fiatSentTotal, discountRate, actualMarketRate,
//         screenshotUrl?, purchaseMethod? ('API'|'MANUAL') }
//
// Atomically:
//   1. Writes a CorporatePurchaseLog row (audit trail)
//   2. Credits SystemMasterCrypto.balance by usdcAmount
// =============================================================================
const logCorporatePurchase = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const {
            usdcAmount,
            fiatSentTotal,
            discountRate,
            actualMarketRate,
            screenshotUrl,
            purchaseMethod
        } = req.body;
        const adminId = req.user.id;

        if (!usdcAmount || !fiatSentTotal || !discountRate || !actualMarketRate) {
            return res.status(400).json({
                success: false,
                message: 'usdcAmount, fiatSentTotal, discountRate, and actualMarketRate are required.'
            });
        }

        // r272 finding 2 — exact money. parseFloat feeds Decimal(20,8)/
        // Decimal(18,8) columns with binary floats (0.1+0.2 problems,
        // silent 17-digit representations on the increment projection).
        // Every monetary field now enters as an exact Decimal through the
        // ledger's fail-closed parser: exponent notation, >8dp strings and
        // negative/NaN values are rejected before any economics execute.
        const parsePositive = (value, label) => {
            const d = ledger.toExactDecimal(value, label);
            if (d.isZero()) {
                throw Object.assign(new Error(`${label} must be positive.`), { statusCode: 400 });
            }
            return d;
        };
        let usdcAmountD, fiatSentTotalD, discountRateD, actualMarketRateD;
        try {
            usdcAmountD       = parsePositive(usdcAmount, 'usdcAmount');
            fiatSentTotalD    = parsePositive(fiatSentTotal, 'fiatSentTotal');
            discountRateD     = parsePositive(discountRate, 'discountRate');
            actualMarketRateD = parsePositive(actualMarketRate, 'actualMarketRate');
        } catch (err) {
            return res.status(err.statusCode || 400).json({
                success: false,
                message: err.statusCode === 400 ? err.message : 'All numeric fields must be exact positive decimals (<= 8 decimal places).'
            });
        }

        const method = (purchaseMethod === 'API') ? 'API' : 'MANUAL';

        // r272 finding 2 — the idempotency claim is committed INSIDE the
        // economic transaction (the wired pattern): commitOperation runs
        // on the SAME `tx`, so the claim flip and the treasury credit are
        // one atomic unit. A rolled-back transaction leaves the claim
        // IN_PROGRESS — durable proof of rollback that releaseOn4xx
        // re-arms — and a retry with the same key replays the committed
        // result instead of crediting the treasury twice.
        const responseBody = await prisma.$transaction(async (tx) => {
            const log = await tx.corporatePurchaseLog.create({
                data: {
                    usdcAmount:       usdcAmountD,
                    fiatSentTotal:    fiatSentTotalD,
                    discountRate:     discountRateD,
                    actualMarketRate: actualMarketRateD,
                    screenshotUrl:    screenshotUrl || null,
                    purchaseMethod:   method,
                    adminId:          parseInt(adminId, 10)
                }
            });

            await _ensureMasterCrypto(tx);
            await tx.systemMasterCrypto.update({
                where: { id: 1 },
                data:  { balance: { increment: usdcAmountD } }
            });

            const updated = await tx.systemMasterCrypto.findUnique({ where: { id: 1 } });
            const body = {
                success: true,
                message: 'Corporate purchase logged. SystemMasterCrypto credited.',
                data: {
                    purchaseLog:           log,
                    systemMasterCrypto:    updated.balance
                }
            };
            await commitOperation(tx, res.locals.financialOperation, 201, body);
            return body;
        });

        return res.status(201).json(responseBody);
    } catch (error) {
        logger.error({ err: error }, 'logCorporatePurchase error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/war-room/corporate-purchase/api    (Phase B)
//
// Body: {
//   fiatGhs:          number,          // total GHS the admin sent OTC
//   recipientPhone?:  string,          // optional (informational metadata)
//   recipientNetwork?: 'MTN'|'TELECEL'|'AIRTELTIGO',  // VODAFONE accepted as legacy alias
//   screenshotUrl?:   string,          // optional proof of OTC settlement
//   gatewayReference?: string          // optional override (otherwise generated)
// }
//
// Atomically:
//   1. Pull the LIVE corporate (OTC) and retail rates from the Kotani gateway.
//   2. Compute usdcAmount = fiatGhs / corporateRate.
//   3. Compute discountRate = (retailRate - corporateRate) / retailRate.
//   4. Write a CorporatePurchaseLog row with purchaseMethod='API' and the
//      gateway provenance fields populated.
//   5. Credit SystemMasterCrypto.balance by usdcAmount.
//
// The gatewayReference column is UNIQUE → the schema itself rejects double
// credits if the same Kotani settlement is replayed.
// =============================================================================
const purchaseCorporateViaApi = async (req, res) => {
    const prisma         = req.app.get('prisma');
    const gatewayService = req.app.get('gatewayService');

    try {
        const {
            fiatGhs,
            recipientPhone,
            recipientNetwork,
            screenshotUrl,
            gatewayReference: incomingRef
        } = req.body || {};
        const adminId = req.user.id;

        if (!fiatGhs || Number(fiatGhs) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'fiatGhs is required and must be positive.'
            });
        }
        // r272 finding 2 — exact money: the GHS amount enters as an exact
        // Decimal (fail-closed parse), never a binary float.
        let fiatGhsD;
        try {
            fiatGhsD = ledger.toExactDecimal(fiatGhs, 'fiatGhs');
            if (fiatGhsD.isZero()) throw new Error('fiatGhs must be positive.');
        } catch (err) {
            return res.status(400).json({
                success: false,
                message: 'fiatGhs must be an exact positive decimal (<= 8 decimal places).'
            });
        }
        if (!gatewayService) {
            return res.status(503).json({
                success: false,
                message: 'Gateway service is not configured on this server.'
            });
        }

        // 1. Pull live rates from the gateway.
        const rates = await gatewayService.fetchOfframpRates();
        if (!rates || !rates.corporateRate || rates.corporateRate <= 0) {
            return res.status(503).json({
                success: false,
                message: 'Live corporate rate unavailable — try again shortly.'
            });
        }

        // r272 finding 2 — exact money end-to-end. Rates arrive as floats
        // from the gateway; every derived amount is computed with exact
        // Decimal arithmetic and persisted as the 8dp string the
        // Decimal(20,8)/Decimal(18,8) columns actually store — the float
        // pipeline (parseFloat, toFixed(6), increment-by-float) is gone.
        const corporateRateD    = ledger.toExactDecimal(rates.corporateRate, 'corporateRate');
        const actualMarketRateD = ledger.toExactDecimal(rates.retailRate, 'retailRate');
        const usdcAmountD       = fiatGhsD.div(corporateRateD).toDecimalPlaces(8);
        const discountRateD     = actualMarketRateD.isZero()
            ? new (require('@prisma/client').Decimal)(0)
            : actualMarketRateD.minus(corporateRateD).div(actualMarketRateD).toDecimalPlaces(8);
        const corporateRate      = corporateRateD.toString();
        const actualMarketRate   = actualMarketRateD.toString();
        const usdcAmount         = usdcAmountD.toString();
        const discountRate       = discountRateD.toString();
        const fiatGhsValue       = fiatGhsD.toString();
        const gatewayReference   = (typeof incomingRef === 'string' && incomingRef.length > 0)
            ? incomingRef
            : `KOTANI_BUY_${adminId}_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        // 2. Atomic write: log + credit + idempotency claim commit — one
        // transaction. The claim commits on the same tx (wired pattern), so
        // a retried POST replays the committed response instead of writing a
        // second CorporatePurchaseLog row and crediting the treasury twice.
        const responseBody = await prisma.$transaction(async (tx) => {
            const log = await tx.corporatePurchaseLog.create({
                data: {
                    usdcAmount:       usdcAmountD,
                    fiatSentTotal:    fiatGhsD,
                    discountRate:     discountRateD,
                    actualMarketRate: actualMarketRateD,
                    screenshotUrl:    screenshotUrl || null,
                    purchaseMethod:   'API',
                    adminId:          parseInt(adminId, 10),
                    gatewayProvider:  'KOTANI_PAY',
                    gatewayReference
                }
            });

            await _ensureMasterCrypto(tx);
            await tx.systemMasterCrypto.update({
                where: { id: 1 },
                data:  { balance: { increment: usdcAmountD } }
            });

            const updated = await tx.systemMasterCrypto.findUnique({ where: { id: 1 } });
            const body = {
                success: true,
                message: 'Corporate API purchase logged. SystemMasterCrypto credited.',
                data: {
                    purchaseLog:        log,
                    systemMasterCrypto: updated.balance,
                    quote: {
                        provider:         rates.provider,
                        source:           rates.source,
                        corporateRate,
                        actualMarketRate,
                        discountRate,
                        fiatGhs:          fiatGhsValue,
                        usdcAmount,
                        gatewayReference
                    },
                    metadata: {
                        recipientPhone:   recipientPhone   || null,
                        recipientNetwork: recipientNetwork || null
                    }
                }
            };
            await commitOperation(tx, res.locals.financialOperation, 201, body);
            return body;
        });

        return res.status(201).json(responseBody);
    } catch (error) {
        // P2002 → unique constraint violation on gatewayReference (replay)
        if (error?.code === 'P2002') {
            return res.status(409).json({
                success: false,
                code:    'CORPORATE_REFERENCE_REPLAY',
                message: 'A corporate purchase with this gatewayReference already exists.'
            });
        }
        logger.error({ err: error }, 'purchaseCorporateViaApi error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/war-room/liquidate-profits
//
// Delegates to finance.service.liquidateProfits — single source of truth for
// the SystemProfitFees → SystemFiatPool transfer (V2 singletons).
// =============================================================================
const liquidateProfits = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { amountUsdc } = req.body;
        if (!amountUsdc || Number(amountUsdc) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid liquidation amount.' });
        }

        const data = await financeService.liquidateProfits(
            prisma,
            parseFloat(amountUsdc),
            req.user.id
        );

        try {
            io.emit('admin_alert', {
                type:             'PROFIT_LIQUIDATION',
                amountLiquidated: data.amountLiquidated,
                newProfitFees:    data.newProfitFees,
                newFiatPool:      data.newFiatPool,
                timestamp:        new Date().toISOString()
            });
        } catch (socketErr) {
            logger.error({ err: socketErr }, 'liquidateProfits socket emit failed');
        }

        return res.status(200).json({
            success: true,
            message: `Liquidated ${data.amountLiquidated} USDC from SystemProfitFees to SystemFiatPool.`,
            data
        });
    } catch (error) {
        logger.error({ err: error }, 'liquidateProfits error');
        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/war-room/cold-storage
//
// Body: { amountUsdc, direction ('TO_COLD'|'TO_HOT'), notes? }
//
// Audit-trail only. The actual on-chain movement happens out-of-band via
// hardware-wallet operations. This endpoint records the admin's intent.
// =============================================================================
const logColdStorage = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { amountUsdc, direction, notes } = req.body;
        const adminId = req.user.id;

        if (!amountUsdc || Number(amountUsdc) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount.' });
        }
        if (!['TO_COLD', 'TO_HOT'].includes(direction)) {
            return res.status(400).json({
                success: false,
                message: 'Direction must be TO_COLD or TO_HOT.'
            });
        }

        const log = await prisma.coldStorageLog.create({
            data: {
                amountUsdc: parseFloat(amountUsdc),
                direction,
                adminId:    parseInt(adminId, 10),
                notes:      notes || null
            }
        });

        return res.status(201).json({
            success: true,
            message: `Cold storage movement logged: ${direction}.`,
            data:    { log }
        });
    } catch (error) {
        logger.error({ err: error }, 'logColdStorage error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = { logCorporatePurchase, purchaseCorporateViaApi, liquidateProfits, logColdStorage };
