// routes/stepUpRoutes.js
// §WP-H G — issue an action-bound step-up capability.
//
// Deliberately NOT behind require2FA(): that middleware would consume the TOTP
// step without binding it to anything, which is the defect this replaces. The
// proof is verified inside the controller so it can be tied to the canonical
// action in the same breath.
'use strict';

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const controller = require('../controllers/stepUpController');

const router = express.Router();
const guard = protectActive || protect;

router.post('/grant', guard, controller.issue);

module.exports = router;
