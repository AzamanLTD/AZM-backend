// routes/billsRoutes.js
// =============================================================================
// Bills & Top-ups — saved-account surface only.
//
// Deliberately absent: quote, order, pay, lookup, receipt. Those require a
// signed provider contract and an approved source of funds; until then there is
// nothing here that can move money.
// =============================================================================

const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/billsSavedAccountController');
const { protect } = require('../middleware/authMiddleware');

// Templates describe what may be SAVED, not what is payable. Every capability
// flag comes from the server registry so clients cannot infer payment support.
router.get('/service-templates', protect, ctrl.getServiceTemplates);

router.get('/saved-accounts', protect, ctrl.listSavedAccounts);
router.post('/saved-accounts', protect, ctrl.createSavedAccount);
router.patch('/saved-accounts/:id', protect, ctrl.updateSavedAccount);
router.delete('/saved-accounts/:id', protect, ctrl.deleteSavedAccount);

module.exports = router;
