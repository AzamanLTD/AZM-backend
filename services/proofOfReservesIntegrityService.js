// services/proofOfReservesIntegrityService.js
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EPSILON = 0.00000001;
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 60 * 1000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const money = value => Number.parseFloat(value?.toString?.() || '0');

/**
 * User liabilities are denominated in USDT. SystemFiatPool is a separate fiat
 * (GHS) liquidity pool and MUST NOT be added to the USDT reserve numerator.
 * Keeping this calculation pure makes the currency boundary regression-testable.
 */
function calculateReserveCoverage({ systemCrypto = 0, hotWallet = 0, fiatPool = 0, liabilities = 0 }) {
    const totalReserves = money(systemCrypto) + money(hotWallet);
    const reserveRatio = liabilities > 0 ? totalReserves / money(liabilities) : 1;
    return {
        totalReserves,
        reserveRatio,
        fiatPool: money(fiatPool),
    };
}

function merkleRootFromHashes(hashes) {
    if (!hashes.length) return '0'.repeat(64);
    let layer = [...hashes];
    while (layer.length > 1) {
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            next.push(sha256(layer[i] + (i + 1 < layer.length ? layer[i + 1] : layer[i])));
        }
        layer = next;
    }
    return layer[0];
}

function merkleProofFromHashes(hashes, index) {
    const proof = [];
    let layer = [...hashes];
    let idx = index;
    while (layer.length > 1) {
        const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
        proof.push({
            position: idx % 2 === 0 ? 'right' : 'left',
            hash: siblingIndex < layer.length ? layer[siblingIndex] : layer[idx],
        });
        const next = [];
        for (let i = 0; i < layer.length; i += 2) {
            next.push(sha256(layer[i] + (i + 1 < layer.length ? layer[i + 1] : layer[i])));
        }
        layer = next;
        idx = Math.floor(idx / 2);
    }
    return proof;
}

function verifyMerkleProof(leafHash, proof, root) {
    let hash = leafHash;
    for (const step of proof) {
        hash = step.position === 'right' ? sha256(hash + step.hash) : sha256(step.hash + hash);
    }
    return hash === root;
}

async function loadState(tx) {
    const users = await tx.user.findMany({
        where: { isDeleted: false },
        select: {
            id: true,
            availableBalance: true,
            escrowLockedBalance: true,
            vendorUnallocatedBalance: true,
            disputeEscrowBalance: true,
        },
        orderBy: { id: 'asc' },
    });

    const [cryptoWallet, hotWallet, fiatPool] = await Promise.all([
        tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
        tx.systemHotWallet.findUnique({ where: { id: 1 } }),
        tx.systemFiatPool.findUnique({ where: { id: 1 } }),
    ]);

    const totalAvailable = users.reduce((s, u) => s + money(u.availableBalance), 0);
    const totalEscrow = users.reduce((s, u) => s + money(u.escrowLockedBalance), 0);
    const totalVendorUnallocated = users.reduce((s, u) => s + money(u.vendorUnallocatedBalance), 0);
    const totalDisputeEscrow = users.reduce((s, u) => s + money(u.disputeEscrowBalance), 0);
    const totalLiabilities = totalAvailable + totalEscrow + totalVendorUnallocated + totalDisputeEscrow;
    const coverage = calculateReserveCoverage({
        systemCrypto: cryptoWallet?.balance,
        hotWallet: hotWallet?.balance,
        fiatPool: fiatPool?.balance,
        liabilities: totalLiabilities,
    });

    return {
        users,
        totalLiabilities,
        totalReserves: coverage.totalReserves,
        reserveRatio: coverage.reserveRatio,
        breakdown: {
            liabilities: {
                available: totalAvailable.toFixed(8),
                escrow: totalEscrow.toFixed(8),
                vendorUnallocated: totalVendorUnallocated.toFixed(8),
                disputeEscrow: totalDisputeEscrow.toFixed(8),
            },
            // USDT-reserve numerator only. The fiat pool is exposed separately
            // for reconciliation visibility and never participates in backing.
            reserves: {
                currency: 'USDT',
                systemCrypto: money(cryptoWallet?.balance).toFixed(8),
                hotWallet: money(hotWallet?.balance).toFixed(8),
                usdtReserveTotal: coverage.totalReserves.toFixed(8),
                fiatPoolGhs: coverage.fiatPool.toFixed(8),
            },
        },
    };
}

async function createSnapshot() {
    return prisma.$transaction(async tx => {
        const state = await loadState(tx);
        const salt = crypto.randomBytes(16).toString('hex');
        const leaves = state.users.map(u => ({
            userId: u.id,
            availableBalance: u.availableBalance.toString(),
            escrowLockedBalance: u.escrowLockedBalance.toString(),
            vendorUnallocatedBalance: u.vendorUnallocatedBalance.toString(),
            disputeEscrowBalance: u.disputeEscrowBalance.toString(),
            leafHash: sha256(`${u.id}|${u.availableBalance}|${u.escrowLockedBalance}|${u.vendorUnallocatedBalance}|${u.disputeEscrowBalance}|${salt}`),
        }));
        const root = merkleRootFromHashes(leaves.map(l => l.leafHash));
        const snapshot = await tx.proofOfReservesSnapshot.create({
            data: {
                totalLiabilities: state.totalLiabilities,
                totalReserves: state.totalReserves,
                reserveRatio: state.reserveRatio * 100,
                isFullyBacked: state.reserveRatio >= 1,
                userCount: leaves.length,
                merkleRoot: root,
                salt,
                breakdown: state.breakdown,
            },
        });
        for (const leaf of leaves) {
            await tx.$executeRaw`INSERT INTO "ProofOfReservesLeaf" ("snapshotId", "userId", "availableBalance", "escrowLockedBalance", "vendorUnallocatedBalance", "disputeEscrowBalance", "leafHash") VALUES (${snapshot.id}, ${leaf.userId}, ${leaf.availableBalance}, ${leaf.escrowLockedBalance}, ${leaf.vendorUnallocatedBalance}, ${leaf.disputeEscrowBalance}, ${leaf.leafHash})`;
        }
        return { snapshot, root, ratio: state.reserveRatio };
    }, { isolationLevel: 'Serializable' });
}

async function getLatestSnapshot() {
    const snapshot = await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!snapshot) return null;
    return {
        timestamp: snapshot.createdAt.toISOString(),
        totalLiabilities: snapshot.totalLiabilities.toString(),
        totalReserves: snapshot.totalReserves.toString(),
        reserveRatio: snapshot.reserveRatio.toString(),
        isFullyBacked: snapshot.isFullyBacked,
        userCount: snapshot.userCount,
        merkleRoot: snapshot.merkleRoot,
        breakdown: snapshot.breakdown,
    };
}

async function verifyUser(userId, snapshotId) {
    const snapshot = snapshotId
        ? await prisma.proofOfReservesSnapshot.findUnique({ where: { id: Number(snapshotId) } })
        : await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!snapshot) return null;
    const rows = await prisma.$queryRaw`SELECT "userId", "availableBalance", "escrowLockedBalance", "vendorUnallocatedBalance", "disputeEscrowBalance", "leafHash" FROM "ProofOfReservesLeaf" WHERE "snapshotId" = ${snapshot.id} ORDER BY "userId" ASC`;
    const index = rows.findIndex(row => Number(row.userId) === Number(userId));
    if (index < 0) return { snapshot, verified: false, reason: 'USER_NOT_IN_SNAPSHOT' };
    const proof = merkleProofFromHashes(rows.map(r => r.leafHash), index);
    return {
        snapshot,
        verified: verifyMerkleProof(rows[index].leafHash, proof, snapshot.merkleRoot),
        proof,
        yourBalance: {
            available: rows[index].availableBalance.toString(),
            escrow: rows[index].escrowLockedBalance.toString(),
            vendorUnallocated: rows[index].vendorUnallocatedBalance.toString(),
            disputeEscrow: rows[index].disputeEscrowBalance.toString(),
        },
    };
}

async function getIntegrityReport() {
    const latest = await prisma.proofOfReservesSnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
    const journal = await prisma.journalEntry.aggregate({ _sum: { debit: true, credit: true } });
    const totalDebit = money(journal._sum.debit);
    const totalCredit = money(journal._sum.credit);
    const difference = Math.abs(totalDebit - totalCredit);
    if (!latest) {
        return { status: 'NO_SNAPSHOT', snapshot: null, journal: { balanced: difference < EPSILON, totalDebit, totalCredit, difference } };
    }
    const countRows = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM "ProofOfReservesLeaf" WHERE "snapshotId" = ${latest.id}`;
    const leafCount = Number(countRows[0]?.count || 0);
    const coverage = latest.userCount === 0 ? 1 : leafCount / latest.userCount;
    const ageMs = Date.now() - latest.createdAt.getTime();
    const stale = ageMs > MAX_SNAPSHOT_AGE_MS;
    const fullyBacked = latest.isFullyBacked;
    const status = coverage === 1 && difference < EPSILON && fullyBacked && !stale ? 'HEALTHY' : 'EXCEPTION';
    return {
        status,
        snapshot: {
            id: latest.id,
            createdAt: latest.createdAt,
            ageMs,
            stale,
            totalLiabilities: latest.totalLiabilities.toString(),
            totalReserves: latest.totalReserves.toString(),
            reserveRatio: latest.reserveRatio.toString(),
            isFullyBacked: fullyBacked,
            userCount: latest.userCount,
            leafCount,
            leafCoverage: coverage,
            merkleRoot: latest.merkleRoot,
        },
        journal: { balanced: difference < EPSILON, totalDebit, totalCredit, difference },
    };
}

module.exports = {
    createSnapshot,
    getLatestSnapshot,
    verifyUser,
    getIntegrityReport,
    calculateReserveCoverage,
    merkleRootFromHashes,
    merkleProofFromHashes,
    verifyMerkleProof,
    sha256,
};
