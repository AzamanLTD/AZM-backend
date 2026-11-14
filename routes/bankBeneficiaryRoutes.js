const express = require('express');
const router = express.Router();

// Saved BANK payout beneficiaries (issue #389 section 4). Owner-scoped: every
// handler filters on req.user.id, so a caller can never read, reveal or delete
// another customer's payee. The account number is write-only from the client's
// point of view — no GET ever returns it, masked tail only.
const authMiddleware = require('../middleware/authMiddleware');
const { require2FA } = require('../middleware/require2FA');
const { validate } = require('../middleware/validate');
const { bankBeneficiarySchema, bankBeneficiaryUpdateSchema } = require('../services/validation/financialSchemas');
const controller = require('../controllers/bankBeneficiaryController');

const protect = authMiddleware.protect;

router.get('/', protect, controller.list);

// The provider's bank directory. Read-only and cheap, so no 2FA: a customer must
// be able to see which banks are payable before committing to one.
router.get('/banks', protect, controller.banks);

router.post('/',
    protect,
    require2FA(),
    validate(bankBeneficiarySchema),
    controller.create);

// Presentation-only update (nickname / primary). The destination itself is
// immutable, so this can never silently redirect a verified payee.
router.patch('/:id',
    protect,
    require2FA(),
    validate(bankBeneficiaryUpdateSchema),
    controller.update);

// Re-run provider validation against the stored account number.
router.post('/:id/validate', protect, require2FA(), controller.revalidate);

router.delete('/:id', protect, require2FA(), controller.remove);

module.exports = router;
