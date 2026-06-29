// controllers/userPreferencesController.js
// =============================================================================
// AZAMAN V3 — USER PREFERENCES CONTROLLER
//
// Manages user-specific preferences that sync across devices:
//   - Theme selection (Mars, Saturn, Snow, Neon Tokyo, Deep Ocean, etc.)
//   - Custom shortcuts (HQ drawer shortcut arrangement)
//   - General settings preferences (haptics, sounds, etc.)
//
// Endpoints:
//   GET  /api/users/preferences            — Get all user preferences
//   PUT  /api/users/preferences/theme      — Update selected theme
//   PUT  /api/users/preferences/shortcuts  — Update custom shortcuts
//   PUT  /api/users/preferences            — Update all preferences at once
// =============================================================================

// Valid theme identifiers
const VALID_THEMES = [
    'light', 'dark', 'cyberBlue', 'midnightPurple',
    'mars', 'saturn', 'snow', 'neonTokyo',
    'deepOcean', 'volcanic', 'aurora'
];

// Default shortcuts available in the app
const AVAILABLE_SHORTCUTS = [
    'deposit', 'withdraw', 'history', 'stats',
    'p2p', 'savings', 'support', 'ads',
    'settings', 'security', 'kyc', 'friends',
    'notifications', 'vendorPortal', 'warRoom', 'wallet'
];


// =============================================================================
// 1. GET ALL PREFERENCES
//    GET /api/users/preferences
// =============================================================================
exports.getPreferences = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                selectedTheme: true,
                customShortcuts: true,
                settingsPreferences: true
            }
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({
            success: true,
            data: {
                theme: user.selectedTheme || 'dark',
                shortcuts: user.customShortcuts || _defaultShortcuts(),
                preferences: user.settingsPreferences || _defaultPreferences(),
                availableThemes: VALID_THEMES,
                availableShortcuts: AVAILABLE_SHORTCUTS
            }
        });

    } catch (error) {
        console.error('[userPreferences.getPreferences] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. UPDATE THEME
//    PUT /api/users/preferences/theme
//    Body: { theme: 'mars' | 'saturn' | 'snow' | ... }
// =============================================================================
exports.updateTheme = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { theme } = req.body;

        if (!theme || !VALID_THEMES.includes(theme)) {
            return res.status(400).json({
                success: false,
                message: `Invalid theme. Must be one of: ${VALID_THEMES.join(', ')}`,
                validThemes: VALID_THEMES
            });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { selectedTheme: theme }
        });

        return res.status(200).json({
            success: true,
            message: `Theme updated to "${theme}".`,
            data: { theme }
        });

    } catch (error) {
        console.error('[userPreferences.updateTheme] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. UPDATE SHORTCUTS
//    PUT /api/users/preferences/shortcuts
//    Body: { shortcuts: [ { id, enabled, order }, ... ] }
//
//    Each shortcut object:
//      - id: string (must be from AVAILABLE_SHORTCUTS)
//      - enabled: boolean (whether to show in drawer)
//      - order: number (display order, 0-indexed)
// =============================================================================
exports.updateShortcuts = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { shortcuts } = req.body;

        if (!shortcuts || !Array.isArray(shortcuts)) {
            return res.status(400).json({
                success: false,
                message: 'shortcuts must be an array of { id, enabled, order } objects.'
            });
        }

        // Validate each shortcut ID
        const invalidIds = shortcuts
            .filter(s => !AVAILABLE_SHORTCUTS.includes(s.id))
            .map(s => s.id);

        if (invalidIds.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Invalid shortcut IDs: ${invalidIds.join(', ')}`,
                availableShortcuts: AVAILABLE_SHORTCUTS
            });
        }

        // Sanitize and store
        const sanitized = shortcuts.map((s, i) => ({
            id: s.id,
            enabled: s.enabled !== false, // default true
            order: typeof s.order === 'number' ? s.order : i
        }));

        await prisma.user.update({
            where: { id: userId },
            data: { customShortcuts: sanitized }
        });

        return res.status(200).json({
            success: true,
            message: 'Shortcuts updated.',
            data: { shortcuts: sanitized }
        });

    } catch (error) {
        console.error('[userPreferences.updateShortcuts] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. UPDATE ALL PREFERENCES
//    PUT /api/users/preferences
//    Body: { theme?, shortcuts?, preferences? }
//
//    Batch update — only provided fields are updated.
// =============================================================================
exports.updateAll = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { theme, shortcuts, preferences } = req.body;

        const updateData = {};

        // Theme validation
        if (theme !== undefined) {
            if (!VALID_THEMES.includes(theme)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid theme. Must be one of: ${VALID_THEMES.join(', ')}`
                });
            }
            updateData.selectedTheme = theme;
        }

        // Shortcuts validation
        if (shortcuts !== undefined) {
            if (!Array.isArray(shortcuts)) {
                return res.status(400).json({
                    success: false,
                    message: 'shortcuts must be an array.'
                });
            }
            const invalidIds = shortcuts
                .filter(s => !AVAILABLE_SHORTCUTS.includes(s.id))
                .map(s => s.id);
            if (invalidIds.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid shortcut IDs: ${invalidIds.join(', ')}`
                });
            }
            updateData.customShortcuts = shortcuts.map((s, i) => ({
                id: s.id,
                enabled: s.enabled !== false,
                order: typeof s.order === 'number' ? s.order : i
            }));
        }

        // General preferences (freeform JSON)
        if (preferences !== undefined) {
            if (typeof preferences !== 'object' || Array.isArray(preferences)) {
                return res.status(400).json({
                    success: false,
                    message: 'preferences must be an object.'
                });
            }
            updateData.settingsPreferences = preferences;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields provided to update.'
            });
        }

        await prisma.user.update({
            where: { id: userId },
            data: updateData
        });

        return res.status(200).json({
            success: true,
            message: 'Preferences updated.',
            data: updateData
        });

    } catch (error) {
        console.error('[userPreferences.updateAll] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. UPDATE PREFERRED CURRENCY
//    PATCH /api/users/preferences/currency
//    Body: { currency: 'USD' | 'GHS' | 'NGN' | 'KES' | ... }
// =============================================================================
exports.updatePreferredCurrency = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { currency } = req.body;

        if (!currency || typeof currency !== 'string' || currency.trim().length === 0) {
            return res.status(400).json({ success: false, message: 'currency is required.' });
        }

        const code = currency.trim().toUpperCase();
        if (code.length > 8) {
            return res.status(400).json({ success: false, message: 'Currency code too long (max 8 chars).' });
        }

        await prisma.user.update({
            where: { id: userId },
            data: { preferredCurrency: code }
        });

        // Broadcast preference change so other sessions pick it up
        try {
            const io = req.app.get('socketio');
            if (io) {
                io.to(`user_${userId}`).emit('preferences_updated', {
                    type: 'CURRENCY',
                    preferredCurrency: code
                });
            }
        } catch (_) { /* non-fatal */ }

        return res.status(200).json({
            success: true,
            message: `Preferred currency updated to "${code}".`,
            data: { preferredCurrency: code }
        });
    } catch (error) {
        console.error('[userPreferences.updatePreferredCurrency] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function _defaultShortcuts() {
    return [
        { id: 'deposit', enabled: true, order: 0 },
        { id: 'withdraw', enabled: true, order: 1 },
        { id: 'history', enabled: true, order: 2 },
        { id: 'stats', enabled: true, order: 3 },
        { id: 'p2p', enabled: true, order: 4 },
        { id: 'friends', enabled: true, order: 5 },
        { id: 'settings', enabled: true, order: 6 },
        { id: 'support', enabled: true, order: 7 }
    ];
}

function _defaultPreferences() {
    return {
        hapticFeedback: true,
        soundEffects: true,
        animationIntensity: 'normal', // 'reduced' | 'normal' | 'high'
        currencyDisplay: 'USD',
        language: 'English',
        biometricLock: false,
        showBalances: true,
        compactMode: false
    };
}
