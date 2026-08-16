// src/services/registry.js
// =============================================================================
// Extracted from server.js — instantiates and registers all application
// services onto the Express app via app.set(). This was ~230 lines of inline
// service wiring in server.js and is now a single function with a clear
// dependency injection chain.
//
// Exposed: registerServices(app, baseDeps)
//   baseDeps: { prisma, io, notificationService, marketOracle,
//               mtnDisbursementService, moolreCollectionService, paymentFailoverService,
//               emailService, smsService, azmSpendService, azmRewardService }
//   returns: { kycService, rateAlertService, vaultService, smartRouteService,
//             azmAuctionService, adminAlertService, storyService }
//     — services that server.js or other modules need by reference
//     (e.g. smartRouteService is passed to startWorkers, kycService gets
//     adminAlertService attached, storyService gets a cron schedule).
// ============================================================================

const logger = require('../config/logger');

/**
 * Instantiates all composite services and registers them on the Express app.
 *
 * Dependency order matters — later services depend on earlier ones:
 *   notificationService → kycService, rateAlertService, vaultService, ...
 *   azmRewardService → vaultService, susuService
 *   susuMemberService, susuVouchService, liabilityContractService → susuOverlayService, ...
 *   vaultService → smartRouteService
 *
 * @param {import('express').Express} app
 * @param {object} baseDeps — leaf services created in server.js before this call
 * @returns {object} services needed by reference outside this registry
 */
function registerServices(app, baseDeps) {
  const {
    prisma,
    io,
    notificationService,
    marketOracle,
    gatewayService,
    mtnDisbursementService,
    moolreCollectionService,
    paymentFailoverService,
    emailService,
    smsService,
  } = baseDeps;

  // ── AZM REWARD SERVICE (Phase E1) ────────────────────────────────────────
  const { AzmRewardService } = require('../../services/azmRewardService');
  const azmRewardService = new AzmRewardService(prisma, io);
  app.set('azmRewardService', azmRewardService);

  // ── AZM SPEND SERVICE (Phase E2) ────────────────────────────────────────
  const { AzmSpendService } = require('../../services/azmSpendService');
  const azmSpendService = new AzmSpendService(prisma, io);
  app.set('azmSpendService', azmSpendService);

  // ── KYC SERVICE (Phase Q6) ───────────────────────────────────────────────
  // SWAPPABLE ADAPTER: kycService.js (MOCK) and dojahKycService.js (LIVE Ghana
  // lookups) share the same public surface. Bound by KYC_PROVIDER env.
  const KYCService = require('../../services/kycService');
  const DojahKYCService = require('../../services/dojahKycService');
  const KYC_PROVIDER = (process.env.KYC_PROVIDER || 'mock').toLowerCase();
  const KYC_LIVE = KYC_PROVIDER === 'live' || KYC_PROVIDER === 'dojah';
  const kycService = KYC_LIVE
    ? new DojahKYCService(prisma, notificationService)
    : new KYCService(prisma, notificationService);
  app.set('kycService', kycService);
  logger.info({ provider: KYC_LIVE ? 'DOJAH (live)' : 'MOCK' }, 'KYC provider');

  // ── RATE ALERT SERVICE (Phase Q12) ────────────────────────────────────────
  const RateAlertService = require('../../services/rateAlertService');
  const rateAlertService = new RateAlertService(prisma, notificationService);
  app.set('rateAlertService', rateAlertService);
  // Hook into oracle sync — check alerts after every rate update.
  marketOracle.rateAlertService = rateAlertService;

  // ── VAULT SERVICE ─────────────────────────────────────────────────────────
  const { VaultService } = require('../../services/vaultService');
  const vaultService = new VaultService(prisma, io, notificationService, azmRewardService);
  app.set('vaultService', vaultService);

  // ── GROUP CHAT SERVICE ────────────────────────────────────────────────────
  const { GroupChatService } = require('../../services/groupChatService');
  const groupChatService = new GroupChatService(prisma, io, notificationService);
  app.set('groupChatService', groupChatService);

  // PHASE 6 — member-proposed group adds + admin add-quota engine.
  const { GroupJoinRequestService } = require('../../services/groups/groupJoinRequest.service');
  const groupJoinRequestService = new GroupJoinRequestService(prisma, { notificationService, io });
  app.set('groupJoinRequestService', groupJoinRequestService);

  // ── SUSU SERVICE (legacy) ─────────────────────────────────────────────────
  const { SusuService } = require('../../services/susuService');
  const susuService = new SusuService(prisma, io, notificationService, azmRewardService);
  app.set('susuService', susuService);

  // ── PRIVATE SUSU ECOSYSTEM OVERLAY (2026-05-31) ───────────────────────────
  const SusuMemberService            = require('../../services/susu/susuMember.service');
  const SusuVouchService             = require('../../services/susu/susuVouch.service');
  const SusuOverlayService           = require('../../services/susu/susu.service');
  const SusuInviteService            = require('../../services/susu/susuInvite.service');
  const LiabilityContractServiceCls  = require('../../services/susu/liabilityContract.service');
  const ProofOfResidencyServiceCls   = require('../../services/susu/proofOfResidency.service');
  const AdminWarRoomServiceCls       = require('../../services/susu/adminWarRoom.service');

  const susuMemberService            = new SusuMemberService(prisma);
  const susuVouchService             = new SusuVouchService(prisma, { notificationService });
  const liabilityContractService     = new LiabilityContractServiceCls(prisma);
  const susuOverlayService           = new SusuOverlayService(prisma, {
    susuVouchService,
    susuMemberService,
    liabilityContractService,
  });
  const susuInviteService            = new SusuInviteService(prisma, {
    susuVouchService,
    susuMemberService,
    notificationService,
  });
  const proofOfResidencyService      = new ProofOfResidencyServiceCls(prisma, { susuMemberService });
  const adminWarRoomService          = new AdminWarRoomServiceCls(prisma, { notificationService });

  const AdminSusuMonitorServiceCls   = require('../../services/susu/adminSusuMonitor.service');
  const adminSusuMonitorService      = new AdminSusuMonitorServiceCls(prisma, {
    susuVouchService,
    notificationService,
  });

  const SusuInitiationService        = require('../../services/susu/susuInitiation.service');
  const susuInitiationService        = new SusuInitiationService(prisma, {
    susuOverlayService,
    susuMemberService,
    liabilityContractService,
    notificationService,
    io,
  });

  app.set('susuMemberService',        susuMemberService);
  app.set('susuVouchService',         susuVouchService);
  app.set('susuOverlayService',       susuOverlayService);
  app.set('susuInviteService',        susuInviteService);
  app.set('liabilityContractService', liabilityContractService);
  app.set('proofOfResidencyService',  proofOfResidencyService);
  app.set('adminWarRoomService',      adminWarRoomService);
  app.set('susuInitiationService',    susuInitiationService);
  app.set('adminSusuMonitorService',  adminSusuMonitorService);

  // ── SMART ROUTE SERVICE ───────────────────────────────────────────────────
  const { SmartRouteService } = require('../../services/smartRouteService');
  const smartRouteService = new SmartRouteService({
    prisma,
    io,
    notificationService,
    mtnDisbursementService,
    vaultService,
  });
  app.set('smartRouteService', smartRouteService);

  // ── AZM AUCTION SERVICE ───────────────────────────────────────────────────
  const { AzmAuctionService } = require('../../services/azmAuctionService');
  const azmAuctionService = new AzmAuctionService({
    prisma,
    io,
    azmSpendService,
    notificationService,
  });
  app.set('azmAuctionService', azmAuctionService);

  // ── MOMO NAME LOOKUP ─────────────────────────────────────────────────────
  const { MomoNameLookupService } = require('../../services/momoNameLookupService');
  const momoNameLookupService = new MomoNameLookupService(moolreCollectionService);
  app.set('momoNameLookupService', momoNameLookupService);

  // ── ADMIN ALERT SERVICE (B-11) ───────────────────────────────────────────
  const AdminAlertService = require('../../services/adminAlertService');
  const adminAlertService = new AdminAlertService({ io, emailService });
  app.set('adminAlertService', adminAlertService);

  // ── STORY SERVICE ────────────────────────────────────────────────────────
  const StoryService = require('../../services/storyService');
  const storyService = new StoryService(io, prisma, azmSpendService, null);
  app.set('storyService', storyService);

  // ── LINK PREVIEW SERVICE ─────────────────────────────────────────────────
  const LinkPreviewService = require('../../services/linkPreviewService');
  const linkPreviewService = new LinkPreviewService(prisma);
  app.set('linkPreviewService', linkPreviewService);

  // ── ESCROW SERVICE (module-level functions, not a class instance) ────────
  const EscrowService = require('../../services/escrowService');
  app.set('escrowService', EscrowService);

  // ── BASE SERVICE REGISTRATIONS ──────────────────────────────────────────
  // Register the leaf services that were created in server.js before this
  // function was called.
  app.set('gatewayService', gatewayService);
  app.set('mtnDisbursementService', mtnDisbursementService);
  // finance.controller.js reads 'moolreDisbursementService'; withdrawalController.js
  // reads 'mtnDisbursementService'. Both point at the same instance.
  app.set('moolreDisbursementService', mtnDisbursementService);
  app.set('paymentFailoverService', paymentFailoverService);
  app.set('moolreCollectionService', moolreCollectionService);
  app.set('tatumService', baseDeps.tatumService);
  app.set('emailService', emailService);
  app.set('smsService', smsService);

  // Return services needed by reference outside this registry.
  return {
    kycService,
    rateAlertService,
    vaultService,
    groupChatService,
    smartRouteService,
    azmAuctionService,
    adminAlertService,
    storyService,
    susuService,
    susuInitiationService,
    azmSpendService,
    azmRewardService,
  };
}

module.exports = { registerServices };
