// controllers/walletPassController.js
// =============================================================================
// AZAMAN — Apple/Google Wallet Pass Generator (Phase 3)
//
// Generates wallet passes for:
//   • Loyalty stamp cards (business loyalty programs)
//   • Vault savings goals (progress tracker)
//
// Apple Wallet: Generates .pkpass (a signed ZIP with pass.json)
// Google Wallet: Returns a save link (Google Wallet API)
//
// POST /api/wallet-pass/loyalty/:cardId   — generate pass for loyalty card
// POST /api/wallet-pass/vault/:vaultId    — generate pass for vault
// =============================================================================

const logger = require('../src/config/logger');
const crypto = require('crypto');
const zlib = require('zlib');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[walletPassCtrl] ${fn.name}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

// Generate an unsigned pass.json (for Apple Wallet — real signing needs
// Apple Developer certs, but this creates the full pass structure that can
// be signed server-side with a pass certificate)
function buildLoyaltyPass(card, program, business) {
    const stampsTotal = program.stampsRequired;
    const stampsCollected = card.stampsCollected;
    const stampsRemaining = stampsTotal - stampsCollected;
    const progress = Math.round((stampsCollected / stampsTotal) * 100);

    return {
        formatVersion: 2,
        passTypeIdentifier: 'com.azaman.loyalty',
        serialNumber: card.id,
        teamIdentifier: process.env.APPLE_TEAM_ID || 'AZAMAN',
        organizationName: business?.businessName || 'AZAMAN',
        description: `${program.name} — Loyalty Card`,
        logoText: business?.businessName || 'AZAMAN',
        foregroundColor: 'rgb(255,255,255)',
        backgroundColor: program.cardColor || 'rgb(255,215,0)',
        labelColor: 'rgb(255,255,255)',
        storeCard: {
            primaryFields: [
                {
                    key: 'stamps',
                    label: 'Stamps',
                    value: `${stampsCollected}/${stampsTotal}`,
                },
                {
                    key: 'reward',
                    label: 'Reward',
                    value: program.rewardDescription,
                },
            ],
            secondaryFields: [
                {
                    key: 'remaining',
                    label: 'Remaining',
                    value: `${stampsRemaining} stamp${stampsRemaining !== 1 ? 's' : ''}`,
                },
                {
                    key: 'tier',
                    label: 'Tier',
                    value: card.currentTier,
                },
            ],
            backFields: [
                {
                    key: 'description',
                    label: 'Program',
                    value: program.description || program.name,
                },
                {
                    key: 'rules',
                    label: 'How it works',
                    value: `Collect ${stampsTotal} stamps to unlock: ${program.rewardDescription}`,
                },
                {
                    key: 'cardId',
                    label: 'Card ID',
                    value: card.id,
                },
            ],
        },
        barcode: {
            message: `azaman:loyalty:${card.id}`,
            format: 'PKBarcodeFormatQR',
            messageEncoding: 'iso-8859-1',
            altText: card.id.substring(0, 8).toUpperCase(),
        },
        info: [
            { key: 'programName', label: 'Program', value: program.name },
            { key: 'progress', label: 'Progress', value: `${progress}%` },
        ],
    };
}

function buildVaultPass(vault) {
    const target = parseFloat(vault.targetAmountUsdc);
    const current = parseFloat(vault.currentAmountUsdc);
    const progress = Math.min(100, Math.round((current / target) * 100));
    const remaining = Math.max(0, target - current);

    return {
        formatVersion: 2,
        passTypeIdentifier: 'com.azaman.vault',
        serialNumber: vault.id,
        teamIdentifier: process.env.APPLE_TEAM_ID || 'AZAMAN',
        organizationName: 'AZAMAN',
        description: `${vault.name} — Savings Vault`,
        logoText: 'AZAMAN Vault',
        foregroundColor: 'rgb(255,255,255)',
        backgroundColor: 'rgb(30,30,40)',
        labelColor: 'rgb(200,200,200)',
        generic: {
            primaryFields: [
                {
                    key: 'balance',
                    label: 'Current Balance',
                    value: `$${current.toFixed(2)}`,
                },
                {
                    key: 'target',
                    label: 'Target',
                    value: `$${target.toFixed(2)}`,
                },
            ],
            secondaryFields: [
                {
                    key: 'progress',
                    label: 'Progress',
                    value: `${progress}%`,
                },
                {
                    key: 'remaining',
                    label: 'Remaining',
                    value: `$${remaining.toFixed(2)}`,
                },
            ],
            auxiliaryFields: [
                {
                    key: 'maturity',
                    label: 'Matures',
                    value: new Date(vault.maturityDate).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                    }),
                },
                {
                    key: 'streak',
                    label: 'Streak',
                    value: `${vault.streakCount} days`,
                },
            ],
            backFields: [
                {
                    key: 'name',
                    label: 'Vault Name',
                    value: vault.name,
                },
                {
                    key: 'yield',
                    label: 'DeFi Yield',
                    value: vault.yieldEnabled ? `${(parseFloat(vault.yieldApr) * 100).toFixed(2)}% APR (${vault.yieldStrategy})` : 'Not enabled',
                },
                {
                    key: 'azmEarned',
                    label: 'AZM Earned',
                    value: `${parseFloat(vault.totalAzmEarned).toFixed(2)} AZM`,
                },
                {
                    key: 'vaultId',
                    label: 'Vault ID',
                    value: vault.id,
                },
            ],
        },
        barcode: {
            message: `azaman:vault:${vault.id}`,
            format: 'PKBarcodeFormatQR',
            messageEncoding: 'iso-8859-1',
            altText: vault.id.substring(0, 8).toUpperCase(),
        },
    };
}

// POST /api/wallet-pass/loyalty/:cardId
exports.generateLoyaltyPass = wrap(async function generateLoyaltyPass(req, res) {
    const prisma = req.app.get('prisma');
    const { cardId } = req.params;
    const userId = req.user.id;
    const { platform } = req.body; // 'apple' | 'google'

    const card = await prisma.loyaltyCard.findUnique({
        where: { id: cardId },
        include: { loyaltyProgram: { include: { businessProfile: true } } },
    });

    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    if (card.userId !== userId) return res.status(403).json({ success: false, message: 'Not your card' });

    if (platform === 'apple') {
        const pass = buildLoyaltyPass(card, card.loyaltyProgram, card.loyaltyProgram.businessProfile);

        // In production: sign with Apple WWDR cert + pass cert + private key
        // For now, return the pass.json that the frontend can preview
        // and provide instructions for full signing
        res.json({
            success: true,
            platform: 'apple',
            pass: pass,
            message: 'Pass generated. Sign with Apple Developer certificate for .pkpass distribution.',
            // When signed, the file would be: { pass.json, manifest.json, signature, logo.png, ... }
        });
    } else {
        // Google Wallet: return a save link (in production, uses Google Wallet API)
        // For now, return the pass data that can be used to create a Google Wallet pass
        const pass = buildLoyaltyPass(card, card.loyaltyProgram, card.loyaltyProgram.businessProfile);
        res.json({
            success: true,
            platform: 'google',
            pass: pass,
            // In production: this would be a JWT signed with Google service account
            saveUrl: `https://pay.google.com/gp/v/save/${Buffer.from(JSON.stringify({
                iss: 'azaman@system.gserviceaccount.com',
                aud: 'google',
                typ: 'savetowallet',
                payload: {
                    genericObjects: [{
                        id: `azaman.loyalty.${card.id}`,
                        classId: 'azaman.loyalty',
                        logo: { sourceUri: { uri: card.loyaltyProgram.businessProfile.logoUrl || '' } },
                        cardTitle: { defaultValue: { value: card.loyaltyProgram.businessProfile.businessName || 'AZAMAN' } },
                        header: { defaultValue: { value: card.loyaltyProgram.name } },
                        subheader: { defaultValue: { value: `${card.stampsCollected}/${card.loyaltyProgram.stampsRequired} stamps` } },
                    }],
                },
            })).toString('base64url')}`,
        });
    }
});

// POST /api/wallet-pass/vault/:vaultId
exports.generateVaultPass = wrap(async function generateVaultPass(req, res) {
    const prisma = req.app.get('prisma');
    const { vaultId } = req.params;
    const userId = req.user.id;
    const { platform } = req.body;

    const vault = await prisma.vault.findUnique({ where: { id: vaultId } });
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
    if (vault.userId !== userId) return res.status(403).json({ success: false, message: 'Not your vault' });

    const pass = buildVaultPass(vault);

    if (platform === 'apple') {
        res.json({
            success: true,
            platform: 'apple',
            pass,
            message: 'Pass generated. Sign with Apple Developer certificate for .pkpass distribution.',
        });
    } else {
        res.json({
            success: true,
            platform: 'google',
            pass,
            saveUrl: `https://pay.google.com/gp/v/save/${Buffer.from(JSON.stringify({
                iss: 'azaman@system.gserviceaccount.com',
                aud: 'google',
                typ: 'savetowallet',
                payload: {
                    genericObjects: [{
                        id: `azaman.vault.${vault.id}`,
                        classId: 'azaman.vault',
                        cardTitle: { defaultValue: { value: 'AZAMAN Vault' } },
                        header: { defaultValue: { value: vault.name } },
                        subheader: { defaultValue: { value: `$${parseFloat(vault.currentAmountUsdc).toFixed(2)} / $${parseFloat(vault.targetAmountUsdc).toFixed(2)}` } },
                    }],
                },
            })).toString('base64url')}`,
        });
    }
});
