'use strict';

// Fail-closed gate for the financial storefront checkout boundary.
// The production deployment currently converges schema asynchronously during
// boot. Until the integrity overlay is installed, checkout must not create an
// order against a database whose idempotency/inventory guarantees are unknown.
const router = require('express').Router();

async function findBusiness(prisma, businessProfileId) {
  if (!prisma?.businessProfile?.findUnique) return null;
  return prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: {
      storefrontDisabled: true,
      isSuspended: true,
      isPausedByOwner: true,
    },
  });
}

function unavailable(res) {
  return res.status(404).json({
    success: false,
    message: 'Storefront not available.',
  });
}

// Checkout has an additional production readiness gate, then enforces the same
// storefront availability boundary as public discovery/rendering.
router.use('/:businessProfileId/checkout', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production' && req.app.get('retailCheckoutIntegrityReady') !== true) {
      return res.status(503).json({
        success: false,
        message: 'Checkout is temporarily initializing. Please retry shortly.',
        retryable: true,
      });
    }

    const business = await findBusiness(req.app.get('prisma'), req.params.businessProfileId);
    if (business?.storefrontDisabled || business?.isSuspended || business?.isPausedByOwner) {
      return unavailable(res);
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

// Products and public theme endpoints are part of the public delivery surface.
// They must not continue exposing an admin-disabled, suspended, or owner-paused
// storefront through a previously known business URL.
for (const resource of ['products', 'theme', 'public-theme']) {
  router.use(`/:businessProfileId/${resource}`, async (req, res, next) => {
    try {
      const business = await findBusiness(req.app.get('prisma'), req.params.businessProfileId);
      if (!business || business.storefrontDisabled || business.isSuspended || business.isPausedByOwner) {
        return unavailable(res);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = router;
