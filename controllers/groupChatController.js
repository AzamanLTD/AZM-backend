// controllers/groupChatController.js
// =============================================================================
// AZAMAN — GROUP CHAT CONTROLLER  (Master Sprint, 2026-05-27)
// =============================================================================

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[groupChatController] ${fn.name || 'h'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

exports.create = wrap(async function create(req, res) {
    const svc = req.app.get('groupChatService');
    const { name, description, avatarUrl, initialMemberIds = [], adminIds = [] } = req.body;
    const group = await svc.createGroup({
        creatorId: req.user.id,
        name, description, avatarUrl,
        initialMemberIds: initialMemberIds.map(Number),
        adminIds: adminIds.map(Number),
    });
    res.status(201).json({ success: true, group });
});

exports.list = wrap(async function list(req, res) {
    const svc = req.app.get('groupChatService');
    const groups = await svc.listForUser(req.user.id);
    res.json({ success: true, groups });
});

exports.getDetail = wrap(async function getDetail(req, res) {
    const svc = req.app.get('groupChatService');
    const group = await svc.getDetail(req.user.id, req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
    res.json({ success: true, group });
});

exports.update = wrap(async function update(req, res) {
    const svc = req.app.get('groupChatService');
    const group = await svc.updateGroup(req.user.id, req.params.id, req.body);
    res.json({ success: true, group });
});

exports.addMember = wrap(async function addMember(req, res) {
    const svc = req.app.get('groupChatService');
    const { userId, phone, role, vouch } = req.body;
    const member = await svc.addMember(req.user.id, req.params.id, {
        userId: userId ? Number(userId) : null,
        phone: phone || null,
        role,
        vouchPayload: vouch,
    });
    res.status(201).json({ success: true, member });
});

exports.removeMember = wrap(async function removeMember(req, res) {
    const svc = req.app.get('groupChatService');
    await svc.removeMember(req.user.id, req.params.id, Number(req.params.userId), req.body.reason);
    res.json({ success: true });
});

exports.setRole = wrap(async function setRole(req, res) {
    const svc = req.app.get('groupChatService');
    const { role } = req.body;
    const member = await svc.setRole(req.user.id, req.params.id, Number(req.params.userId), role);
    res.json({ success: true, member });
});

exports.listMessages = wrap(async function listMessages(req, res) {
    const svc = req.app.get('groupChatService');
    const result = await svc.listMessages({
        groupId: req.params.id,
        userId: req.user.id,
        cursor: req.query.cursor,
        limit: parseInt(req.query.limit, 10) || 30,
    });
    res.json({ success: true, ...result });
});

exports.sendMessage = wrap(async function sendMessage(req, res) {
    const svc = req.app.get('groupChatService');
    const msg = await svc.sendMessage({
        groupId: req.params.id,
        senderId: req.user.id,
        type: req.body.type || 'TEXT',
        content: req.body.content,
        metadata: req.body.metadata,
        media: req.body.media,
    });
    res.status(201).json({ success: true, message: msg });
});

// ── PHASE 5 / Workstream D: Group-chat-first Susu initiation ──────────────

exports.initiateSusu = wrap(async function initiateSusu(req, res) {
    const svc = req.app.get('susuInitiationService');
    const { contributionUsdc, frequency, windowHours } = req.body;
    const susu = await svc.initiate({
        groupId: req.params.id,
        initiatorId: req.user.id,
        contributionUsdc,
        frequency,
        windowHours: windowHours != null ? Number(windowHours) : 72,
    });
    res.status(201).json({ success: true, susu });
});

exports.getInitiationStatus = wrap(async function getInitiationStatus(req, res) {
    const svc = req.app.get('susuInitiationService');
    const status = await svc.getInitiationStatus({
        groupId: req.params.id,
        viewerId: req.user.id,
    });
    res.json({ success: true, ...status });
});

exports.cancelInitiation = wrap(async function cancelInitiation(req, res) {
    const svc = req.app.get('susuInitiationService');
    const result = await svc.cancelInitiation({
        groupId: req.params.id,
        actorId: req.user.id,
    });
    res.json({ success: true, ...result });
});

// PHASE 6 / Phase 4 — vouch for an unvouched member during initiation.
exports.vouchMember = wrap(async function vouchMember(req, res) {
    const svc = req.app.get('susuInitiationService');
    const { targetUserId } = req.body;
    const result = await svc.vouchMember({
        groupId: req.params.id,
        voucherId: req.user.id,
        targetUserId: Number(targetUserId),
    });
    res.json({ success: true, ...result });
});

// ── PHASE 6 / Group Membership & Vouching ─────────────────────────────────
// These use the canonical envelope { success, data } / { success, message,
// errorCode } and map GroupError instances to their httpStatus + code.

function gjrFail(res, err) {
    if (err && err.name === 'GroupError') {
        return res.status(err.httpStatus || 400).json({
            success: false, message: err.message, errorCode: err.code,
            ...(err.fields ? { fields: err.fields } : {}),
        });
    }
    logger.error({ err: err }, '[groupChatController] gjr');
    return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL' });
}
const gjrWrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { gjrFail(res, e); } };

// POST /api/groups/:id/join-requests — member proposes one or more adds.
exports.proposeJoinRequests = gjrWrap(async function proposeJoinRequests(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const { targetUserIds, targetUserId, note } = req.body;
    const ids = Array.isArray(targetUserIds)
        ? targetUserIds
        : (targetUserId != null ? [targetUserId] : []);
    const result = await svc.propose({
        groupId: req.params.id,
        proposerId: req.user.id,
        targetUserIds: ids.map(Number),
        note: note || null,
    });
    res.status(201).json({ success: true, data: result });
});

// GET /api/groups/:id/join-requests — admin lists PENDING requests.
exports.listJoinRequests = gjrWrap(async function listJoinRequests(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const requests = await svc.listPending(req.params.id, req.user.id);
    res.json({ success: true, data: { requests } });
});

// POST /api/groups/:id/join-requests/:reqId/approve — admin approves.
exports.approveJoinRequest = gjrWrap(async function approveJoinRequest(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const result = await svc.approve(req.params.reqId, req.user.id);
    res.json({ success: true, data: result });
});

// POST /api/groups/:id/join-requests/:reqId/reject — admin rejects.
exports.rejectJoinRequest = gjrWrap(async function rejectJoinRequest(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const result = await svc.reject(req.params.reqId, req.user.id);
    res.json({ success: true, data: result });
});

// POST /api/groups/:id/members/direct — admin direct add within quota.
exports.directAddMember = gjrWrap(async function directAddMember(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const result = await svc.adminDirectAdd({
        groupId: req.params.id,
        adminId: req.user.id,
        targetUserId: Number(req.body.targetUserId ?? req.body.userId),
    });
    res.status(201).json({ success: true, data: result });
});

// GET /api/groups/:id/add-quota — admin's current usage + ceiling.
exports.getAddQuota = gjrWrap(async function getAddQuota(req, res) {
    const svc = req.app.get('groupJoinRequestService');
    const quota = await svc.getAddQuota(req.params.id, req.user.id);
    res.json({ success: true, data: quota });
});

// =============================================================================
// PHASE 6 / Premium Group Chat Features
// =============================================================================

exports.getGroupMessagesPaginated = async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { groupId } = req.params;
    const { cursor, limit = 50 } = req.query;
    const userId = req.user.id;

    // Verify membership
    const member = await prisma.groupMember.findFirst({
      where: { groupId, userId, removedAt: null }
    });
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const query = {
      where: { groupId },
      take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, username: true, profilePictureUrl: true } }
      }
    };

    if (cursor) {
      query.cursor = { id: cursor };
      query.skip = 1;
    }

    const messages = await prisma.groupMessage.findMany(query);
    const nextCursor = messages.length === parseInt(limit) ? messages[messages.length - 1].id : null;

    res.json({ success: true, messages, nextCursor });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
};

exports.getGroupReadStatus = async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { groupId } = req.params;
    const cursors = await prisma.groupReadCursor.findMany({
      where: { groupId },
      include: { user: { select: { id: true, username: true } } }
    });
    res.json({ success: true, cursors });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
};
