const express = require('express');
const router = express.Router();
const controller = require('../controllers/sharedVaultController');
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');

const protect = authMiddleware.protect;

router.post('/', protect, idempotency(), controller.create);
router.get('/', protect, controller.list);
router.get('/:id', protect, controller.detail);
router.post('/:id/deposit', protect, idempotency(), controller.deposit);
router.post('/:id/invite', protect, controller.invite);
router.delete('/:id', protect, controller.cancel);

module.exports = router;
