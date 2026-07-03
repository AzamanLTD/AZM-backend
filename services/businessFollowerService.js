// Stub for businessFollowerService

exports.followBusiness = async (prisma, { customerId, businessProfileId }) => {
    return { success: true };
};

exports.unfollowBusiness = async (prisma, { customerId, businessProfileId }) => {
    return { success: true };
};

exports.isFollowing = async (prisma, { customerId, businessProfileId }) => {
    return false;
};

exports.getFollowers = async (prisma, { businessProfileId, limit, offset }) => {
    return { followers: [] };
};

exports.getFollowing = async (prisma, { customerId, limit, offset }) => {
    return { following: [] };
};
