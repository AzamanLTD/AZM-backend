// Adapter: bridges followController to FollowService class
//
// FIX (2026-07-06): this whole adapter was broken end-to-end and would have
// thrown on every single call made through the real REST API:
//   1. `const { FollowService } = require('./marketplace/followService')`
//      destructured a named export that doesn't exist -- followService.js
//      does `module.exports = FollowService` (a bare class), so
//      `FollowService` here was `undefined`, and `new FollowService(prisma)`
//      threw "FollowService is not a constructor" immediately.
//   2. Even with the import fixed, every method below called the real
//      service with a single `{ userId, businessProfileId }` object, but
//      FollowService.follow/unfollow/isFollowing all take TWO separate
//      positional arguments -- so `userId` would receive the whole object
//      and `businessProfileId` would be `undefined`.
// This was never caught by the existing test suite because
// __tests__/marketplace-v2.test.js instantiates FollowService directly and
// calls it with correct positional args, bypassing this adapter (and
// therefore the controller/route layer the live app actually uses)
// entirely. Follow/unfollow via the real API has been fully broken since
// this file was written.
const FollowService = require('./marketplace/followService');

exports.followBusiness = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.follow(customerId, businessProfileId);
};

exports.unfollowBusiness = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.unfollow(customerId, businessProfileId);
};

exports.isFollowing = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.isFollowing(customerId, businessProfileId);
};

exports.getFollowers = async (prisma, { businessProfileId, limit, offset }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowers(businessProfileId, { limit, offset });
};

exports.getFollowing = async (prisma, { customerId, limit, offset }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowing(customerId, { limit, offset });
};

exports.getFollowedBusinessIds = async (prisma, { userId }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowedBusinessIds(userId);
};
