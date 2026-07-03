// Adapter: bridges adPostController to AdPostService class
const { AdPostService } = require('./marketplace/adPostService');

exports.createAdPost = async (prisma, opts) => {
    const svc = new AdPostService(prisma);
    return svc.createAd(opts);
};

exports.removeAdPost = async (prisma, { adPostId, userId }) => {
    const svc = new AdPostService(prisma);
    return svc.deleteAd({ adPostId, userId });
};

exports.getActiveAds = async (prisma, { businessProfileId, limit }) => {
    const svc = new AdPostService(prisma);
    return svc.getActiveAds({ businessProfileId, limit });
};

exports.getFeedAds = async (prisma, { customerId, limit, offset }) => {
    const svc = new AdPostService(prisma);
    return svc.getFeed({ userId: customerId, limit, offset });
};

exports.expireOldAds = async (prisma) => {
    const svc = new AdPostService(prisma);
    return svc.expireOldAds();
};
