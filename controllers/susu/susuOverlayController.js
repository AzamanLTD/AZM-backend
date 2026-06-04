// controllers/susu/susuOverlayController.js
// =============================================================================
// HTTP boundary for the additive Susu ecosystem features. Lives alongside the
// legacy controllers/susuController.js. Each handler is a thin wrapper that
// delegates to the relevant service and maps SusuError instances to the
// canonical envelope.
// =============================================================================

const { SusuError } = require('../../services/susu/errors');
const susuSchemas = require('../../services/validation/susuSchemas');

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, err) {
  if (err instanceof SusuError) {
    const body = {
      success: false,
      message: err.message,
      errorCode: err.code,
    };
    if (err.fields) body.fields = err.fields;
    return res.status(err.httpStatus || 400).json(body);
  }
  // Unknown error — log + generic envelope
  console.error('[susuOverlayController] unhandled:', err);
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
    errorCode: 'INTERNAL',
  });
}

const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    fail(res, err);
  }
};

// ── CREATE / CANCEL ─────────────────────────────────────────────────

exports.createSusu = wrap(async (req, res) => {
  const parsed = susuSchemas.createSusuSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new SusuError('SUSU_VALIDATION_FAILED', 'Validation failed', 400, parsed.error.flatten().fieldErrors);
  }
  const svc = req.app.get('susuOverlayService');
  const susu = await svc.createSusuStandalone({
    initiatorId: req.user.id,
    ...parsed.data,
  });
  ok(res, { susu }, 201);
});

exports.cancelSusu = wrap(async (req, res) => {
  const svc = req.app.get('susuOverlayService');
  const susu = await svc.cancelWithVouchVoid({
    susuGroupId: req.params.id,
    callerId: req.user.id,
  });
  ok(res, { susu });
});

// ── INVITES ─────────────────────────────────────────────────────────

exports.createInvite = wrap(async (req, res) => {
  const parsed = susuSchemas.createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new SusuError('SUSU_VALIDATION_FAILED', 'Validation failed', 400, parsed.error.flatten().fieldErrors);
  }
  const svc = req.app.get('susuInviteService');
  const invite = await svc.createInvite({
    susuGroupId: req.params.id,
    inviterId: req.user.id,
    ...parsed.data,
  });
  ok(res, { invite }, 201);
});

exports.previewInvite = wrap(async (req, res) => {
  const svc = req.app.get('susuInviteService');
  const data = await svc.previewByToken(req.params.token);
  ok(res, data);
});

exports.redeemInvite = wrap(async (req, res) => {
  const svc = req.app.get('susuInviteService');
  const member = await svc.redeemLinkInvite(req.params.token, req.user.id);
  ok(res, { member }, 201);
});

exports.acceptInvite = wrap(async (req, res) => {
  const svc = req.app.get('susuInviteService');
  const member = await svc.acceptInvite(req.params.id, req.user.id);
  ok(res, { member }, 201);
});

exports.declineInvite = wrap(async (req, res) => {
  const svc = req.app.get('susuInviteService');
  const invite = await svc.declineInvite(req.params.id, req.user.id);
  ok(res, { invite });
});

exports.revokeInvite = wrap(async (req, res) => {
  const svc = req.app.get('susuInviteService');
  const invite = await svc.revokeInvite(req.params.id, req.user.id);
  ok(res, { invite });
});

// ── CONTRACT ────────────────────────────────────────────────────────

exports.getActiveContract = wrap(async (req, res) => {
  const svc = req.app.get('liabilityContractService');
  const contract = await svc.getActiveContract();
  ok(res, { contract });
});

exports.getContractForSusu = wrap(async (req, res) => {
  // Privacy gate: only members may view the per-Susu pinned contract.
  const overlay = req.app.get('susuOverlayService');
  await overlay.assertVisibleToCaller(req.params.id, req.user.id, { allowInitiatorWhileConfiguring: true });
  const svc = req.app.get('liabilityContractService');
  const contract = await svc.getContractForSusu(req.params.id);
  ok(res, { contract });
});

exports.acceptContract = wrap(async (req, res) => {
  const parsed = susuSchemas.acceptContractSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new SusuError('SUSU_VALIDATION_FAILED', 'Validation failed', 400, parsed.error.flatten().fieldErrors);
  }

  const prisma = req.app.get('prisma');
  const liab = req.app.get('liabilityContractService');
  const member = req.app.get('susuMemberService');
  const overlay = req.app.get('susuOverlayService');

  const result = await prisma.$transaction(async (tx) => {
    // Caller must be a SusuMember of this Susu and currently in PENDING_CONTRACT
    const memberRow = await tx.susuMember.findUnique({
      where: { susuGroupId_userId: { susuGroupId: req.params.id, userId: req.user.id } },
    });
    if (!memberRow) throw new SusuError('SUSU_NOT_FOUND', 'Not found', 404);
    if (memberRow.status === 'PENDING_VOUCH') {
      throw new SusuError('KYC_OR_RESIDENCY_PENDING', 'Complete KYC and Proof of Residency first.', 409);
    }
    if (memberRow.status !== 'PENDING_CONTRACT' && memberRow.status !== 'ACTIVE') {
      throw new SusuError('SUSU_VALIDATION_FAILED', `Cannot accept contract from ${memberRow.status}.`, 409);
    }

    const acceptance = await liab.acceptContract(
      {
        userId: req.user.id,
        susuGroupId: req.params.id,
        contractVersion: parsed.data.contractVersion,
        contractHash: parsed.data.contractHash,
        agreed: parsed.data.agreed,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
      },
      tx,
    );

    if (memberRow.status === 'PENDING_CONTRACT') {
      await member.transitionToActive(memberRow.id, tx);
    }

    // Try to activate the parent Susu in the same transaction
    const susu = await overlay.activateSusuIfReady(req.params.id, tx);
    return { acceptance, susu };
  });

  ok(res, result);
});

exports.publishContract = wrap(async (req, res) => {
  const svc = req.app.get('liabilityContractService');
  const contract = await svc.publishNewVersion({
    adminUserId: req.user.id,
    version: req.body?.version,
    body: req.body?.body,
  });
  ok(res, { contract }, 201);
});

// ── READ ────────────────────────────────────────────────────────────

exports.listMine = wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const rows = await prisma.susuGroup.findMany({
    where: {
      members: { some: { userId: req.user.id } },
    },
    include: {
      members: { where: { userId: req.user.id }, select: { id: true, status: true, cycleSlot: true } },
      cycles: {
        where: { status: 'PENDING' },
        orderBy: { cycleNumber: 'asc' },
        take: 1,
      },
      groupChat: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  ok(res, { susus: rows });
});

exports.getSusuDetail = wrap(async (req, res) => {
  const overlay = req.app.get('susuOverlayService');
  await overlay.assertVisibleToCaller(req.params.id, req.user.id);
  const prisma = req.app.get('prisma');
  const susu = await prisma.susuGroup.findUnique({
    where: { id: req.params.id },
    include: {
      groupChat: { select: { id: true, name: true } },
      members: {
        select: {
          id: true, userId: true, cycleSlot: true, status: true,
          autoRetainNextCycle: true,
          user: { select: { username: true, profilePictureUrl: true } },
        },
        orderBy: { cycleSlot: 'asc' },
      },
      cycles: {
        select: {
          id: true, cycleNumber: true, collectionDate: true, status: true,
          payoutUserId: true, paidOutAt: true, escrowDivertedAt: true,
          graceUntil: true,
        },
        orderBy: { cycleNumber: 'asc' },
      },
    },
  });
  ok(res, { susu });
});

exports.listMembers = wrap(async (req, res) => {
  const overlay = req.app.get('susuOverlayService');
  await overlay.assertVisibleToCaller(req.params.id, req.user.id, { allowInitiatorWhileConfiguring: false });
  const prisma = req.app.get('prisma');
  const members = await prisma.susuMember.findMany({
    where: { susuGroupId: req.params.id },
    select: {
      id: true,
      cycleSlot: true,
      status: true,
      user: { select: { username: true, profilePictureUrl: true } },
    },
    orderBy: { cycleSlot: 'asc' },
  });
  // Expose only the whitelist (Req 5.4 / Property 15)
  const projected = members.map(m => ({
    susuMemberId: m.id,
    displayName: m.user.username,
    avatar: m.user.profilePictureUrl,
    payoutSlot: m.cycleSlot || null,
    status: m.status,
  }));
  ok(res, { members: projected });
});

exports.listCycles = wrap(async (req, res) => {
  const overlay = req.app.get('susuOverlayService');
  await overlay.assertVisibleToCaller(req.params.id, req.user.id, { allowInitiatorWhileConfiguring: false });
  const prisma = req.app.get('prisma');
  const cycles = await prisma.susuCycle.findMany({
    where: { susuGroupId: req.params.id },
    orderBy: { cycleNumber: 'asc' },
    select: {
      id: true, cycleNumber: true, collectionDate: true, status: true,
      payoutUserId: true, paidOutAt: true, escrowDivertedAt: true,
      payoutAmount: true, graceUntil: true,
    },
  });
  ok(res, { cycles });
});

// ── PHASE 5 / Workstream B: auto-retain opt-in ──────────────────────
// POST /api/susu/:id/auto-retain  { enabled: boolean }
// Sets the caller's SusuMember.autoRetainNextCycle flag so the cycle
// funding logic keeps the next contribution reserved after a payout.
exports.setAutoRetain = wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const enabled = req.body?.enabled === true;
  const member = await prisma.susuMember.findUnique({
    where: { susuGroupId_userId: { susuGroupId: req.params.id, userId: req.user.id } },
    select: { id: true },
  });
  if (!member) {
    throw new SusuError('SUSU_NOT_FOUND', 'Not found', 404);
  }
  await prisma.susuMember.update({
    where: { id: member.id },
    data: { autoRetainNextCycle: enabled },
  });
  ok(res, { autoRetainNextCycle: enabled });
});
