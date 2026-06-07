// controllers/profileController.js
// =============================================================================
// AZAMAN V4 — PROFILE CONTROLLER
//
// Comprehensive user profile management:
//   GET  /api/users/profile         — Get full user profile
//   PUT  /api/users/profile         — Update profile fields
//   GET  /api/users/balance         — Get current balances (REST fallback)
//   GET  /api/users/onboarding      — Get onboarding status
//   PUT  /api/users/onboarding      — Update onboarding progress
//   POST /api/users/onboarding/complete — Mark onboarding as completed
//   GET  /api/users/dashboard       — Home screen dashboard data (hologram widget)
// =============================================================================

// =============================================================================
// 1. GET FULL PROFILE
//    GET /api/users/profile
//    Returns comprehensive user data for standalone profile screen
// =============================================================================
exports.getProfile = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                username: true,
                email: true,
                displayName: true,
                bio: true,
                phoneNumber: true,
                country: true,
                role: true,
                profilePictureUrl: true,
                kycStatus: true,
                influencerCode: true,
                referredByCode: true,
                // PHASE 6: Azaman ID + discoverability
                azamanId: true,
                discoverable: true,
                phoneVerified: true,

                // Balances
                availableBalance: true,
                vendorUnallocatedBalance: true,
                escrowLockedBalance: true,
                disputeEscrowBalance: true,
                azmBalance: true,

                // Stats
                tradesCompleted: true,
                completionRate: true,
                positiveReviews: true,
                negativeReviews: true,

                // Vendor
                vendorXp: true,
                vendorLevel: true,
                currentStreak: true,
                longestStreak: true,
                totalVolumeUsdc: true,
                totalProfitUsdc: true,

                // Loyalty
                loyaltyTier: true,
                activeDiscountCredit: true,
                discountExpiresAt: true,

                // Onboarding
                onboardingCompleted: true,
                onboardingStep: true,

                // Preferences
                selectedTheme: true,
                customShortcuts: true,
                settingsPreferences: true,

                // Security
                isTwoFactorEnabled: true,
                banStatus: true,
                loginStreak: true,
                lastLoginAt: true,

                // Meta
                createdAt: true,

                // Relations count
                _count: {
                    select: {
                        ads: true,
                        tradesAsBuyer: true,
                        tradesAsVendor: true,
                        sentFriendRequests: true,
                        receivedFriendRequests: true,
                        savingsGoals: true,
                        notifications: { where: { isRead: false } }
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Compute derived fields
        const totalReviews = user.positiveReviews + user.negativeReviews;
        const rating = totalReviews > 0
            ? parseFloat(((user.positiveReviews / totalReviews) * 5).toFixed(1))
            : 0;

        return res.status(200).json({
            success: true,
            data: {
                ...user,
                rating,
                totalReviews,
                totalBalance: user.availableBalance + user.vendorUnallocatedBalance,
                unreadNotifications: user._count.notifications,
                totalFriends: user._count.sentFriendRequests + user._count.receivedFriendRequests,
                memberSince: user.createdAt,
                _count: undefined // Remove raw count from response
            }
        });

    } catch (error) {
        console.error('[profile.getProfile] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 2. UPDATE PROFILE
//    PUT /api/users/profile
//    Body: { displayName?, bio?, phoneNumber?, country?, profilePictureUrl? }
// =============================================================================
exports.updateProfile = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { displayName, bio, phoneNumber, country, profilePictureUrl, fcmToken } = req.body;

        const updateData = {};

        if (displayName !== undefined) {
            if (typeof displayName !== 'string' || displayName.length > 50) {
                return res.status(400).json({
                    success: false,
                    message: 'displayName must be a string of 50 characters or fewer.'
                });
            }
            updateData.displayName = displayName.trim() || null;
        }

        if (bio !== undefined) {
            if (typeof bio !== 'string' || bio.length > 200) {
                return res.status(400).json({
                    success: false,
                    message: 'bio must be a string of 200 characters or fewer.'
                });
            }
            updateData.bio = bio.trim() || null;
        }

        if (phoneNumber !== undefined) {
            if (phoneNumber !== null && (typeof phoneNumber !== 'string' || phoneNumber.length > 20)) {
                return res.status(400).json({
                    success: false,
                    message: 'phoneNumber must be a valid string of 20 characters or fewer.'
                });
            }
            updateData.phoneNumber = phoneNumber ? phoneNumber.trim() : null;
            // PHASE 6: changing the number here (outside the OTP flow) must
            // drop verification + the discovery hash, so Contact_Discovery
            // never matches an unverified/stale number. Re-verify via OTP to
            // re-enable discoverability.
            updateData.phoneVerified = false;
            updateData.phoneHash = null;
        }

        if (country !== undefined) {
            if (typeof country !== 'string' || country.length > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'country must be a valid country code (2-5 chars).'
                });
            }
            updateData.country = country.trim().toUpperCase();
        }

        if (profilePictureUrl !== undefined) {
            updateData.profilePictureUrl = profilePictureUrl || null;
        }

        if (fcmToken !== undefined) {
            updateData.fcmToken = fcmToken || null;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields provided to update.'
            });
        }

        const updated = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                username: true,
                displayName: true,
                bio: true,
                phoneNumber: true,
                country: true,
                profilePictureUrl: true,
                fcmToken: true
            }
        });

        return res.status(200).json({
            success: true,
            message: 'Profile updated.',
            data: updated
        });

    } catch (error) {
        console.error('[profile.updateProfile] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 3. GET BALANCE (REST fallback for when socket is unavailable)
//    GET /api/users/balance
// =============================================================================
exports.getBalance = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                availableBalance: true,
                vendorUnallocatedBalance: true,
                escrowLockedBalance: true,
                disputeEscrowBalance: true,
                azmBalance: true
            }
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({
            success: true,
            data: {
                ...user,
                totalBalance: user.availableBalance + user.vendorUnallocatedBalance,
                currency: 'USDC',
                lastUpdated: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('[profile.getBalance] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 4. GET ONBOARDING STATUS
//    GET /api/users/onboarding
// =============================================================================
exports.getOnboarding = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                onboardingCompleted: true,
                onboardingStep: true,
                createdAt: true
            }
        });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({
            success: true,
            data: {
                completed: user.onboardingCompleted,
                currentStep: user.onboardingStep,
                totalSteps: 3,
                steps: [
                    { step: 1, title: 'Welcome to Azaman', description: 'Learn about P2P trading', completed: user.onboardingStep >= 1 },
                    { step: 2, title: 'Secure Your Account', description: 'Set up 2FA and PIN', completed: user.onboardingStep >= 2 },
                    { step: 3, title: 'Make Your First Trade', description: 'Fund your wallet and start trading', completed: user.onboardingStep >= 3 }
                ],
                accountAge: Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24))
            }
        });

    } catch (error) {
        console.error('[profile.getOnboarding] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 5. UPDATE ONBOARDING PROGRESS
//    PUT /api/users/onboarding
//    Body: { step: number }
// =============================================================================
exports.updateOnboarding = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { step } = req.body;

        if (typeof step !== 'number' || step < 0 || step > 3) {
            return res.status(400).json({
                success: false,
                message: 'step must be a number between 0 and 3.'
            });
        }

        const updateData = { onboardingStep: step };

        // If all 3 steps are done, mark onboarding as completed
        if (step >= 3) {
            updateData.onboardingCompleted = true;
        }

        await prisma.user.update({
            where: { id: userId },
            data: updateData
        });

        return res.status(200).json({
            success: true,
            message: step >= 3 ? 'Onboarding completed!' : `Step ${step} completed.`,
            data: {
                currentStep: step,
                completed: step >= 3
            }
        });

    } catch (error) {
        console.error('[profile.updateOnboarding] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 6. COMPLETE ONBOARDING
//    POST /api/users/onboarding/complete
// =============================================================================
exports.completeOnboarding = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        await prisma.user.update({
            where: { id: userId },
            data: {
                onboardingCompleted: true,
                onboardingStep: 3
            }
        });

        return res.status(200).json({
            success: true,
            message: 'Onboarding marked as completed.',
            data: { completed: true, currentStep: 3 }
        });

    } catch (error) {
        console.error('[profile.completeOnboarding] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};


// =============================================================================
// 7. DASHBOARD DATA (Home screen — Hologram balance widget + quick stats)
//    GET /api/users/dashboard
//    Returns everything the home screen needs in a single call
// =============================================================================
exports.getDashboard = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;

        const [user, activeTrades, recentTransactions, settings, activeSavings] = await Promise.all([
            // Full user data
            prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    username: true,
                    displayName: true,
                    profilePictureUrl: true,
                    role: true,
                    availableBalance: true,
                    vendorUnallocatedBalance: true,
                    escrowLockedBalance: true,
                    azmBalance: true,
                    tradesCompleted: true,
                    vendorLevel: true,
                    vendorXp: true,
                    currentStreak: true,
                    loyaltyTier: true,
                    loginStreak: true,
                    onboardingCompleted: true,
                    selectedTheme: true,
                    kycStatus: true,
                    _count: {
                        select: {
                            notifications: { where: { isRead: false } }
                        }
                    }
                }
            }),

            // Active trades count
            prisma.trade.count({
                where: {
                    OR: [
                        { userId, status: { in: ['PENDING', 'PENDING_PAYMENT', 'PAID'] } },
                        { vendorId: userId, status: { in: ['PENDING', 'PENDING_PAYMENT', 'PAID'] } }
                    ]
                }
            }),

            // Recent 5 transactions
            prisma.transactionHistory.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: {
                    id: true,
                    type: true,
                    amountUsdc: true,
                    status: true,
                    createdAt: true
                }
            }),

            // Live rates
            prisma.globalSettings.findUnique({
                where: { id: 1 },
                select: {
                    liveUsdToGhs: true,
                    liveRetailRate: true,
                    liveCorporateRate: true,
                    liveRateSource: true,
                    lastRateSync: true
                }
            }),

            // Active savings goals
            prisma.savingsGoal.findMany({
                where: { userId, status: 'ACTIVE' },
                select: {
                    id: true,
                    name: true,
                    targetAmountGhs: true,
                    currentAmountGhs: true,
                    streakCount: true,
                    frequency: true,
                    nextDueDate: true
                },
                take: 3
            })
        ]);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({
            success: true,
            data: {
                // User summary
                user: {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    profilePictureUrl: user.profilePictureUrl,
                    role: user.role,
                    vendorLevel: user.vendorLevel,
                    vendorXp: user.vendorXp,
                    loyaltyTier: user.loyaltyTier,
                    loginStreak: user.loginStreak,
                    kycStatus: user.kycStatus,
                    onboardingCompleted: user.onboardingCompleted,
                    selectedTheme: user.selectedTheme
                },

                // Hologram balance widget
                balances: {
                    available: user.availableBalance,
                    vendorUnallocated: user.vendorUnallocatedBalance,
                    escrowLocked: user.escrowLockedBalance,
                    total: user.availableBalance + user.vendorUnallocatedBalance,
                    currency: 'USDC'
                },

                // Quick stats
                stats: {
                    tradesCompleted: user.tradesCompleted,
                    activeTrades,
                    currentStreak: user.currentStreak,
                    unreadNotifications: user._count.notifications
                },

                // Live rates
                rates: settings || {
                    liveUsdToGhs: 12.50,
                    liveRetailRate: 12.50,
                    liveCorporateRate: 12.30,
                    liveRateSource: 'MOCK',
                    lastRateSync: null
                },

                // Recent activity
                recentTransactions,

                // Savings snapshot
                activeSavings
            }
        });

    } catch (error) {
        console.error('[profile.getDashboard] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};



// =============================================================================
// 8. UPLOAD AVATAR (Phase K)
//    POST /api/users/profile/avatar  (multipart/form-data; field name: avatar)
//
// Replaces the de-facto avatar-upload-via-/uploads/proofs/ pattern. Stores
// in the dedicated /uploads/avatars/ directory and writes the relative
// URL onto user.profilePictureUrl. Existing rows pointing at the old
// /uploads/proofs/<file> path continue to work because the static mount
// still covers the entire /uploads tree — only NEW uploads land in the
// avatars directory.
// =============================================================================
exports.uploadAvatar = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { uploadToCloudinary } = require('../services/cloudinaryService');

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No avatar file provided. Use multipart/form-data with field name "avatar".'
        });
    }

    try {
        const userId = req.user.id;

        // Upload to Cloudinary (folder azaman/users/avatars)
        const { url } = await uploadToCloudinary(req.file, 'users/avatars');

        const updated = await prisma.user.update({
            where: { id: userId },
            data: { profilePictureUrl: url },
            select: { id: true, profilePictureUrl: true },
        });

        return res.status(200).json({
            success: true,
            message: 'Avatar uploaded.',
            data: updated,
        });
    } catch (error) {
        console.error('[profile.uploadAvatar] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};
