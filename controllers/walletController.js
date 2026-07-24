// controllers/walletController.js

/**
const logger = require('../src/config/logger');
 * 1. REQUEST WITHDRAWAL (The Address Detective)
 */
exports.requestWithdrawal = async (req, res) => {
    const prisma = req.app.get('prisma');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    
    try {
        // We now look for 'destination' (which handles IDs, Wallets, and Phone Numbers)
        const { amount, destination, networkPref } = req.body;
        const userId = req.user.id;
        const withdrawAmount = parseFloat(amount);

        // 1. Basic Validation
        if (!withdrawAmount || withdrawAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid amount." });
        }
        if (!destination) {
            return res.status(400).json({ success: false, message: "Destination address or number is required." });
        }

        // 2. Fetch Global Settings for Live Gas Prices
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) throw new Error("Global settings offline.");

        // --- Phase ADMIN-CONTROL-2 FIX 2: Read crypto platform fee ---
        const cryptoPlatformFeePct = Number(settings?.cryptoPlatformFeePct ?? 0);
        const platformFeeUsdc = parseFloat((withdrawAmount * cryptoPlatformFeePct).toFixed(6));
        const netAfterPlatformFee = withdrawAmount - platformFeeUsdc;

        // --- THE BACKEND DETECTIVE ---
        let payoutMethod = "UNKNOWN";
        let detectedNetwork = networkPref || "UNKNOWN";
        let totalGasFee = 0.0;

        const cleanDest = destination.trim();
        const isNumeric = /^\d+$/.test(cleanDest);

        if (isNumeric && cleanDest.length >= 8 && cleanDest.length <= 12) {
            // 8 to 12 digits is the standard length of a Binance Pay ID
            payoutMethod = "BINANCE_ID";
            detectedNetwork = "BINANCE_PAY";
            totalGasFee = 0.0; // ZERO FEES!
        } 
        else if (cleanDest.startsWith('T') && cleanDest.length === 34) {
            // Tron (TRC20) addresses always start with 'T' and are 34 chars long
            payoutMethod = "EXTERNAL_WALLET";
            detectedNetwork = "TRC20";
            totalGasFee = settings.gasFeeTrc20;
        } 
        else if (cleanDest.startsWith('0x') && cleanDest.length === 42) {
            // Ethereum (ERC20) or Binance Smart Chain (BEP20)
            payoutMethod = "EXTERNAL_WALLET";
            detectedNetwork = networkPref || "BEP20"; // Default to cheaper BEP20 if not specified
            totalGasFee = detectedNetwork === "ERC20" ? settings.gasFeeErc20 : settings.gasFeeBep20;
        } 
        else if (isNumeric && cleanDest.length >= 9) {
            // Looks like an MTN/Telecel phone number
            payoutMethod = "MOMO";
            detectedNetwork = networkPref || "MTN";
            totalGasFee = 0.0; 
        }

        // Calculate the 50/50 Split!
        const vendorGasShare = totalGasFee / 2;
        const adminGasShare = totalGasFee / 2;

        // 3. Execute the Transaction
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId } });
            
            // Note: We deduct the requested amount. The gas fee is subtracted from 
            // what they actually receive on the blockchain side later.
            if (user.availableBalance < withdrawAmount) {
                throw new Error("Insufficient balance.");
            }

            // Deduct from available balance (Phase D-2: AZM eliminated)
            await tx.user.update({
                where: { id: userId },
                data: { availableBalance: { decrement: withdrawAmount } }
            });

            // --- Phase ADMIN-CONTROL-2 FIX 2: Credit platform fee ---
            if (platformFeeUsdc > 0) {
                await tx.systemProfitFees.upsert({
                    where: { id: 1 },
                    update: { balance: { increment: platformFeeUsdc } },
                    create: { id: 1, balance: platformFeeUsdc }
                });
                await tx.adminProfitLog.create({
                    data: {
                        amountUsdc: platformFeeUsdc,
                        source: 'CRYPTO_WITHDRAWAL_FEE',
                        relatedTxId: `crypto_pfee_${userId}_${Date.now()}`
                    }
                });
            }

            // Create the heavily detailed withdrawal ticket
            const withdrawal = await tx.withdrawal.create({
                data: {
                    userId: userId,
                    amount: withdrawAmount,
                    payoutMethod: payoutMethod,
                    network: detectedNetwork,
                    destination: cleanDest,
                    totalGasFee: totalGasFee,
                    vendorGasShare: vendorGasShare,
                    adminGasShare: adminGasShare,
                    platformFeeUsdc: platformFeeUsdc,
                    status: "PENDING"
                }
            });

            return withdrawal;
        });

        res.status(200).json({ 
            success: true, 
            message: payoutMethod === "BINANCE_ID" 
                ? "Zero-fee Binance withdrawal initiated!" 
                : "Withdrawal initiated. 50% of gas fees have been subsidized.",
            withdrawal: result
        });

        // Emit balance update after successful withdrawal
        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

/**
 * 2. GET WITHDRAWAL HISTORY
 */
exports.getWithdrawalHistory = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const history = await prisma.withdrawal.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ success: true, history });
    } catch (error) {
        res.status(500).json({ success: false, message: "Could not fetch history." });
    }
};

/**
 * 3. SAVE A NEW PAYOUT WALLET / FIAT ACCOUNT (The Dual Detective)
 */
exports.addSavedWallet = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        // We now extract the 'type' and the new Fiat fields sent from Flutter
        const { type, label, address, accountName, secondaryDetail, password, totpToken } = req.body;
        const userId = req.user.id;

        if (!label || !address) {
            return res.status(400).json({ success: false, message: "Label and address are required." });
        }

        // ── Master Sprint v2 (2026-05-27): Security gate ──
        // Saving a payout destination requires re-confirming the user's
        // password OR a 2FA token if 2FA is enabled. Prevents an attacker
        // who has access to a logged-in session from quietly seeding a
        // withdrawal address.
        const bcrypt = require('bcryptjs');
        const speakeasy = require('speakeasy');
        const userRow = await prisma.user.findUnique({
            where: { id: userId },
            select: { password: true, isTwoFactorEnabled: true, twoFactorSecret: true },
        });
        if (!userRow) return res.status(401).json({ success: false, message: 'Auth failed.' });
        if (userRow.isTwoFactorEnabled) {
            if (!totpToken) {
                return res.status(401).json({
                    success: false, code: '2FA_REQUIRED',
                    message: 'Two-factor token required to save a payout address.',
                });
            }
            const ok = speakeasy.totp.verify({
                secret: userRow.twoFactorSecret,
                encoding: 'base32',
                token: totpToken,
                window: 1,
            });
            if (!ok) return res.status(401).json({ success: false, message: 'Invalid 2FA token.' });
        } else {
            if (!password) {
                return res.status(401).json({
                    success: false, code: 'PASSWORD_REQUIRED',
                    message: 'Password required to save a payout address.',
                });
            }
            const matches = await bcrypt.compare(password, userRow.password);
            if (!matches) return res.status(401).json({ success: false, message: 'Invalid password.' });
        }

        // Phase UI Sprint (2026-05-26): SavedWallet is exclusively for
        // PAYOUT destinations — local mobile money (MTN, Telecel,
        // AirtelTigo / Telecel) and crypto wallets. Global-fiat
        // handles (CashApp, Zelle, Venmo, PayPal, Apple Pay, Bank
        // Transfer) belong to the vendor's TradeAccount, not here.
        // Reject those types up-front so the legacy combined UI
        // can't re-introduce the bug.
        const fiatTradeAccountTypes = new Set([
            'CASHAPP', 'ZELLE', 'VENMO', 'PAYPAL', 'APPLE_PAY', 'APPLE PAY',
            'GOOGLE_PAY', 'GOOGLE PAY', 'WISE', 'REVOLUT', 'GIFT_CARD', 'GIFT CARD',
            'WESTERN_UNION', 'WESTERN UNION', 'WIRE_TRANSFER', 'WIRE TRANSFER',
            'BANK TRANSFER', 'BANK_TRANSFER',
        ]);
        const requestedType = (type || '').toString().trim().toUpperCase();
        if (fiatTradeAccountTypes.has(requestedType)) {
            return res.status(400).json({
                success: false,
                code: 'WRONG_SURFACE',
                message:
                    `${type} is a global-fiat trade account. Save it under ` +
                    `Settings → Trade Accounts (vendor area), not Withdrawal Addresses.`
            });
        }

        let provider = type || "UNKNOWN";
        let network = "UNKNOWN";
        const cleanAddress = address.trim();

        // --- THE DUAL DETECTIVE ---
        // Branches recognise:
        //   • Mobile money networks (MTN_MOMO, VODAFONE_CASH, AIRTELTIGO,
        //     TELECEL_CASH) → store as-is, network = the network code.
        //   • "Crypto Wallet" or no type → run length/format checks to
        //     identify Binance Pay ID, TRC20, ERC20.
        //   • Fiat trade accounts were rejected earlier in this handler.
        const mobileMoneyNetworks = new Set([
            'MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH', 'AIRTELTIGO'
        ]);
        if (mobileMoneyNetworks.has(requestedType)) {
            provider = type;
            network  = requestedType;
        } else if (type === "Crypto Wallet" || !type) {
            // It's a Crypto address, run the strict length checks
            const isNumeric = /^\d+$/.test(cleanAddress);

            if (isNumeric && cleanAddress.length >= 8 && cleanAddress.length <= 12) {
                provider = "BINANCE PAY";
                network = "BINANCE_ID";
            }
            else if (cleanAddress.startsWith('T') && cleanAddress.length === 34) {
                provider = "EXTERNAL WALLET";
                network = "TRC20";
            }
            else if (cleanAddress.startsWith('0x') && cleanAddress.length === 42) {
                provider = "EXTERNAL WALLET";
                network = "ERC20_BEP20";
            }
            else {
                return res.status(400).json({ success: false, message: "Invalid wallet address format. Cannot detect network." });
            }
        } else {
            // Unknown / disallowed type — be strict so this surface stays
            // exclusively payout-destinations.
            return res.status(400).json({
                success: false,
                code: 'UNSUPPORTED_TYPE',
                message: `Unsupported payout type "${type}". Use mobile money or a crypto wallet.`,
            });
        }

        // Save to Database
        const newWallet = await prisma.savedWallet.create({
            data: {
                label: label,
                address: cleanAddress,
                provider: provider,
                network: network,
                accountName: accountName || null,
                secondaryDetail: secondaryDetail || null,
                userId: userId
            }
        });

        res.status(201).json({ success: true, wallet: newWallet, message: "Account verified and saved!" });
    } catch (error) {
        logger.error("Save Wallet Error:", error);
        res.status(500).json({ success: false, message: "Server error saving account." });
    }
};

/**
 * 4. GET SAVED WALLETS
 */
exports.getSavedWallets = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const wallets = await prisma.savedWallet.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ success: true, wallets });
    } catch (error) {
        res.status(500).json({ success: false, message: "Could not fetch wallets." });
    }
};

/**
 * 5. DELETE A SAVED WALLET / PAYMENT METHOD
 * Only the owning user can delete their own saved wallet.
 */
exports.deleteSavedWallet = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const walletId = parseInt(req.params.id, 10);
        if (isNaN(walletId)) {
            return res.status(400).json({ success: false, message: "Invalid wallet id." });
        }

        const existing = await prisma.savedWallet.findUnique({ where: { id: walletId } });
        if (!existing) {
            return res.status(404).json({ success: false, message: "Wallet not found." });
        }
        if (existing.userId !== req.user.id) {
            return res.status(403).json({ success: false, message: "Not authorised." });
        }

        await prisma.savedWallet.delete({ where: { id: walletId } });
        res.status(200).json({ success: true, message: "Payment method removed." });
    } catch (error) {
        logger.error("Delete Wallet Error:", error);
        res.status(500).json({ success: false, message: "Server error deleting wallet." });
    }
};

/**
 * 6. INITIALIZE FIAT DEPOSIT
 */
exports.initializeFiatDeposit = async (req, res) => {
  try {
    const { amount, currency = 'GHS', method } = req.body;
    const userId = req.user.id;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!['MOBILE_MONEY', 'BANK_TRANSFER'].includes(method)) {
      return res.status(400).json({ error: 'Unsupported deposit method' });
    }

    const reference = `AZM-DEP-${Date.now()}-${userId}`;

    return res.json({
      status: 'PENDING',
      reference,
      amount: Number(amount),
      currency,
      method,
      instructions: method === 'MOBILE_MONEY'
        ? {
            network: 'MTN',
            shortCode: '*170#',
            merchantCode: '123456',
            note: `Use ${reference} as payment narration.`,
          }
        : {
            bankName: 'Fidelity Bank',
            accountName: 'Azaman Protocol Escrow',
            accountNumber: '1050000123456',
            note: `Use ${reference} as transfer narration.`,
          },
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    logger.error('initializeFiatDeposit error', e);
    return res.status(500).json({ error: 'Failed to initialize deposit' });
  }
};


// =============================================================================
// 7. GET POLYGON DEPOSIT ADDRESS  (Phase C: Tatum Integration)
//
// Derives (or returns cached) the user's unique Polygon USDC deposit address
// from the platform's HD wallet xpub using the user's ID as the derivation
// index. On first call the address is persisted to User.tatumPolygonAddress
// and a Tatum webhook subscription is registered for the address.
//
// GET /api/wallet/deposit-address/polygon  (auth)
// Returns: { address, derivationIndex, source, isNew }
// =============================================================================
exports.getPolygonDepositAddress = async (req, res) => {
    const prisma       = req.app.get('prisma');
    const tatumService = req.app.get('tatumService');

    try {
        const userId = req.user.id;

        if (!tatumService) {
            return res.status(503).json({
                success: false,
                message: 'Tatum Web3 service is not configured on this server.'
            });
        }

        // ── Check if address already persisted ───────────────────────────────
        const user = await prisma.user.findUnique({
            where:  { id: userId },
            select: { tatumPolygonAddress: true }
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (user.tatumPolygonAddress) {
            return res.status(200).json({
                success: true,
                message: 'Polygon deposit address retrieved.',
                data: {
                    address:          user.tatumPolygonAddress,
                    derivationIndex:  userId,
                    source:           tatumService.providerMode,
                    isNew:            false,
                    network:          'Polygon (MATIC)',
                    token:            'USDC',
                    warning:          'Only send USDC on the Polygon network to this address. Sending other tokens or using other networks will result in permanent loss.'
                }
            });
        }

        // ── Derive a new address ─────────────────────────────────────────────
        const derivation = await tatumService.deriveDepositAddress(userId);

        // Persist to User record (lowercase for consistent lookups)
        const normalizedAddress = derivation.address.toLowerCase();
        await prisma.user.update({
            where: { id: userId },
            data:  { tatumPolygonAddress: normalizedAddress }
        });

        // Best-effort: subscribe the address to Tatum webhooks
        let subscription = null;
        try {
            subscription = await tatumService.subscribeAddress(normalizedAddress);
        } catch (subErr) {
            logger.error({ err: subErr }, '[getPolygonDepositAddress] Subscription failed (non-fatal)');
        }

        return res.status(201).json({
            success: true,
            message: 'Polygon deposit address generated and saved.',
            data: {
                address:          normalizedAddress,
                derivationIndex:  derivation.derivationIndex,
                source:           derivation.source,
                isNew:            true,
                subscriptionId:   subscription?.subscriptionId || null,
                network:          'Polygon (MATIC)',
                token:            'USDC',
                warning:          'Only send USDC on the Polygon network to this address. Sending other tokens or using other networks will result in permanent loss.'
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[getPolygonDepositAddress] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
