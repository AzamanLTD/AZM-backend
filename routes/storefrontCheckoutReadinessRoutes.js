'use strict';

// Fail-closed gate for the financial storefront checkout boundary.
// The production deployment currently converges schema asynchronously during
// boot. Until the integrity overlay is installed, checkout must not create an
// order against a database whose idempotency/inventory guarantees are unknown.
const router = require('express').Router();

router.use('/:businessProfileId/checkout', (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();

  if (req.app.get('retailCheckoutIntegrityReady') !== true) {
    return res.status(503).json({
      success: false,
      message: 'Checkout is temporarily initializing. Please retry shortly.',
      retryable: true,
    });
  }

  return next();
});

module.exports = router;
