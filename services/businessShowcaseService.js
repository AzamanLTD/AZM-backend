// Adapter: bridges showcaseController to ShowcaseService class
const logger = require('../src/config/logger');
const { ShowcaseService } = require('./marketplace/showcaseService');

exports.addSlide = async (prisma, opts) => {
    const svc = new ShowcaseService(prisma);
    return svc.addMedia(opts);
};

exports.getShowcase = async (prisma, { businessProfileId }) => {
    const svc = new ShowcaseService(prisma);
    return svc.getShowcase(businessProfileId);
};

exports.updateSlide = async (prisma, opts) => {
    const svc = new ShowcaseService(prisma);
    return svc.updateMedia(opts);
};

exports.removeSlide = async (prisma, { slideId, userId }) => {
    const svc = new ShowcaseService(prisma);
    return svc.removeMedia({ mediaId: slideId, userId });
};

exports.reorderSlides = async (prisma, opts) => {
    const svc = new ShowcaseService(prisma);
    return svc.reorder(opts);
};
