// controllers/adController.js
// =============================================================================
// AZAMAN V2 — AD CONTROLLER
// Phase 2.4: AI Matchmaking upgraded to use buyer's actual trade history
// Phase I  : cursor pagination (non-AI mode) + composite indexes
// =============================================================================

const { parsePagination, buildPageEnvelope } = require('../utils/pagination');

// 1. CREATE AD (With Vendor & Collateral Check)
exports.createAd = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { type, crypto, pricePerUSD, margin, minLimit, maxLimit, paymentMethod, terms, tradeAccountId } = req.body;
        const vendorId = req.user.id;

        // ── Phase F (2026-05-25): BUY ads re-enabled ──────────────────────
        // Phase D-2 corrected the BUY-ad settlement model (escrow via
        // availableBalance → escrowLockedBalance). The env-flag gate has
        // been removed. BUY and SELL ads are both fully supported.

        const vendor = await prisma.user.findUnique({ where: { id: vendorId } });

        // ── Collateral gate (reads from GlobalSettings) ─────────────────────
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const minCollateral = Number(settings?.vendorMinCollateral ?? 500);

        if (Number(vendor.vendorUnallocatedBalance) < minCollateral) {
            return res.status(403).json({
                success: false,
                message: `Insufficient trading pool liquidity. You need at least $${minCollateral} USDC in your trading pool to post ads.`
            });
        }

        // ── Phase F2: Validate tradeAccountId if provided ───────────────────
        let linkedAccount = null;
        if (tradeAccountId) {
            linkedAccount = await prisma.tradeAccount.findUnique({
                where: { id: tradeAccountId }
            });
            if (!linkedAccount) {
                return res.status(400).json({ success: false, message: 'Trade account not found.' });
            }
            if (linkedAccount.userId !== vendorId) {
                return res.status(403).json({ success: false, message: 'Trade account does not belong to you.' });
            }
            if (linkedAccount.adminVerificationStatus !== 'APPROVED') {
                return res.status(400).json({ success: false, message: 'Trade account must be admin-approved before posting ads.' });
            }
        }

        // ── Phase F2: P2P ads use flat USDC pricing ─────────────────────────
        // No GHS oracle math. pricePerUSD is informational only (display rate).
        // The actual trade is amountCrypto USDC ↔ amountFiat USD (1:1 minus fee).
        let finalPrice = parseFloat(pricePerUSD || 1.0);

        const formattedMethods = linkedAccount
            ? linkedAccount.methodType
            : (Array.isArray(paymentMethod) ? paymentMethod.join(', ') : (paymentMethod || 'Zelle'));

        const newAd = await prisma.ad.create({
            data: {
                type:           type || 'SELL',
                crypto:         crypto || 'USDC',
                pricePerUSD:    finalPrice,
                margin:         margin !== undefined ? parseFloat(margin) : null,
                minLimit:       parseFloat(minLimit),
                maxLimit:       parseFloat(maxLimit),
                paymentMethod:  formattedMethods,
                terms:          terms || null,
                vendorId:       vendor.id,
                status:         'ACTIVE',
                tradeAccountId: linkedAccount?.id || null
            }
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(201).json({ success: true, message: 'Ad posted successfully!', ad: newAd });

    } catch (error) {
        console.error('Create Ad Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// 2. GET MARKETPLACE ADS — Smart AI Matchmaking
//
// When aiFilter=true the system:
//   a) Fetches the authenticated buyer's full trade history
//   b) Extracts every paymentMethod they have ever used, ranked by frequency
//   c) Scores each ad based on method overlap, vendor reputation, KYC status,
//      and completion rate — producing a deterministic personalised ranking
//
// Without aiFilter ads are sorted by best price for the requested type.
// =============================================================================
exports.getMarketplaceAds = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { type, crypto, amount, aiFilter, preferredPayment } = req.query;
        const { take, cursor, mode, page } = parsePagination(req.query);

        // ── Build the base WHERE clause ────────────────────────────────────
        const whereClause = { status: 'ACTIVE' };
        if (type)   whereClause.type   = type;
        if (crypto) whereClause.crypto = crypto;
        if (amount) {
            const amountFloat            = parseFloat(amount);
            whereClause.minLimit         = { lte: amountFloat };
            whereClause.maxLimit         = { gte: amountFloat };
        }

        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });

        // AI mode re-ranks the entire candidate set, so a small server-side
        // window (3x the page size, capped at MAX_LIMIT) gives the AI enough
        // candidates to score without unbounded fetches. Non-AI mode uses
        // the standard cursor path.
        const aiOn = aiFilter === 'true';
        const findArgs = {
            where:   whereClause,
            include: {
                vendor: {
                    select: {
                        id: true, username: true, createdAt: true,
                        tradesCompleted: true, completionRate: true,
                        positiveReviews: true, negativeReviews: true,
                        kycStatus: true, paymentDetails: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' },
        };
        if (aiOn) {
            // Pull a wider window so the AI scorer has room to re-rank.
            findArgs.take = Math.min(take * 3, 100);
        } else {
            findArgs.take = take;
            // Phase E2: boosted ads sort first, then by createdAt desc
            findArgs.orderBy = [{ isBoosted: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }];
            if (cursor) {
                findArgs.cursor = { id: parseInt(cursor, 10) };
                findArgs.skip = 1;
            }
        }

        let ads = await prisma.ad.findMany(findArgs);

        // Phase E2: expire stale boosts on read (lazy cleanup).
        // Ads with isBoosted=true but expired boostExpiresAt get marked
        // as unboosted. Fire-and-forget — no need to block the response.
        const now = new Date();
        const expiredBoostIds = ads
            .filter(ad => ad.isBoosted && ad.boostExpiresAt && new Date(ad.boostExpiresAt) <= now)
            .map(ad => ad.id);
        if (expiredBoostIds.length > 0) {
            // Optimistic: mark them unboosted in the response immediately
            ads = ads.map(ad => {
                if (expiredBoostIds.includes(ad.id)) {
                    return { ...ad, isBoosted: false };
                }
                return ad;
            });
            // Fire-and-forget DB cleanup
            setImmediate(() => {
                prisma.ad.updateMany({
                    where: { id: { in: expiredBoostIds } },
                    data: { isBoosted: false }
                }).catch(err => console.error('[adController] boost expiry cleanup error:', err.message));
            });
        }

        // ── Phase F2: No GHS recalculation for P2P ads ──────────────────────
        // P2P trades are USDC↔USD (1:1). The pricePerUSD on an ad is
        // informational only. No oracle rate is applied to P2P listings.

        // ── AI Matchmaking ─────────────────────────────────────────────────
        if (aiOn) {

            // ── Step 1: build the buyer's ranked payment method preference ──
            // Determine the calling user's ID from their JWT if present;
            // fall back to the query param `preferredPayment` if unauthenticated.
            let rankedMethods = [];

            if (req.user?.id) {
                // Pull every trade this buyer has been involved in
                const buyerTrades = await prisma.trade.findMany({
                    where:  { userId: req.user.id, status: 'COMPLETED' },
                    select: { paymentMethod: true }
                });

                // Frequency map of payment methods from trade history
                const methodFrequency = {};
                for (const trade of buyerTrades) {
                    const method = (trade.paymentMethod || '').trim().toLowerCase();
                    if (!method) continue;
                    methodFrequency[method] = (methodFrequency[method] || 0) + 1;
                }

                // Sort methods by descending frequency
                rankedMethods = Object.entries(methodFrequency)
                    .sort((a, b) => b[1] - a[1])
                    .map(([method]) => method);
            }

            // If buyer has no history (new user), fall back to query param
            if (rankedMethods.length === 0 && preferredPayment) {
                rankedMethods = [preferredPayment.toLowerCase()];
            }

            // ── Step 2: score each ad ───────────────────────────────────────
            ads = ads.map(ad => {
                let matchScore  = 0;
                const adMethods = ad.paymentMethod.toLowerCase();

                // History-based method match (rank-weighted)
                for (let i = 0; i < rankedMethods.length; i++) {
                    const method = rankedMethods[i];
                    if (adMethods.includes(method)) {
                        // Highest-frequency method scores highest, decaying linearly
                        matchScore += Math.max(100 - i * 15, 10);
                        break; // first match wins
                    }
                }

                // Deep-search vendor payment vault for method match
                if (ad.vendor.paymentDetails) {
                    const detailsStr = JSON.stringify(ad.vendor.paymentDetails).toLowerCase();
                    for (const method of rankedMethods) {
                        if (detailsStr.includes(method)) {
                            matchScore += 30;
                            break;
                        }
                    }
                }

                // Vendor quality signals
                if (ad.vendor.kycStatus === 'VERIFIED')       matchScore += 20;
                if (ad.vendor.completionRate > 95)            matchScore += 20;
                else if (ad.vendor.completionRate > 85)       matchScore += 10;

                matchScore += Math.min(ad.vendor.tradesCompleted * 2, 60); // cap at 60pts

                // Penalise vendors with overwhelmingly negative reviews
                const totalReviews = (ad.vendor.positiveReviews || 0) + (ad.vendor.negativeReviews || 0);
                if (totalReviews > 0) {
                    const positivityRate = ad.vendor.positiveReviews / totalReviews;
                    if (positivityRate < 0.5) matchScore -= 30;
                    else if (positivityRate > 0.9) matchScore += 10;
                }

                return { ...ad, _aiMatchScore: matchScore };
            });

            // ── Step 3: sort by score DESC, break ties by price ─────────────
            ads.sort((a, b) => {
                if (b._aiMatchScore !== a._aiMatchScore) return b._aiMatchScore - a._aiMatchScore;
                return a.pricePerUSD - b.pricePerUSD;   // cheapest first
            });

            // Expose the score to the client (useful for Flutter debug UI)
            ads = ads.map(({ _aiMatchScore, ...rest }) => ({
                ...rest,
                aiMatchScore:   _aiMatchScore,
                aiMethodsUsed:  rankedMethods.slice(0, 5) // top-5 for transparency
            }));
            // Trim AI window back to the requested page size after scoring.
            ads = ads.slice(0, take);

        } else {
            // Standard sort: by price (cheapest first).
            ads.sort((a, b) => a.pricePerUSD - b.pricePerUSD);
        }

        // ── Phase UI Sprint (2026-05-26) ────────────────────────────────────
        // The FE marketplace card has an "Available" amount per ad —
        // historically read from `ad.availableUsdc` or `ad.totalAmount`.
        // Neither field exists in the schema; the intent is the vendor's
        // CURRENT escrowable liquidity for that ad. For a SELL ad this is
        // `vendor.vendorUnallocatedBalance` (USDC that's not already
        // committed to other trades). For a BUY ad the vendor doesn't
        // escrow upfront, so available is the ad's per-trade ceiling.
        //
        // We need a fresh balance snapshot. The vendor `select` above
        // already returned the columns we need — actually it didn't,
        // so issue one parallel batch read.
        const vendorIds = [...new Set(ads.map(a => a.vendorId))];
        if (vendorIds.length > 0) {
            const balances = await prisma.user.findMany({
                where: { id: { in: vendorIds } },
                select: { id: true, vendorUnallocatedBalance: true }
            });
            const balanceById = Object.fromEntries(
                balances.map(u => [u.id, Number(u.vendorUnallocatedBalance)])
            );
            ads = ads.map(ad => {
                const vendorPool = balanceById[ad.vendorId] ?? 0;
                const perTradeCap = Number(ad.maxLimit);
                const availableUsdc = ad.type === 'BUY'
                    ? perTradeCap
                    : vendorPool;
                return { ...ad, availableUsdc };
            });
        }

        const envelope = buildPageEnvelope(ads, take, mode, page);
        // AI mode is fundamentally single-page: the scorer re-ranks every
        // request, so the same ad can appear on multiple pages or none at
        // all. Force `hasMore=false` + `nextCursor=null` to make the contract
        // honest. Clients wanting "more matches" should refine the filter
        // (type, payment method, amount) rather than paginate.
        if (aiOn) {
            envelope.hasMore = false;
            envelope.nextCursor = null;
        }
        // Backwards-compat: legacy callers (no cursor, no limit, no page)
        // expect a bare array. Only emit the envelope shape when the caller
        // opted in via any pagination param. The frontend marketplace screen
        // can adopt cursors at its own pace.
        const optedIn = ('cursor' in req.query) || ('limit' in req.query) || ('page' in req.query);
        if (optedIn) {
            res.status(200).json({ ads, ...envelope });
        } else {
            res.status(200).json(ads);
        }

    } catch (error) {
        console.error('Get Ads Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// 3. DEACTIVATE AD
exports.deactivateAd = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const ad = await prisma.ad.findUnique({ where: { id: parseInt(id) } });
        if (!ad) return res.status(404).json({ message: 'Ad not found' });
        if (ad.vendorId !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

        await prisma.ad.update({ where: { id: parseInt(id) }, data: { status: 'INACTIVE' } });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({ success: true, message: 'Ad taken down successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// 4. GET MY ADS
exports.getMyAds = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const vendorId = req.user.id;
        const includeArchived = req.query.includeArchived === 'true';

        const whereClause = { vendorId };
        // By default, hide archived ads from the vendor's list
        if (!includeArchived) {
            whereClause.status = { not: 'ARCHIVED' };
        }

        const ads = await prisma.ad.findMany({
            where:   whereClause,
            orderBy: { createdAt: 'desc' },
            include: {
                vendor: {
                    select: { id: true, username: true, tradesCompleted: true, completionRate: true }
                },
                tradeAccount: {
                    select: { id: true, methodType: true }
                }
            }
        });

        res.status(200).json({ success: true, ads });
    } catch (error) {
        console.error('Get My Ads Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// 5. TOGGLE AD STATUS
exports.toggleAdStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id }     = req.params;
        const vendorId   = req.user.id;
        const ad         = await prisma.ad.findUnique({ where: { id: parseInt(id) } });

        if (!ad) return res.status(404).json({ success: false, message: 'Ad not found.' });
        if (ad.vendorId !== vendorId) return res.status(403).json({ success: false, message: 'Unauthorized.' });

        const newStatus  = ad.status === 'ACTIVE' ? 'OFFLINE' : 'ACTIVE';
        const updatedAd  = await prisma.ad.update({
            where: { id: parseInt(id) },
            data:  { status: newStatus }
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({ success: true, message: `Ad is now ${newStatus}.`, ad: updatedAd });
    } catch (error) {
        console.error('Toggle Ad Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// =============================================================================
// 6. ARCHIVE AD (Soft-Delete)
//
// Vendors can "delete" ads that are no longer functional. The ad is NEVER
// permanently removed from the database — it is archived for audit trail,
// compliance, and dispute resolution purposes.
//
// Rules:
//   - Only INACTIVE or OFFLINE ads can be archived (not ACTIVE).
//   - No in-progress trades may reference the ad (status IN_PROGRESS / ESCROW).
//   - Once archived, the ad is hidden from getMyAds and the marketplace.
//   - Admin can still view archived ads via the war room.
// =============================================================================
exports.archiveAd = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const vendorId = req.user.id;

        const ad = await prisma.ad.findUnique({ where: { id: parseInt(id) } });
        if (!ad) return res.status(404).json({ success: false, message: 'Ad not found.' });
        if (ad.vendorId !== vendorId) return res.status(403).json({ success: false, message: 'Unauthorized.' });

        // Cannot archive an ACTIVE ad — must deactivate first
        if (ad.status === 'ACTIVE') {
            return res.status(400).json({
                success: false,
                message: 'Cannot archive an active ad. Deactivate it first.'
            });
        }

        // Check for in-progress trades referencing this ad
        const activeTrades = await prisma.trade.count({
            where: {
                adId: parseInt(id),
                status: { in: ['PENDING', 'IN_PROGRESS', 'ESCROW', 'DISPUTED'] }
            }
        });
        if (activeTrades > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot archive: ${activeTrades} trade(s) still in progress on this ad.`
            });
        }

        // Soft-delete: set status to ARCHIVED with timestamp
        const archivedAd = await prisma.ad.update({
            where: { id: parseInt(id) },
            data: {
                status: 'ARCHIVED',
                archivedAt: new Date()
            }
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({
            success: true,
            message: 'Ad archived successfully. It will no longer appear in your ad list or the marketplace.',
            ad: archivedAd
        });
    } catch (error) {
        console.error('Archive Ad Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};
