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

const crypto         = require('crypto');
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

        const usdcAmountFloat       = parseFloat(usdcAmount);
        const fiatSentTotalFloat    = parseFloat(fiatSentTotal);
        const discountRateFloat     = parseFloat(discountRate);
        const actualMarketRateFloat = parseFloat(actualMarketRate);

        if ([usdcAmountFloat, fiatSentTotalFloat, discountRateFloat, actualMarketRateFloat].some(v => isNaN(v) || v <= 0)) {
            return res.status(400).json({
                success: false,
                message: 'All numeric fields must be positive numbers.'
            });
        }

        const method = (purchaseMethod === 'API') ? 'API' : 'MANUAL';

        const result = await prisma.$transaction(async (tx) => {
            const log = await tx.corporatePurchaseLog.create({
                data: {
                    usdcAmount:       usdcAmountFloat,
                    fiatSentTotal:    fiatSentTotalFloat,
                    discountRate:     discountRateFloat,
                    actualMarketRate: actualMarketRateFloat,
                    screenshotUrl:    screenshotUrl || null,
                    purchaseMethod:   method,
                    adminId:          parseInt(adminId, 10)
                }
            });

            await _ensureMasterCrypto(tx);
            await tx.systemMasterCrypto.update({
                where: { id: 1 },
                data:  { balance: { increment: usdcAmountFloat } }
            });

            const updated = await tx.systemMasterCrypto.findUnique({ where: { id: 1 } });
            return { log, updated };
        });

        return res.status(201).json({
            success: true,
            message: 'Corporate purchase logged. SystemMasterCrypto credited.',
            data: {
                purchaseLog:           result.log,
                systemMasterCrypto:    result.updated.balance
            }
        });
    } catch (error) {
        console.error('logCorporatePurchase error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/war-room/corporate-purchase/api    (Phase B)
//
// Body: {
//   fiatGhs:          number,          // total GHS the admin sent OTC
//   recipientPhone?:  string,          // optional (informational metadata)
//   recipientNetwork?: 'MTN'|'VODAFONE'|'AIRTELTIGO',
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

        const fiatGhsFloat       = parseFloat(fiatGhs);
        const corporateRate      = rates.corporateRate;
        const actualMarketRate   = rates.retailRate;
        const usdcAmount         = parseFloat((fiatGhsFloat / corporateRate).toFixed(6));
        const discountRate       = parseFloat((((actualMarketRate - corporateRate) / actualMarketRate) || 0).toFixed(6));
        const gatewayReference   = (typeof incomingRef === 'string' && incomingRef.length > 0)
            ? incomingRef
            : `KOTANI_BUY_${adminId}_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        // 2. Atomic write: log + credit.
        const result = await prisma.$transaction(async (tx) => {
            const log = await tx.corporatePurchaseLog.create({
                data: {
                    usdcAmount,
                    fiatSentTotal:    fiatGhsFloat,
                    discountRate,
                    actualMarketRate,
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
                data:  { balance: { increment: usdcAmount } }
            });

            const updated = await tx.systemMasterCrypto.findUnique({ where: { id: 1 } });
            return { log, updated };
        });

        return res.status(201).json({
            success: true,
            message: 'Corporate API purchase logged. SystemMasterCrypto credited.',
            data: {
                purchaseLog:        result.log,
                systemMasterCrypto: result.updated.balance,
                quote: {
                    provider:         rates.provider,
                    source:           rates.source,
                    corporateRate,
                    actualMarketRate,
                    discountRate,
                    fiatGhs:          fiatGhsFloat,
                    usdcAmount,
                    gatewayReference
                },
                metadata: {
                    recipientPhone:   recipientPhone   || null,
                    recipientNetwork: recipientNetwork || null
                }
            }
        });
    } catch (error) {
        // P2002 → unique constraint violation on gatewayReference (replay)
        if (error?.code === 'P2002') {
            return res.status(409).json({
                success: false,
                code:    'CORPORATE_REFERENCE_REPLAY',
                message: 'A corporate purchase with this gatewayReference already exists.'
            });
        }
        console.error('purchaseCorporateViaApi error:', error.message);
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
            console.error('liquidateProfits socket emit failed:', socketErr.message);
        }

        return res.status(200).json({
            success: true,
            message: `Liquidated ${data.amountLiquidated} USDC from SystemProfitFees to SystemFiatPool.`,
            data
        });
    } catch (error) {
        console.error('liquidateProfits error:', error.message);
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
        console.error('logColdStorage error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = { logCorporatePurchase, purchaseCorporateViaApi, liquidateProfits, logColdStorage };
