// controllers/adController.js
// =============================================================================
// AZAMAN V2 — AD CONTROLLER
// Phase 2.4: AI Matchmaking upgraded to use buyer's actual trade history
// Phase I  : cursor pagination (non-AI mode) + composite indexes
// =============================================================================

const logger = require('../src/config/logger');
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
        // ARCHIVED-ACCOUNT LIFECYCLE + ARCHIVE/AD-CREATE MUTUAL EXCLUSION
        // (2026-10-20 review follow-up): an archived account may never be
        // attached to a new ad — even one that still belongs to the caller
        // and remains admin-approved. Validation previously read the
        // account outside any transaction and never checked archivedAt, so
        // a stale/direct request could create an ACTIVE ad against an
        // archived account, and a concurrent archive could slip between
        // the validation read and the ad insert.
        //
        // Protocol: when an account is attached, validation AND the ad
        // insert run in ONE transaction that first takes a FOR UPDATE row
        // lock on the TradeAccount row — the same lock
        // tradeAccountController.deleteTradeAccount takes before archiving.
        // Postgres serializes the pair on that lock: whichever commits
        // first, the other re-reads the post-commit state (the archiver
        // counts the new ACTIVE ad and refuses; the ad creator sees
        // archivedAt and rejects). The lock is the FIRST statement in both
        // transactions (identical single-row lock) — no lock-order
        // inversion, no deadlock between the pair.
        // ── Phase F2: P2P ads use flat USDC pricing ─────────────────────────
        // No GHS oracle math. pricePerUSD is informational only (display rate).
        // The actual trade is amountCrypto USDC ↔ amountFiat USD (1:1 minus fee).
        let finalPrice = parseFloat(pricePerUSD || 1.0);

        const fail = (status, message) => {
            const e = new Error(message);
            e.statusCode = status;
            return e;
        };

        let linkedAccount = null;
        let newAd;
        if (tradeAccountId) {
            newAd = await prisma.$transaction(async (tx) => {
                const locked = await tx.$queryRaw`
                    SELECT "id", "userId", "methodType", "adminVerificationStatus", "archivedAt"
                    FROM "TradeAccount"
                    WHERE "id" = ${tradeAccountId}
                    FOR UPDATE`;
                const account = locked[0];

                if (!account) throw fail(400, 'Trade account not found.');
                if (account.userId !== vendorId) throw fail(403, 'Trade account does not belong to you.');
                if (account.adminVerificationStatus !== 'APPROVED') {
                    throw fail(400, 'Trade account must be admin-approved before posting ads.');
                }
                if (account.archivedAt) {
                    throw fail(400, 'Trade account is archived and can no longer be attached to ads.');
                }

                linkedAccount = account;
                return tx.ad.create({
                    data: {
                        type:           type || 'SELL',
                        crypto:         crypto || 'USDC',
                        pricePerUSD:    finalPrice,
                        margin:         margin !== undefined ? parseFloat(margin) : null,
                        minLimit:       parseFloat(minLimit),
                        maxLimit:       parseFloat(maxLimit),
                        paymentMethod:  account.methodType,
                        terms:          terms || null,
                        vendorId:       vendor.id,
                        status:         'ACTIVE',
                        tradeAccountId: account.id
                    }
                });
            });
        }

        if (!newAd) {
            // No linked account — the original non-account path, unchanged.
            const formattedMethods = Array.isArray(paymentMethod)
                ? paymentMethod.join(', ')
                : (paymentMethod || 'Zelle');

            newAd = await prisma.ad.create({
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
                    tradeAccountId: null
                }
            });
        }

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(201).json({ success: true, message: 'Ad posted successfully!', ad: newAd });

    } catch (error) {
        // Validation failures thrown inside the account-attached transaction
        // keep their intended status code and the { success, message } shape
        // the existing account-validation errors already used.
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        logger.error('Create Ad Error:', error);
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
                }).catch(err => logger.error({ err: err }, '[adController] boost expiry cleanup error'));
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
        logger.error('Get Ads Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// 3. DEACTIVATE AD
exports.deactivateAd = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const vendorId = req.user.id;

        const fail = (status, message) => {
            const e = new Error(message);
            e.statusCode = status;
            return e;
        };

        // STATUS-WRITER PROTOCOL (2026-10-20 final review): deactivate is a
        // status writer and MUST follow the same lock order as toggleAdStatus
        // and archiveAd — linked TradeAccount row FOR UPDATE first, then the
        // Ad row FOR UPDATE — and re-read the ad under the lock before
        // writing. ARCHIVED is TERMINAL: deactivation must never undo an
        // archive (or a subsequent toggle could resurrect the ad). Legacy
        // rows with archivedAt set but a stale status are treated as
        // archived too — checking status alone is not sufficient.
        await prisma.$transaction(async (tx) => {
            const pre = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!pre) throw fail(404, 'Ad not found');
            if (pre.tradeAccountId) {
                await tx.$queryRaw`
                    SELECT "id" FROM "TradeAccount"
                    WHERE "id" = ${pre.tradeAccountId}
                    FOR UPDATE`;
            }
            await tx.$queryRaw`SELECT "id" FROM "Ad" WHERE "id" = ${parseInt(id)} FOR UPDATE`;

            const ad = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!ad) throw fail(404, 'Ad not found');
            if (ad.vendorId !== vendorId) throw fail(403, 'Unauthorized');

            if (ad.status === 'ARCHIVED' || ad.archivedAt) {
                throw fail(400, 'This ad has been archived and can no longer be modified. Create a new ad instead.');
            }

            await tx.ad.update({ where: { id: parseInt(id) }, data: { status: 'INACTIVE' } });
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({ success: true, message: 'Ad taken down successfully.' });
    } catch (error) {
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
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
        logger.error('Get My Ads Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

// 5. TOGGLE AD STATUS
// =============================================================================
// ACTIVATION ↔ ACCOUNT-ARCHIVAL MUTUAL EXCLUSION (2026-10-20 review
// follow-up). The previous unconditional `status === 'ACTIVE' ? 'OFFLINE'
// : 'ACTIVE'` flip had two defects:
//   (a) an OFFLINE ad linked to a trade account could be reactivated AFTER
//       that account was archived — the exact lifecycle gap createAd was
//       fixed for, reopened through this path; and it raced account
//       archival the same way createAd did.
//   (b) an ARCHIVED ad — a TERMINAL soft-archive state (see archiveAd) —
//       could be resurrected to ACTIVE through this path.
//
// Protocol (identical to createAd / deleteTradeAccount / archiveAd):
// validation and the status write run inside ONE transaction; when the ad
// is linked to a trade account, the transaction takes the same
// SELECT ... FOR UPDATE row lock on the TradeAccount row FIRST, then the
// Ad row lock (one consistent TradeAccount→Ad order across all ad-status
// writers), so
// activation and archival serialize on that lock: whichever commits first,
// the other re-reads post-commit state — the reactivator sees archivedAt
// and refuses; the archiver counts the newly re-ACTIVE ad and refuses.
// Deactivation (ACTIVE→OFFLINE) remains always allowed: it only ever
// reduces the archiver's active-ad count and can never violate the
// invariant. The pre-read of the ad (to learn its immutable
// tradeAccountId) is only used to select the lock set; ALL validation and
// the write are re-done inside the transaction.
// =============================================================================
exports.toggleAdStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id }     = req.params;
        const vendorId   = req.user.id;

        const fail = (status, message) => {
            const e = new Error(message);
            e.statusCode = status;
            return e;
        };

        const updatedAd = await prisma.$transaction(async (tx) => {
            const pre = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!pre) throw fail(404, 'Ad not found.');

            if (pre.tradeAccountId) {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "TradeAccount"
                    WHERE "id" = ${pre.tradeAccountId}
                    FOR UPDATE`;
            }
            // Ad-row lock (final review 2026-10-20): the same lock
            // archiveAd takes AFTER its TradeAccount lock — one consistent
            // TradeAccount→Ad order across every ad-status writer, so
            // toggle-vs-archive serializes even for account-unlinked ads
            // and no lock-order inversion is possible.
            await tx.$queryRaw`
                SELECT "id"
                FROM "Ad"
                WHERE "id" = ${parseInt(id)}
                FOR UPDATE`;

            // Re-read and validate the ad's CURRENT state under the lock.
            const ad = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!ad) throw fail(404, 'Ad not found.');
            if (ad.vendorId !== vendorId) throw fail(403, 'Unauthorized.');

            // ARCHIVED is terminal soft-archive — never resurrected here.
            if (ad.status === 'ARCHIVED') {
                throw fail(400, 'Archived ads cannot be reactivated. Create a new ad instead.');
            }

            const newStatus = ad.status === 'ACTIVE' ? 'OFFLINE' : 'ACTIVE';

            // Reactivation (→ACTIVE) of an account-linked ad requires the
            // linked account to still exist and be unarchived. The row lock
            // above makes this check race-free against deleteTradeAccount.
            if (newStatus === 'ACTIVE' && ad.tradeAccountId) {
                const acct = await tx.tradeAccount.findUnique({
                    where: { id: ad.tradeAccountId },
                    select: { archivedAt: true },
                });
                if (!acct || acct.archivedAt) {
                    throw fail(400, 'Trade account is archived and can no longer be attached to ads.');
                }
            }

            return tx.ad.update({
                where: { id: parseInt(id) },
                data:  { status: newStatus }
            });
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({ success: true, message: `Ad is now ${updatedAd.status}.`, ad: updatedAd });
    } catch (error) {
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        logger.error('Toggle Ad Error:', error);
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
//   - QUEUE POLICY: no WAITING TradeQueue buyers on the ad (the Trade model
//     has no adId, so the old "no in-progress trades on this ad" rule is
//     unenforceable in the current schema — see the in-handler note).
//   - Once archived, the ad is hidden from getMyAds and the marketplace.
//   - Admin can still view archived ads via the war room.
// =============================================================================
exports.archiveAd = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const vendorId = req.user.id;

        const fail = (status, message) => {
            const e = new Error(message);
            e.statusCode = status;
            return e;
        };

        // TOGGLE ↔ ARCHIVE MUTUAL EXCLUSION (2026-10-20 final review).
        // archiveAd used to be a non-transactional read/check/update, so a
        // concurrent toggleAdStatus could validate an OFFLINE ad and then
        // overwrite the committed ARCHIVED status with ACTIVE, defeating the
        // terminal contract. Both ad-status writers (toggleAdStatus and
        // archiveAd) now run inside ONE transaction with a CONSISTENT lock
        // order:
        //   1. TradeAccount row FOR UPDATE (only when the ad is
        //      account-linked) — the same lock createAd and
        //      deleteTradeAccount take FIRST, so no lock-order inversion
        //      is introduced into the existing account protocol;
        //   2. Ad row FOR UPDATE — serializes toggle-vs-archive even for
        //      account-unlinked ads.
        // The ad's status is then RE-READ under the lock before the write,
        // so ARCHIVED is terminal under concurrent as well as sequential
        // requests: whichever writer commits first, the other re-reads the
        // post-commit status and refuses (ARCHIVED → toggle 400; ACTIVE →
        // archive 400).
        const archivedAd = await prisma.$transaction(async (tx) => {
            const pre = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!pre) throw fail(404, 'Ad not found.');

            if (pre.tradeAccountId) {
                await tx.$queryRaw`
                    SELECT "id"
                    FROM "TradeAccount"
                    WHERE "id" = ${pre.tradeAccountId}
                    FOR UPDATE`;
            }
            await tx.$queryRaw`
                SELECT "id"
                FROM "Ad"
                WHERE "id" = ${parseInt(id)}
                FOR UPDATE`;

            // Re-read the ad's CURRENT state under the locks.
            const ad = await tx.ad.findUnique({ where: { id: parseInt(id) } });
            if (!ad) throw fail(404, 'Ad not found.');
            if (ad.vendorId !== vendorId) throw fail(403, 'Unauthorized.');

            // Already archived (explicit status OR legacy archivedAt
            // marker): archiving is idempotent-refused, never re-stamped.
            if (ad.status === 'ARCHIVED' || ad.archivedAt) {
                throw fail(400, 'This ad has already been archived.');
            }

            // Cannot archive an ACTIVE ad — must deactivate first
            if (ad.status === 'ACTIVE') {
                throw fail(400, 'Cannot archive an active ad. Deactivate it first.');
            }

            // QUEUE POLICY (named honestly 2026-10-20 final review): this
            // guard is the ad's overflow-QUEUE policy — a vendor cannot
            // archive an ad while buyers are WAITING in its TradeQueue.
            // It is NOT the historical "no in-progress trades on this ad"
            // policy: the Trade model has NO adId column (the original
            // prisma.trade.count({ where: { adId } }) always threw
            // PrismaClientValidationError and 500'd this endpoint), so
            // ad-to-trade association does not exist in the schema and
            // that older policy is UNENFORCEABLE today. Implementing it
            // requires adding Trade.adId (schema migration, write at
            // trade-initiation, backfill) — tracked as a separate,
            // explicitly-scoped change; do NOT treat this queue count as
            // proof that no in-progress trades exist.
            const waitingQueueEntries = await tx.tradeQueue.count({
                where: {
                    adId: parseInt(id),
                    status: 'WAITING'
                }
            });
            if (waitingQueueEntries > 0) {
                throw fail(400, `Cannot archive: ${waitingQueueEntries} buyer(s) are still waiting in this ad's trade queue.`);
            }

            // Soft-delete: set status to ARCHIVED with timestamp
            return tx.ad.update({
                where: { id: parseInt(id) },
                data: {
                    status: 'ARCHIVED',
                    archivedAt: new Date()
                }
            });
        });

        const io = req.app.get('socketio');
        if (io) io.emit('market_update');

        res.status(200).json({
            success: true,
            message: 'Ad archived successfully. It will no longer appear in your ad list or the marketplace.',
            ad: archivedAd
        });
    } catch (error) {
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        logger.error('Archive Ad Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};
