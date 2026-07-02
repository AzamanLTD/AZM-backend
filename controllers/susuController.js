// controllers/susuController.js
// =============================================================================
// AZAMAN — SUSU CONTROLLER  (Master Sprint, 2026-05-27)
// =============================================================================

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        console.error(`[susuController] ${fn.name || 'h'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

exports.createSusu = wrap(async function createSusu(req, res) {
    const svc = req.app.get('susuService');
    const { groupChatId, contributionUsdc, frequency, startDate } = req.body;
    const susu = await svc.createSusu({
        adminId: req.user.id,
        groupChatId,
        contributionUsdc,
        frequency,
        startDate,
    });
    res.status(201).json({ success: true, susu });
});

exports.getDetail = wrap(async function getDetail(req, res) {
    const prisma = req.app.get('prisma');
    const susu = await prisma.susuGroup.findUnique({
        where: { id: req.params.id },
        include: {
            members: {
                include: {
                    user: { select: { id: true, username: true, profilePictureUrl: true } },
                },
                orderBy: { cycleSlot: 'asc' },
            },
            cycles: { orderBy: { cycleNumber: 'asc' } },
            groupChat: { select: { id: true, name: true } },
        },
    });
    if (!susu) return res.status(404).json({ success: false, message: 'Susu not found' });

    // Verify caller is a member
    const isMember = susu.members.some((m) => m.userId === req.user.id);
    if (!isMember) return res.status(403).json({ success: false, message: 'Not a member' });

    res.json({ success: true, susu });
});

exports.acceptContract = wrap(async function acceptContract(req, res) {
    const svc = req.app.get('susuService');
    if (!req.body.acceptedSeverityWarning || !req.body.acceptedSeizureClause) {
        return res.status(400).json({
            success: false,
            message: 'Both severity warning and seizure clause must be acknowledged.',
        });
    }
    const result = await svc.acceptContract({
        userId: req.user.id,
        susuGroupId: req.params.id,
    });
    res.json({ success: true, ...result });
});

exports.cancel = wrap(async function cancel(req, res) {
    const svc = req.app.get('susuService');
    await svc.cancel({ adminId: req.user.id, susuGroupId: req.params.id });
    res.json({ success: true });
});

exports.myPosition = wrap(async function myPosition(req, res) {
    const prisma = req.app.get('prisma');
    const member = await prisma.susuMember.findUnique({
        where: { susuGroupId_userId: { susuGroupId: req.params.id, userId: req.user.id } },
        include: {
            susu: {
                include: {
                    cycles: {
                        where: { status: 'PENDING' },
                        orderBy: { collectionDate: 'asc' },
                        take: 5,
                    },
                },
            },
        },
    });
    if (!member) return res.status(404).json({ success: false, message: 'Not a member' });
    res.json({ success: true, member });
});

exports.submitVouch = wrap(async function submitVouch(req, res) {
    const svc = req.app.get('susuService');
    const { vouchRecordId, payload } = req.body;
    const vouch = await svc.submitVouch({
        voucherId: req.user.id,
        vouchRecordId,
        payload,
    });
    res.json({ success: true, vouch });
});

exports.pendingVouches = wrap(async function pendingVouches(req, res) {
    const svc = req.app.get('susuService');
    const vouches = await svc.pendingVouchesFor(req.user.id);
    res.json({ success: true, vouches });
});

// =============================================================================
// B-11: GET /api/susu/payout-timeline
// Returns upcoming payout dates for the caller across all active susu groups.
// =============================================================================
exports.getPayoutTimeline = wrap(async function getPayoutTimeline(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user.id;

    const memberships = await prisma.susuMember.findMany({
        where: { userId, status: 'ACTIVE' },
        include: {
            susu: {
                where: { status: 'ACTIVE' },
                include: {
                    cycles: {
                        where: { status: { in: ['PENDING', 'COLLECTING', 'COLLECTING_GRACE'] } },
                        orderBy: { collectionDate: 'asc' },
                    },
                },
            },
        },
    });

    const timeline = [];
    for (const membership of memberships) {
        for (const cycle of membership.susu.cycles) {
            timeline.push({
                groupId:           membership.susu.id,
                groupName:         membership.susu.id,
                cycleNumber:       cycle.cycleNumber,
                totalCycles:       membership.susu.totalCycles,
                collectionDate:    cycle.collectionDate,
                payoutAmount:      cycle.payoutAmount,
                payoutUserId:      cycle.payoutUserId,
                cycleStatus:       cycle.status,
                contributionUsdc:  membership.susu.contributionUsdc,
                frequency:         membership.susu.frequency,
            });
        }
    }

    timeline.sort((a, b) => new Date(a.collectionDate) - new Date(b.collectionDate));

    res.json({ success: true, timeline, total: timeline.length });
});

exports.getTransparencyReport = wrap(async function getTransparencyReport(req, res) {
    const prisma = req.app.get('prisma');
    const susu = await prisma.susuGroup.findUnique({
        where: { id: req.params.id },
        include: {
            members: {
                include: { user: { select: { id: true, username: true, profilePictureUrl: true } } },
                orderBy: { cycleSlot: 'asc' },
            },
        },
    });
    if (!susu) return res.status(404).json({ success: false, message: 'Susu not found' });

    const isMember = susu.members.some((m) => m.userId === req.user.id);
    if (!isMember) return res.status(403).json({ success: false, message: 'Not a member' });

    const contributions = await prisma.susuContribution.findMany({
        where: { cycle: { susuGroupId: susu.id } },
        select: { userId: true, status: true },
    });

    const report = susu.members.map((m) => {
        const mine = contributions.filter((c) => c.userId === m.userId);
        const onTime = mine.filter((c) => c.status === 'PAID').length;
        const missed = mine.filter((c) => c.status === 'SEIZED' || c.status === 'FAILED_INSUFFICIENT').length;
        const totalTracked = mine.length;
        return {
            userId: m.userId,
            username: m.user.username,
            profilePictureUrl: m.user.profilePictureUrl,
            onTimeCount: onTime,
            missedCount: missed,
            totalTracked,
            // 100% when no cycles have run yet, rather than dividing by zero --
            // a brand-new member shouldn't show as "0% reliable".
            reliabilityPct: totalTracked === 0 ? 100 : Math.round((onTime / totalTracked) * 100),
        };
    });

    res.json({ success: true, groupId: susu.id, report });
});
