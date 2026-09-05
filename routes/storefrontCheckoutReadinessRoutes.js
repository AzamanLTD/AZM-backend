'use strict';

// Fail-closed gate for the financial storefront checkout boundary.
// The production deployment currently converges schema asynchronously during
// boot. Until the integrity overlay is installed, checkout must not create an
// order against a database whose idempotency/inventory guarantees are unknown.
const router = require('express').Router();

router.use('/:businessProfileId/checkout', async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production' && req.app.get('retailCheckoutIntegrityReady') !== true) {
      return res.status(503).json({
        success: false,
        message: 'Checkout is temporarily initializing. Please retry shortly.',
        retryable: true,
      });
    }

    // Administrative storefront disablement is a delivery-boundary decision,
    // not merely a rendering hint. Reject checkout before the legacy order
    // creator can accept a request against a storefront that public render and
    // discovery intentionally treat as unavailable.
    const prisma = req.app.get('prisma');
    if (prisma?.businessProfile?.findUnique) {
      const business = await prisma.businessProfile.findUnique({
        where: { id: req.params.businessProfileId },
        select: { storefrontDisabled: true },
      });
      if (business?.storefrontDisabled) {
        return res.status(404).json({
          success: false,
          message: 'Storefront not available.',
        });
      }
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
