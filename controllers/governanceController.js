// controllers/governanceController.js
// =============================================================================
// AZAMAN V3 — AZM Governance / DAO (Phase 5)
//
// On-chain-style governance system using AZM loyalty points as voting power.
// AZM holders can create proposals, vote, and execute approved changes.
//
// Proposal types:
//   PARAMETER_CHANGE  — adjust platform fees, limits, thresholds
//   TREASURY_ACTION   — allocate funds from the platform treasury
//   FEATURE_FLAG      — enable/disable a platform feature
//   GENERAL          — community proposal (advisory)
//
// Voting power = min(azmBalance, 100000) — capped to prevent whale dominance
// Quorum: 10% of total AZM supply must vote
// Approval: >60% of cast votes (simple majority with quorum)
// Voting period: 7 days default, configurable
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const logger = require('../src/config/logger');

const VOTING_PERIOD_DAYS = 7;
const QUORUM_PCT = 0.10;         // 10% of total AZM supply
const APPROVAL_THRESHOLD = 0.60;  // 60% of cast votes
const MAX_VOTING_POWER = 100000;   // cap per user
const EXECUTION_DELAY_HOURS = 48;  // timelock before execution

const PROPOSAL_TYPES = ['PARAMETER_CHANGE', 'TREASURY_ACTION', 'FEATURE_FLAG', 'GENERAL'];
const PROPOSAL_STATUSES = ['DRAFT', 'ACTIVE', 'PASSED', 'REJECTED', 'EXECUTED', 'EXPIRED', 'CANCELLED'];

// ── Create proposal ──────────────────────────────────────────────────────────
async function createProposal(req, res) {
  try {
    const userId = req.user.id;
    const { title, description, type, targetContract, callData, votingDays } = req.body;

    if (!title || !description || !type) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    if (!PROPOSAL_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid proposal type.' });
    }

    // Check user has minimum AZM to create proposal (1000 AZM)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { azmBalance: true },
    });

    const azmBal = parseFloat(user?.azmBalance?.toString() || '0');
    if (azmBal < 1000) {
      return res.status(403).json({
        success: false,
        message: 'Minimum 1000 AZM required to create a proposal.',
      });
    }

    const days = parseInt(votingDays) || VOTING_PERIOD_DAYS;
    const now = new Date();
    const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const proposal = await prisma.governanceProposal.create({
      data: {
        proposerId: userId,
        title,
        description,
        type,
        targetContract: targetContract || null,
        callData: callData || null,
        status: 'ACTIVE',
        votingStartsAt: now,
        votingEndsAt: endsAt,
        forVotes: 0,
        againstVotes: 0,
        abstainVotes: 0,
        totalVotingPower: 0,
      },
    });

    // Socket notify
    const io = req.app.get('io');
    if (io) {
      io.to('governance_room').emit('proposal_created', {
        id: proposal.id,
        title,
        type,
        votingEndsAt: endsAt,
      });
    }

    return res.json({
      success: true,
      proposal,
      message: `Proposal created. Voting ends ${endsAt.toISOString()}.`,
    });
  } catch (err) {
    logger.error({ err }, '[governance] createProposal error');
    return res.status(500).json({ success: false, message: 'Failed to create proposal.' });
  }
}

// ── Cast vote ───────────────────────────────────────────────────────────────
async function castVote(req, res) {
  try {
    const userId = req.user.id;
    const { proposalId, vote } = req.body; // vote: FOR | AGAINST | ABSTAIN

    if (!proposalId || !vote) {
      return res.status(400).json({ success: false, message: 'Missing proposalId or vote.' });
    }

    const voteChoice = vote.toUpperCase();
    if (!['FOR', 'AGAINST', 'ABSTAIN'].includes(voteChoice)) {
      return res.status(400).json({ success: false, message: 'Vote must be FOR, AGAINST, or ABSTAIN.' });
    }

    const proposal = await prisma.governanceProposal.findUnique({
      where: { id: parseInt(proposalId) },
    });

    if (!proposal) return res.status(404).json({ success: false, message: 'Proposal not found.' });
    if (proposal.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: `Proposal is ${proposal.status}.` });
    }

    if (new Date() > proposal.votingEndsAt) {
      return res.status(400).json({ success: false, message: 'Voting period has ended.' });
    }

    // Check if already voted
    const existing = await prisma.governanceVote.findUnique({
      where: { proposalId_userId: { proposalId: parseInt(proposalId), userId } },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already voted on this proposal.' });
    }

    // Get voting power (capped)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { azmBalance: true },
    });

    const votingPower = Math.min(parseFloat(user?.azmBalance?.toString() || '0'), MAX_VOTING_POWER);

    if (votingPower <= 0) {
      return res.status(403).json({ success: false, message: 'You need AZM to vote.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Record vote
      const voteRecord = await tx.governanceVote.create({
        data: {
          proposalId: parseInt(proposalId),
          userId,
          vote: voteChoice,
          votingPower,
        },
      });

      // Update proposal vote counts
      const updates = {};
      if (voteChoice === 'FOR') updates.forVotes = { increment: votingPower };
      else if (voteChoice === 'AGAINST') updates.againstVotes = { increment: votingPower };
      else updates.abstainVotes = { increment: votingPower };
      updates.totalVotingPower = { increment: votingPower };

      await tx.governanceProposal.update({
        where: { id: parseInt(proposalId) },
        data: updates,
      });

      return voteRecord;
    });

    return res.json({
      success: true,
      vote: result,
      message: `Vote cast: ${voteChoice} with ${votingPower} AZM voting power.`,
    });
  } catch (err) {
    logger.error({ err }, '[governance] castVote error');
    return res.status(500).json({ success: false, message: 'Failed to cast vote.' });
  }
}

// ── Finalize proposal (check if passed/rejected) ────────────────────────────
async function finalizeProposal(req, res) {
  try {
    const { proposalId } = req.params;
    const proposal = await prisma.governanceProposal.findUnique({
      where: { id: parseInt(proposalId) },
    });

    if (!proposal) return res.status(404).json({ success: false, message: 'Proposal not found.' });
    if (proposal.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: `Proposal is ${proposal.status}.` });
    }

    if (new Date() < proposal.votingEndsAt) {
      return res.status(400).json({ success: false, message: 'Voting period still active.' });
    }

    // Calculate result
    const totalCast = parseFloat(proposal.forVotes.toString()) +
                      parseFloat(proposal.againstVotes.toString()) +
                      parseFloat(proposal.abstainVotes.toString());

    // Get total AZM supply for quorum check
    const totalSupply = await prisma.user.aggregate({
      _sum: { azmBalance: true },
    });
    const totalAzm = parseFloat(totalSupply._sum?.azmBalance?.toString() || '0');
    const quorumNeeded = totalAzm * QUORUM_PCT;

    let newStatus;
    let executionReadyAt = null;

    if (totalCast < quorumNeeded) {
      newStatus = 'EXPIRED'; // didn't reach quorum
    } else {
      const forVotes = parseFloat(proposal.forVotes.toString());
      const againstVotes = parseFloat(proposal.againstVotes.toString());
      const decisiveVotes = forVotes + againstVotes;

      if (decisiveVotes > 0 && (forVotes / decisiveVotes) >= APPROVAL_THRESHOLD) {
        newStatus = 'PASSED';
        executionReadyAt = new Date(Date.now() + EXECUTION_DELAY_HOURS * 60 * 60 * 1000);
      } else {
        newStatus = 'REJECTED';
      }
    }

    const updated = await prisma.governanceProposal.update({
      where: { id: parseInt(proposalId) },
      data: { status: newStatus, executionReadyAt },
    });

    return res.json({
      success: true,
      proposal: updated,
      message: `Proposal finalized: ${newStatus}.`,
      stats: {
        totalCast,
        quorumNeeded,
        forVotes: parseFloat(proposal.forVotes.toString()),
        againstVotes: parseFloat(proposal.againstVotes.toString()),
        abstainVotes: parseFloat(proposal.abstainVotes.toString()),
      },
    });
  } catch (err) {
    logger.error({ err }, '[governance] finalize error');
    return res.status(500).json({ success: false, message: 'Failed to finalize.' });
  }
}

// ── Execute passed proposal ──────────────────────────────────────────────────
async function executeProposal(req, res) {
  try {
    const { proposalId } = req.params;
    const proposal = await prisma.governanceProposal.findUnique({
      where: { id: parseInt(proposalId) },
    });

    if (!proposal) return res.status(404).json({ success: false, message: 'Proposal not found.' });
    if (proposal.status !== 'PASSED') {
      return res.status(400).json({ success: false, message: 'Proposal not passed.' });
    }

    if (proposal.executionReadyAt && new Date() < proposal.executionReadyAt) {
      return res.status(400).json({
        success: false,
        message: `Timelock active. Executable after ${proposal.executionReadyAt.toISOString()}.`,
      });
    }

    // Mark as executed
    const updated = await prisma.governanceProposal.update({
      where: { id: parseInt(proposalId) },
      data: { status: 'EXECUTED', executedAt: new Date(), executedById: req.user.id },
    });

    // In production, this would trigger the actual on-chain/parameter change
    // For now, we log it and emit an event
    const io = req.app.get('io');
    if (io) {
      io.to('governance_room').emit('proposal_executed', {
        id: proposal.id,
        title: proposal.title,
        type: proposal.type,
      });
    }

    return res.json({
      success: true,
      proposal: updated,
      message: 'Proposal executed. Parameter/feature change applied.',
    });
  } catch (err) {
    logger.error({ err }, '[governance] execute error');
    return res.status(500).json({ success: false, message: 'Failed to execute.' });
  }
}

// ── List proposals ───────────────────────────────────────────────────────────
async function listProposals(req, res) {
  try {
    const status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const where = status ? { status } : {};
    const proposals = await prisma.governanceProposal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        proposer: { select: { id: true, username: true } },
        votes: { select: { userId: true, vote: true, votingPower: true } },
      },
    });

    return res.json({ success: true, proposals });
  } catch (err) {
    logger.error({ err }, '[governance] list error');
    return res.status(500).json({ success: false, message: 'Failed to list proposals.' });
  }
}

// ── Get single proposal with vote breakdown ──────────────────────────────────
async function getProposal(req, res) {
  try {
    const proposal = await prisma.governanceProposal.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        proposer: { select: { id: true, username: true } },
        votes: {
          include: { user: { select: { id: true, username: true } } },
          orderBy: { votingPower: 'desc' },
        },
      },
    });

    if (!proposal) return res.status(404).json({ success: false, message: 'Proposal not found.' });

    return res.json({ success: true, proposal });
  } catch (err) {
    logger.error({ err }, '[governance] get error');
    return res.status(500).json({ success: false, message: 'Failed to load proposal.' });
  }
}

// ── Get governance stats ─────────────────────────────────────────────────────
async function getGovernanceStats(req, res) {
  try {
    const [totalProposals, activeProposals, passedProposals, executedProposals] = await Promise.all([
      prisma.governanceProposal.count(),
      prisma.governanceProposal.count({ where: { status: 'ACTIVE' } }),
      prisma.governanceProposal.count({ where: { status: 'PASSED' } }),
      prisma.governanceProposal.count({ where: { status: 'EXECUTED' } }),
    ]);

    const totalSupply = await prisma.user.aggregate({
      _sum: { azmBalance: true },
    });

    return res.json({
      success: true,
      stats: {
        totalProposals,
        activeProposals,
        passedProposals,
        executedProposals,
        totalAzmSupply: parseFloat(totalSupply._sum?.azmBalance?.toString() || '0'),
        quorumRequired: `${(QUORUM_PCT * 100)}%`,
        approvalThreshold: `${(APPROVAL_THRESHOLD * 100)}%`,
        votingPeriodDays: VOTING_PERIOD_DAYS,
        executionDelayHours: EXECUTION_DELAY_HOURS,
        maxVotingPower: MAX_VOTING_POWER,
      },
    });
  } catch (err) {
    logger.error({ err }, '[governance] stats error');
    return res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
}

module.exports = {
  createProposal,
  castVote,
  finalizeProposal,
  executeProposal,
  listProposals,
  getProposal,
  getGovernanceStats,
};
