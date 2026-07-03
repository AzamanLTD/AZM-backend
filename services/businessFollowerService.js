// Adapter: bridges followController to FollowService class
const { FollowService } = require('./marketplace/followService');

exports.followBusiness = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.follow({ userId: customerId, businessProfileId });
};

exports.unfollowBusiness = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.unfollow({ userId: customerId, businessProfileId });
};

exports.isFollowing = async (prisma, { customerId, businessProfileId }) => {
    const svc = new FollowService(prisma);
    return svc.isFollowing({ userId: customerId, businessProfileId });
};

exports.getFollowers = async (prisma, { businessProfileId, limit, offset }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowers({ businessProfileId, limit, offset });
};

exports.getFollowing = async (prisma, { customerId, limit, offset }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowing({ userId: customerId, limit, offset });
};

exports.getFollowedBusinessIds = async (prisma, { userId }) => {
    const svc = new FollowService(prisma);
    return svc.getFollowedBusinessIds(userId);
};
