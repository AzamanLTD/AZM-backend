// Adapter: bridges adPostController to AdPostService class
//
// FIX (2026-07-06): this whole adapter was broken end-to-end -- every single
// exported function here either called a method that doesn't exist on
// AdPostService, or called a real method with the wrong argument shape:
//   1. `const { AdPostService } = require('./marketplace/adPostService')`
//      destructured a named export that doesn't exist (that file does
//      `module.exports = AdPostService`, a bare class) -- AdPostService was
//      `undefined`, so `new AdPostService(prisma)` threw
//      "AdPostService is not a constructor" on every call.
//   2. createAdPost called `svc.createAd(opts)` -- no such method (real
//      name: `createAdPost`).
//   3. removeAdPost called `svc.deleteAd({ adPostId, userId })` -- no such
//      method (real: `deleteAdPost(adPostId, businessProfileId)`, positional,
//      and authorized against the OWNING business profile, not the raw
//      userId the controller has -- needed a lookup here).
//   4. getActiveAds called `svc.getActiveAds({ businessProfileId, limit })`
//      -- no such method (real: `getActiveAdPosts(businessProfileId)`,
//      positional, no limit param).
//   5. getFeedAds called `svc.getFeed({ userId, limit, offset })` -- no such
//      method (real: `getFeedAdPosts(userId, followedBusinessIds)` --
//      needed the caller's followed business IDs resolved first).
//   6. expireOldAds called `svc.expireOldAds()`, which didn't exist at all
//      on the class (now added).
// This is the same class of bug as businessFollowerService.js: real service
// classes with correct, tested logic, wrapped by adapters nobody ever
// exercised end to end.
const logger = require('../src/config/logger');
const AdPostService = require('./marketplace/adPostService');
const FollowService = require('./marketplace/followService');

exports.createAdPost = async (prisma, { businessProfileId, userId, templateType, title, bodyText, mediaUrl, ctaLabel, ctaTarget }) => {
    const svc = new AdPostService(prisma);
    return svc.createAdPost({ businessProfileId, type: templateType, title, body: bodyText, mediaUrl, ctaLabel, ctaTarget });
};

exports.removeAdPost = async (prisma, { adPostId, userId }) => {
    const business = await prisma.businessProfile.findFirst({
        where: { userId },
        select: { id: true },
    });
    if (!business) throw new Error('Business profile not found.');
    const svc = new AdPostService(prisma);
    return svc.deleteAdPost(adPostId, business.id);
};

exports.getActiveAds = async (prisma, { businessProfileId }) => {
    const svc = new AdPostService(prisma);
    return svc.getActiveAdPosts(businessProfileId);
};

exports.getFeedAds = async (prisma, { customerId, limit, offset }) => {
    const followSvc = new FollowService(prisma);
    const followedBusinessIds = await followSvc.getFollowedBusinessIds(customerId);
    const svc = new AdPostService(prisma);
    const all = await svc.getFeedAdPosts(customerId, followedBusinessIds);
    const take = Math.min(Number(limit) || 20, 50);
    const skip = Number(offset) || 0;
    return { ads: all.slice(skip, skip + take), total: all.length };
};

exports.expireOldAds = async (prisma) => {
    const svc = new AdPostService(prisma);
    return svc.expireOldAds();
};
