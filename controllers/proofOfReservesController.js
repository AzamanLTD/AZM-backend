// controllers/proofOfReservesController.js
// =============================================================================
// AZAMAN V3 — Proof of Reserves (Phase 5)
//
// Public verification page that proves platform solvency by comparing
// total user liabilities (sum of all user balances) against platform
// reserves (system wallets + on-chain treasury).
//
// A Merkle tree root is computed from all user balance commitments so
// users can cryptographically verify their balance is included without
// exposing individual amounts publicly.
//
// Endpoints (all public, no auth required):
//   GET /api/proof-of-reserves          — Current reserve snapshot
//   GET /api/proof-of-reserves/history  — Historical snapshots
//   GET /api/proof-of-reserves/verify   — Verify a user's balance inclusion
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

// ── Merkle tree implementation ──────────────────────────────────────────────
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildMerkleTree(leaves) {
  if (leaves.length === 0) return { root: '0'.repeat(64), layers: [] };

  // Hash all leaves first
  let currentLayer = leaves.map(l => sha256(JSON.stringify(l)));
  const layers = [currentLayer];

  while (currentLayer.length > 1) {
    const nextLayer = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : currentLayer[i];
      nextLayer.push(sha256(left + right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

function generateMerkleProof(leaves, index) {
  const { layers } = buildMerkleTree(leaves);
  const proof = [];

  let idx = index;
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = siblingIndex < layer.length ? layer[siblingIndex] : layer[idx];
    proof.push({
      position: idx % 2 === 0 ? 'right' : 'left',
      hash: sibling,
    });
    idx = Math.floor(idx / 2);
  }

  return proof;
}

function verifyMerkleProof(leafHash, proof, root) {
  let hash = leafHash;
  for (const step of proof) {
    if (step.position === 'right') {
      hash = sha256(hash + step.hash);
    } else {
      hash = sha256(step.hash + hash);
    }
  }
  return hash === root;
}

// ── Snapshot calculation ────────────────────────────────────────────────────
async function generateSnapshot() {
  // Sum all user balances (liabilities)
  const balances = await prisma.user.aggregate({
    _sum: {
      availableBalance: true,
      escrowLockedBalance: true,
      vendorUnallocatedBalance: true,
      disputeEscrowBalance: true,
      azmBalance: true,
    },
    where: { isDeleted: false },
  });

  const totalAvailable = parseFloat(balances._sum.availableBalance?.toString() || '0');
  const totalEscrow = parseFloat(balances._sum.escrowLockedBalance?.toString() || '0');
  const totalVendorUnallocated = parseFloat(balances._sum.vendorUnallocatedBalance?.toString() || '0');
  const totalDisputeEscrow = parseFloat(balances._sum.disputeEscrowBalance?.toString() || '0');

  const totalLiabilities = totalAvailable + totalEscrow + totalVendorUnallocated + totalDisputeEscrow;

  // Platform reserves
  const [cryptoWallet, hotWallet, fiatPool, profitFees] = await Promise.all([
    prisma.systemMasterCrypto.findFirst({ where: { id: 1 } }),
    prisma.systemHotWallet.findFirst({ where: { id: 1 } }),
    prisma.systemFiatPool.findFirst({ where: { id: 1 } }),
    prisma.systemProfitFees.findFirst({ where: { id: 1 } }),
  ]);

  const cryptoBalance = parseFloat(cryptoWallet?.balance?.toString() || '0');
  const hotWalletBalance = parseFloat(hotWallet?.balance?.toString() || '0');
  const fiatPoolBalance = parseFloat(fiatPool?.balance?.toString() || '0');

  // Reserves = crypto + hot wallet + fiat pool (profit fees are NOT user liabilities)
  const totalReserves = cryptoBalance + hotWalletBalance + fiatPoolBalance;

  // Build Merkle tree of user balance commitments
  // Each leaf: { userId, balanceHash } where balanceHash = SHA256(userId + balance + salt)
  const users = await prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true, availableBalance: true, escrowLockedBalance: true },
  });

  const salt = crypto.randomBytes(16).toString('hex');
  const leaves = users.map(u => ({
    userId: u.id,
    balanceHash: sha256(`${u.id}|${u.availableBalance.toString()}|${u.escrowLockedBalance.toString()}|${salt}`),
  }));

  const merkleTree = buildMerkleTree(leaves);

  // Reserve ratio
  const reserveRatio = totalLiabilities > 0 ? (totalReserves / totalLiabilities) : 1.0;
  const isFullyBacked = reserveRatio >= 1.0;

  return {
    timestamp: new Date().toISOString(),
    totalLiabilities: totalLiabilities.toFixed(8),
    totalReserves: totalReserves.toFixed(8),
    reserveRatio: (reserveRatio * 100).toFixed(2),
    isFullyBacked,
    breakdown: {
      liabilities: {
        available: totalAvailable.toFixed(8),
        escrow: totalEscrow.toFixed(8),
        vendorUnallocated: totalVendorUnallocated.toFixed(8),
        disputeEscrow: totalDisputeEscrow.toFixed(8),
      },
      reserves: {
        systemCrypto: cryptoBalance.toFixed(8),
        hotWallet: hotWalletBalance.toFixed(8),
        fiatPool: fiatPoolBalance.toFixed(8),
      },
    },
    merkleRoot: merkleTree.root,
    userCount: users.length,
    salt,
  };
}

// ── CONTROLLERS ─────────────────────────────────────────────────────────────

// GET /api/proof-of-reserves — Public snapshot
async function getReserveSnapshot(req, res) {
  try {
    const snapshot = await generateSnapshot();

    // Save snapshot to DB for history
    await prisma.proofOfReservesSnapshot.create({
      data: {
        totalLiabilities: parseFloat(snapshot.totalLiabilities),
        totalReserves: parseFloat(snapshot.totalReserves),
        reserveRatio: parseFloat(snapshot.reserveRatio),
        isFullyBacked: snapshot.isFullyBacked,
        userCount: snapshot.userCount,
        merkleRoot: snapshot.merkleRoot,
        salt: snapshot.salt,
        breakdown: snapshot.breakdown,
      },
    });

    // Don't expose salt in public response
    const { salt, ...publicSnapshot } = snapshot;
    return res.json({ success: true, ...publicSnapshot });
  } catch (err) {
    logger.error({ err: err }, '[proofOfReserves] snapshot error');
    return res.status(500).json({ success: false, message: 'Failed to generate reserve snapshot.' });
  }
}

// GET /api/proof-of-reserves/history — Historical snapshots
async function getReserveHistory(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 90);
    const history = await prisma.proofOfReservesSnapshot.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        totalLiabilities: true,
        totalReserves: true,
        reserveRatio: true,
        isFullyBacked: true,
        userCount: true,
        merkleRoot: true,
        createdAt: true,
      },
    });

    return res.json({ success: true, history });
  } catch (err) {
    logger.error({ err: err }, '[proofOfReserves] history error');
    return res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
}

// GET /api/proof-of-reserves/verify — Verify user's balance inclusion (auth required)
async function verifyBalanceInclusion(req, res) {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, availableBalance: true, escrowLockedBalance: true },
    });

    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Get latest snapshot
    const snapshot = await prisma.proofOfReservesSnapshot.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (!snapshot) return res.status(404).json({ success: false, message: 'No snapshot available.' });

    // Regenerate the user's leaf hash
    const balanceHash = sha256(`${user.id}|${user.availableBalance.toString()}|${user.escrowLockedBalance.toString()}|${snapshot.salt}`);

    // Get all users for proof generation (needed to reconstruct the tree)
    const allUsers = await prisma.user.findMany({
      where: { isDeleted: false },
      select: { id: true, availableBalance: true, escrowLockedBalance: true },
      orderBy: { id: 'asc' },
    });

    const leaves = allUsers.map(u => ({
      userId: u.id,
      balanceHash: sha256(`${u.id}|${u.availableBalance.toString()}|${u.escrowLockedBalance.toString()}|${snapshot.salt}`),
    }));

    const userIndex = leaves.findIndex(l => l.userId === userId);
    if (userIndex === -1) return res.status(404).json({ success: false, message: 'Balance not found in snapshot.' });

    const proof = generateMerkleProof(leaves, userIndex);
    const verified = verifyMerkleProof(balanceHash, proof, snapshot.merkleRoot);

    return res.json({
      success: true,
      verified,
      merkleRoot: snapshot.merkleRoot,
      proof,
      snapshotTimestamp: snapshot.createdAt.toISOString(),
      yourBalance: {
        available: user.availableBalance.toString(),
        escrow: user.escrowLockedBalance.toString(),
      },
    });
  } catch (err) {
    logger.error({ err: err }, '[proofOfReserves] verify error');
    return res.status(500).json({ success: false, message: 'Verification failed.' });
  }
}

module.exports = {
  getReserveSnapshot,
  getReserveHistory,
  verifyBalanceInclusion,
  generateSnapshot,
};
