// routes/groupChatRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/groupChatController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

router.post('/',                          protectActive, ctrl.create);
router.get('/',                           protect,       ctrl.list);
router.get('/:id',                        protect,       ctrl.getDetail);
router.patch('/:id',                      protectActive, ctrl.update);

router.post('/:id/members',               protectActive, ctrl.addMember);
router.delete('/:id/members/:userId',     protectActive, ctrl.removeMember);
router.put('/:id/members/:userId/role',   protectActive, ctrl.setRole);

router.get('/:id/messages',               protect,       ctrl.listMessages);
router.post('/:id/messages',              protectActive, ctrl.sendMessage);

// PHASE 5 / Workstream D — group-chat-first Susu initiation
router.post('/:id/susu/initiate',         protectActive, ctrl.initiateSusu);
router.get('/:id/susu/status',            protect,       ctrl.getInitiationStatus);
router.post('/:id/susu/cancel',           protectActive, ctrl.cancelInitiation);
// PHASE 6 / Phase 4 — vouch for an unvouched member during initiation
router.post('/:id/susu/vouch',            protectActive, ctrl.vouchMember);

// PHASE 6 — Group membership & vouching (member-proposed adds, admin quota)
router.post('/:id/join-requests',                 protectActive, ctrl.proposeJoinRequests);
router.get('/:id/join-requests',                  protect,       ctrl.listJoinRequests);
router.post('/:id/join-requests/:reqId/approve',  protectActive, ctrl.approveJoinRequest);
router.post('/:id/join-requests/:reqId/reject',   protectActive, ctrl.rejectJoinRequest);
router.post('/:id/members/direct',                protectActive, ctrl.directAddMember);
router.get('/:id/add-quota',                      protect,       ctrl.getAddQuota);

// PHASE 6 / Premium Group Chat Features
router.get('/:groupId/messages-v2',               protect,       ctrl.getGroupMessagesPaginated);
router.get('/:groupId/read-status',               protect,       ctrl.getGroupReadStatus);

module.exports = router;
