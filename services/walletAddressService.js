// services/walletAddressService.js
// =============================================================================
// AZAMAN — WALLET ADDRESS AUTHORITY (financial architecture §P.1, 2026-09-17)
//
// WalletAddress is the AUTHORITATIVE registry for customer on-chain deposit
// addresses. User.tatumPolygonAddress remains ONLY as a compatibility mirror,
// and THIS SERVICE is its sole writer — no other code path may modify the
// mirror, so the two can never diverge.
//
// Asset identity is contract-explicit: native Polygon USDC
// (0x3c499c542cef5e3811e1192ce70d8cc03d5c3359) is the canonical deposit asset.
// Bridged USDC.e is a DISTINCT asset and must never be conflated with canonical
// USDC.
//
// Concurrency authority is the DATABASE: the partial unique index
// WalletAddress_one_active_per_user_network_asset_idx (one ACTIVE row per
// user + network + canonical asset) and the global unique (address, network).
// Application reads are never the race arbiter — a racing duplicate allocation
// converges to the single committed row.
// =============================================================================

const logger = require('../src/config/logger');

// Canonical primary deposit asset: native USDC on Polygon.
const NATIVE_USDC = {
    network:      'POLYGON',
    asset:        'USDC',
    contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    decimals:     6,
};

// Bridged USDC.e is a DISTINCT asset — explicitly NOT canonical. A row may
// represent it for evidence purposes, but it can never be the canonical
// customer deposit identity.
const USDC_E = {
    network:      'POLYGON',
    asset:        'USDC_E',
    contractAddress: '0x2791b9717a737ca894d692502e875a1a8eab1cfa',
    decimals:     6,
};

const isCanonicalDepositAsset = (identity) => {
    const net = String(identity?.network || '').toUpperCase();
    const asset = String(identity?.asset || '').toUpperCase();
    const contract = String(identity?.contractAddress || '').toLowerCase();
    return net === NATIVE_USDC.network
        && asset === NATIVE_USDC.asset
        && contract === NATIVE_USDC.contractAddress;
};

const _requireUser = async (tx, userId) => {
    const user = await tx.user.findUnique({
        where:  { id: userId },
        select: { id: true, tatumPolygonAddress: true },
    });
    if (!user) {
        const err = new Error('User not found.');
        err.code = 'USER_NOT_FOUND';
        throw err;
    }
    return user;
};

// ── Authoritative reads ─────────────────────────────────────────────────────

async function getActiveDepositAddress(prisma, userId, identity = NATIVE_USDC) {
    return prisma.walletAddress.findFirst({
        where: {
            userId,
            network:         String(identity.network).toUpperCase(),
            contractAddress: String(identity.contractAddress).toLowerCase(),
            status:          'ACTIVE',
        },
        orderBy: { createdAt: 'desc' },
    });
}

/**
 * Authoritative ownership lookup for an inbound on-chain event.
 * Resolves (address + network) against WalletAddress first; a legacy
 * User.tatumPolygonAddress match remains the deterministic migration fallback
 * for records that predate the registry.
 */
async function resolveOwner(prisma, { address, network = NATIVE_USDC.network }) {
    if (!address) return null;
    const normalized = String(address).toLowerCase().trim();
    const net = String(network).toUpperCase();

    // ACTIVE rows sort before RETIRED (enum order); newest first within a status.
    const row = await prisma.walletAddress.findFirst({
        where:  { address: normalized, network: net },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    if (row) return { userId: row.userId, walletAddress: row, source: 'WALLET_ADDRESS' };

    // Deterministic legacy fallback during migration.
    const user = await prisma.user.findFirst({
        where:  { tatumPolygonAddress: normalized },
        select: { id: true },
    });
    if (user) return { userId: user.id, walletAddress: null, source: 'LEGACY_MIRROR' };

    return null;
}

// ── Allocation (idempotent; converges under races) ───────────────────────────

/**
 * Idempotent canonical deposit-address allocation. Concurrent calls for the
 * same user converge on ONE ACTIVE WalletAddress row; the database constraints
 * are the authority, and the loser re-reads the committed winner instead of
 * generating a second address. This is also the ONLY writer of the
 * User.tatumPolygonAddress mirror.
 */
async function allocateDepositAddress(prisma, tatumService, userId, opts = {}) {
    const identity = opts.identity || NATIVE_USDC;
    if (!isCanonicalDepositAsset(identity)) {
        const err = new Error(
            'Only the canonical native-USDC-on-Polygon identity can be allocated as a customer deposit address.'
        );
        err.code = 'UNSUPPORTED_ASSET_IDENTITY';
        throw err;
    }

    // Fast path: an ACTIVE canonical address already exists.
    const existing = await getActiveDepositAddress(prisma, userId, identity);
    if (existing) return { ...existing, isNew: false, adopted: false };

    const user = await _requireUser(prisma, userId);

    // Adoption: a legacy mirror address that has no registry row yet (e.g. the
    // boot backfill has not run) is registered deterministically. The address
    // itself is never re-derived or changed. If a registry row already owns the
    // mirror address (e.g. this user's own RETIRED address), adoption is
    // skipped and a fresh address is derived instead.
    if (user.tatumPolygonAddress) {
        const mirrorRow = await prisma.walletAddress.findFirst({
            where:  { address: user.tatumPolygonAddress.toLowerCase(), network: identity.network },
            select: { id: true, userId: true, status: true },
        });
        if (mirrorRow && mirrorRow.userId === userId && mirrorRow.status === 'ACTIVE') {
            // Converged: an ACTIVE canonical row exists (e.g. won by a racing call).
            return { ...await getActiveDepositAddress(prisma, userId, identity), isNew: false, adopted: false };
        }
        if (mirrorRow) {
            // Owned but not adoptable (RETIRED here, or a foreign owner upstream):
            // derive a fresh address instead of colliding with the existing row.
            logger.info(
                '[walletAddressService] mirror address already registered (status %s) — deriving a fresh address',
                mirrorRow.status
            );
        } else {
        try {
            const adopted = await prisma.$transaction(async (tx) => {
                const created = await tx.walletAddress.create({
                    data: {
                        userId,
                        network:         identity.network,
                        asset:           identity.asset,
                        contractAddress: identity.contractAddress,
                        address:         user.tatumPolygonAddress.toLowerCase(),
                        derivationIndex: userId, // established rule: index = user.id
                        status:          'ACTIVE',
                    },
                });
                await tx.user.update({
                    where:  { id: userId },
                    data:   { tatumPolygonAddress: created.address }, // mirror stays in sync
                });
                return created;
            });
            return { ...adopted, isNew: true, adopted: true };
        } catch (err) {
            const winner = await getActiveDepositAddress(prisma, userId, identity);
            if (winner) return { ...winner, isNew: false, adopted: false };
            throw err;
        }
        }
    }

    if (!tatumService) {
        const err = new Error('Tatum Web3 service is not configured on this server.');
        err.code = 'TATUM_SERVICE_UNAVAILABLE';
        throw err;
    }

    const derivation = await tatumService.deriveDepositAddress(userId);
    const normalizedAddress = String(derivation.address).toLowerCase();

    let row;
    try {
        row = await prisma.$transaction(async (tx) => {
            const created = await tx.walletAddress.create({
                data: {
                    userId,
                    network:         identity.network,
                    asset:           identity.asset,
                    contractAddress: identity.contractAddress,
                    address:         normalizedAddress,
                    derivationIndex: derivation.derivationIndex,
                    status:          'ACTIVE',
                },
            });
            await tx.user.update({
                where:  { id: userId },
                data:   { tatumPolygonAddress: normalizedAddress }, // mirror stays in sync
            });
            return created;
        });
    } catch (err) {
        // A racing duplicate allocation lost: converge on the committed winner
        // instead of generating a second address.
        const winner = await getActiveDepositAddress(prisma, userId, identity);
        if (winner) return { ...winner, isNew: false, adopted: false };
        // The address belongs to another owner: never silently reassign.
        if (err?.code === 'P2002') {
            const collision = new Error(
                'Derived deposit address is already registered to another owner.'
            );
            collision.code = 'ADDRESS_COLLISION';
            throw collision;
        }
        throw err;
    }

    // Best-effort webhook subscription — durable when one exists, never faked.
    let subscriptionId = null;
    try {
        const subscription = await tatumService.subscribeAddress(normalizedAddress);
        subscriptionId = subscription?.subscriptionId || null;
    } catch (subErr) {
        logger.warn({ err: subErr.message }, '[walletAddressService] subscription failed (non-fatal)');
    }
    if (subscriptionId) {
        row = await prisma.walletAddress.update({
            where:  { id: row.id },
            data:   { subscriptionId },
        });
    }

    return { ...row, isNew: true, adopted: false };
}

/**
 * Retire an address. RETIRED is terminal — there is no code path that
 * transitions back to ACTIVE, and (address, network) uniqueness means a
 * retired address can never be reassigned to anyone.
 */
async function retireDepositAddress(prisma, id) {
    const claim = await prisma.walletAddress.updateMany({
        where:  { id, status: 'ACTIVE' },
        data:   { status: 'RETIRED' },
    });
    if (claim.count !== 1) {
        const err = new Error('WalletAddress is not ACTIVE and cannot be retired.');
        err.code = 'WALLET_ADDRESS_NOT_ACTIVE';
        throw err;
    }
    return prisma.walletAddress.findUnique({ where: { id } });
}

module.exports = {
    NATIVE_USDC,
    USDC_E,
    isCanonicalDepositAsset,
    getActiveDepositAddress,
    resolveOwner,
    allocateDepositAddress,
    retireDepositAddress,
};
