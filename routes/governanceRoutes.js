const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const gov = require('../controllers/governanceController');

const protect = authMiddleware.protect;

router.get('/',                    protect, gov.listProposals);
router.get('/stats',               protect, gov.getGovernanceStats);
router.post('/',                  protect, gov.createProposal);
router.get('/:id',               protect, gov.getProposal);
router.post('/vote',             protect, gov.castVote);
router.post('/:id/finalize',     protect, gov.finalizeProposal);
router.post('/:id/execute',      protect, gov.executeProposal);

module.exports = router;
