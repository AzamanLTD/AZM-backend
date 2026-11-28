// services/businessActor.js
// =============================================================================
// Who is acting for which business, and with what rights.
//
// Most of a business's daily work is done by staff, not the owner. A handler
// that needs "the business" must not look it up by the caller's own user id
// (that is the owner only); it resolves the actor here:
//
//   resolveBusinessActor(prisma, user, { anyOf })
//     → { businessProfileId, ownerUserId, actorUserId, isOwner, permissions }
//     → null when the caller is neither the owner nor an ACTIVE employee,
//       or holds none of `anyOf` (when given).
//
// The owner holds every right ('*'). An employee holds their stored
// permissions (middleware/requirePermission resolvePermissions), and only
// while ACTIVE (resolveBusinessContext resolves ACTIVE employment only).
// =============================================================================

const { resolveBusinessContext, resolvePermissions } = require('../middleware/requirePermission');

const has = (permissions, keys) => Boolean(permissions && (permissions.includes('*')
    || (keys || []).some((k) => permissions.includes(k))));

const resolveBusinessActor = async (prisma, user, { anyOf = [] } = {}) => {
    if (!user || !user.id) return null;
    const context = await resolveBusinessContext(prisma, user);
    if (!context || !context.businessProfileId) return null;
    const business = await prisma.businessProfile.findUnique({
        where: { id: context.businessProfileId },
        select: { id: true, userId: true },
    });
    if (!business) return null;
    const isOwner = business.userId === user.id;
    const permissions = isOwner ? ['*'] : await resolvePermissions(prisma, user.id, business.id);
    if (!isOwner && (!permissions || permissions.length === 0)) return null;
    if (anyOf.length && !has(permissions, anyOf)) return null;
    return {
        businessProfileId: business.id,
        ownerUserId: business.userId,
        actorUserId: user.id,
        isOwner,
        permissions,
    };
};

module.exports = { resolveBusinessActor, hasPermission: has };
