/**
 * Sets `req.prisma` to the shared PrismaClient instance stored on app.
 * Many controllers (marketplace, dine-in, follow, showcase, reservation
 * counter-propose) reference `req.prisma` directly — without this middleware
 * they throw `TypeError: Cannot read properties of undefined`.
 */
module.exports = function prismaInjector(req, _res, next) {
  req.prisma = req.app.get('prisma');
  if (!req.prisma) {
    // Fallback: require the shared singleton directly
    const { prisma } = require('../config/baseServices');
    req.prisma = prisma;
  }
  next();
};
