// controllers/businessInvoiceController.js
// =============================================================================
// AZAMAN — BUSINESS INVOICE CONTROLLER (Discovery Sprint, 2026-06-20)
//
// HTTP layer for the instant-settlement invoice feature + customer reviews.
// Socket emits and notifications fire via setImmediate AFTER the service's
// $transaction commits — never inside it. Mirrors the escrow / peer-transfer
// conventions: prisma/io/emitBalanceUpdate/notificationService from req.app.
// =============================================================================
'use strict';
const logger = require('../src/config/logger');
const invoiceSvc = require('../services/businessInvoiceService');
const invoiceCreationBoundary = require('../services/businessInvoiceCreationBoundary');
const reviewSvc  = require('../services/businessReviewService');
const emailSvc   = require('../services/emailService');

const _ownedProfile = async (prisma, userId) => {
  const p = await prisma.businessProfile.findFirst({ where: { userId } });
  if (!p) throw Object.assign(new Error('No business profile found.'), { status: 404 });
  if (p.isSuspended) {
    throw Object.assign(
      new Error('Your business account is suspended. Contact support.'),
      { status: 403 }
    );
  }
  return p;
};
const _err = (res, err) => res.status(err.status || 400).json({ success: false, message: err.message });

// POST /api/business/invoices — create a DRAFT invoice
exports.createInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const { customerId, locationId, tableId, lineItems, taxLines, businessNote, idempotencyKey: bodyIdempotencyKey } = req.body;
    const headerIdempotencyKey = req.get('Idempotency-Key');
    const normalizedHeader = headerIdempotencyKey == null ? null : String(headerIdempotencyKey).trim();
    const normalizedBody = bodyIdempotencyKey == null ? null : String(bodyIdempotencyKey).trim();
    if (normalizedHeader && normalizedBody && normalizedHeader !== normalizedBody) {
      return res.status(400).json({ success: false, message: 'Idempotency-Key header does not match body idempotencyKey.' });
    }
    const idempotencyKey = normalizedHeader || normalizedBody || null;
    if (!customerId) return res.status(400).json({ success: false, message: "customerId required." });
    const result = await invoiceCreationBoundary.createInvoice(prisma, {
      businessProfileId: profile.id, customerId, locationId, tableId,
      lineItems, taxLines, businessNote, idempotencyKey,
    });
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      invoice: result.invoice,
      ...(result.replayed ? { replayed: true } : {}),
    });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/customers/lookup?azamanId=AZM-XXXXXX
exports.lookupCustomer = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    await _ownedProfile(prisma, req.user.id); // must own a business to use this
    const customer = await invoiceSvc.lookupCustomerByAzamanId(prisma, { azamanId: req.query.azamanId });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });
    return res.json({ success: true, customer });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/invoices — list this business's invoices (owner only)
exports.listInvoices = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const result = await invoiceSvc.listInvoicesForBusiness(prisma, {
      businessProfileId: profile.id,
      status: req.query.status,
      limit: req.query.limit,
      cursor: req.query.cursor,
    });
    return res.json({ success: true, ...result });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/invoices/lookup/:azmId — resolve an AZM-ID to customer info
exports.lookupByAzmId = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    await _ownedProfile(prisma, req.user.id);
    const { azmId } = req.params;
    if (!azmId || !azmId.startsWith("AZM-")) {
      return res.status(400).json({ success: false, message: "Valid AZM-ID required (AZM-XXXXXXXXX)." });
    }
    const customer = await prisma.user.findUnique({
      where: { azamanId: azmId },
      select: {
        id: true, username: true, displayName: true,
        profilePictureUrl: true, azamanId: true
      }
    });
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found." });
    return res.json({ success: true, customer });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/invoices/:invoiceId
exports.getInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const invoice = await invoiceSvc.getInvoice(prisma, { invoiceId: req.params.invoiceId });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    // Authorize: only business owner or the customer
    const profile = await prisma.businessProfile.findUnique({ where: { id: invoice.businessProfileId } });
    if (invoice.customerId !== req.user.id && profile?.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }
    return res.json({ success: true, invoice });
  } catch (err) { return _err(res, err); }
};

// POST /api/business/invoices/:invoiceId/send
exports.sendInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  const io = req.app.get("socketio");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const invoice = await invoiceSvc.sendInvoice(prisma, {
      invoiceId: req.params.invoiceId, businessProfileId: profile.id,
    });
    // Fire-and-forget notifications AFTER transaction commits
    setImmediate(() => {
      try {
        const notificationService = req.app.get("notificationService");
        if (notificationService) {
          notificationService.sendNotification({
            userId: invoice.customerId,
            title: '🧾 New Bill',
            body: `${profile.businessName} sent you a bill for ${Number(invoice.billTotalUsdc).toFixed(2)} USDC`,
            category: 'GENERAL',
            actionPayload: { action: 'OPEN_INVOICE', invoiceId: invoice.id, route: `/bills/${invoice.id}` },
          });
        }
        if (io) io.to(`user_${invoice.customerId}`).emit('invoice_received', {
          invoiceId: invoice.id,
          invoiceRef: invoice.invoiceRef,
          businessName: profile.businessName,
          billTotalUsdc: Number(invoice.billTotalUsdc),
        });
      } catch (e) { logger.error({ err: e }, '[invoice/send] notification error'); }
    });
    return res.json({ success: true, invoice });
  } catch (err) { return _err(res, err); }
};



// POST /api/business/invoices/:invoiceId/email — email invoice to customer
exports.emailInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const { email } = req.body;
    const invoice = await invoiceSvc.getInvoice(prisma, { invoiceId: req.params.invoiceId });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found.' });
    if (invoice.businessProfileId !== profile.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    // Determine recipient email
    const customer = await prisma.user.findUnique({
      where: { id: invoice.customerId },
      select: { email: true, displayName: true, username: true },
    });
    const recipientEmail = email || customer?.email;
    if (!recipientEmail) {
      return res.status(400).json({ success: false, message: 'No email address available for this customer.' });
    }

    // Build email content
    const invoiceUrl = `${process.env.FRONTEND_URL || 'https://app.azaman.com'}/bills/${invoice.id}`;
    const { html, text } = emailSvc.buildInvoiceEmail({
      businessName: profile.businessName,
      customerName: customer?.displayName || customer?.username || 'there',
      invoiceRef: invoice.invoiceRef,
      billTotal: invoice.billTotalUsdc,
      lineItems: invoice.lineItems,
      dueDate: invoice.dueDate,
      invoiceUrl,
    });

    // Fire-and-forget email
    setImmediate(async () => {
      try {
        await emailSvc.send({
          to: recipientEmail,
          subject: `Invoice from ${profile.businessName} — ${invoice.invoiceRef}`,
          html,
          text,
          replyTo: profile.contactEmail,
        });
        logger.info({ invoiceId: invoice.id, to: recipientEmail }, '[invoice/email] sent');
      } catch (e) {
        logger.error({ err: e, invoiceId: invoice.id }, '[invoice/email] failed');
      }
    });

    return res.json({ success: true, message: `Invoice emailed to ${recipientEmail}` });
  } catch (err) { return _err(res, err); }
};

// POST /api/business/invoices/:invoiceId/void
exports.voidInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  const io = req.app.get("socketio");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const invoice = await invoiceSvc.voidInvoice(prisma, {
      invoiceId: req.params.invoiceId, businessProfileId: profile.id,
    });
    setImmediate(() => {
      if (io) io.to(`user_${invoice.customerId}`).emit('invoice_voided', { invoiceId: invoice.id });
    });
    return res.json({ success: true, invoice });
  } catch (err) { return _err(res, err); }
};

// POST /api/business/invoices/:invoiceId/pay  (CUSTOMER pays — auth = customer)
exports.payInvoice = async (req, res) => {
  const prisma = req.app.get("prisma");
  const io = req.app.get("socketio");
  const emitBalanceUpdate = req.app.get("emitBalanceUpdate");
  try {
    const { tipUsdc, customerNote, customerCoveredFee } = req.body;
    const { invoice, customerPays, businessReceives, fee, alreadyPaid } = await invoiceSvc.payInvoice(prisma, {
      invoiceId: req.params.invoiceId, customerId: req.user.id,
      tipUsdc, customerNote, customerCoveredFee,
    });
    // ── IDEMPOTENT REPLAY ───────────────────────────────────────────────────
    // payTxHash was already set — no money moved this call. Skip all
    // notifications, socket emits, and balance updates (businessReceives/fee
    // are undefined here anyway) and return the existing paid invoice silently.
    if (alreadyPaid) {
      return res.json({ success: true, invoice, customerPays, alreadyPaid: true });
    }
    const bizOwnerId = invoice.businessProfile?.userId ?? null;
    setImmediate(() => {
      try {
        // Real-time balance update to both parties
        if (emitBalanceUpdate) {
          emitBalanceUpdate(req.user.id);
          if (bizOwnerId) emitBalanceUpdate(bizOwnerId);
        }
        // Notify business of payment
        const notificationService = req.app.get("notificationService");
        if (notificationService && bizOwnerId) {
          notificationService.sendNotification({
            userId: bizOwnerId,
            title: '💰 Invoice Paid',
            body: `${invoice.businessProfile.businessName}: Invoice ${invoice.invoiceRef} paid — you received ${Number(businessReceives).toFixed(2)} USDC`,
            category: 'GENERAL',
            actionPayload: { action: 'OPEN_INVOICE', invoiceId: invoice.id, route: `/business/invoices/${invoice.id}` },
          });
        }
        const invoicePaidPayload = {
          invoiceId: invoice.id, invoiceRef: invoice.invoiceRef,
          customerPaidUsdc: customerPays, businessReceives, fee,
        };
        // The same post-commit convergence event goes to both the payer and
        // the business owner. The business portal and Flutter customer inbox
        // can therefore converge from the same authoritative settlement edge.
        if (io) {
          io.to(`user_${req.user.id}`).emit('invoice_paid', invoicePaidPayload);
          if (bizOwnerId && bizOwnerId !== req.user.id) {
            io.to(`user_${bizOwnerId}`).emit('invoice_paid', invoicePaidPayload);
          }
        }
      } catch (e) { logger.error({ err: e }, '[invoice/pay] notification error'); }
    });
    return res.json({ success: true, invoice, customerPays, businessReceives, fee });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_FUNDS') {
      return res.status(402).json({ success: false, message: 'Insufficient balance to pay this invoice.' });
    }
    return _err(res, err);
  }
};

// GET /api/users/invoices — customer's own incoming invoices
exports.listMyInvoices = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const result = await invoiceSvc.listInvoicesForCustomer(prisma, {
      customerId: req.user.id, status: req.query.status,
      limit: req.query.limit, cursor: req.query.cursor,
    });
    return res.json({ success: true, ...result });
  } catch (err) { return _err(res, err); }
};

// POST /api/business/reviews — customer posts a review
exports.createReview = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const { businessProfileId, locationId, rating, comment, sourceType, orderId, invoiceId } = req.body;
    const review = await reviewSvc.createReview(prisma, {
      businessProfileId, locationId, reviewerId: req.user.id,
      rating, comment, sourceType, orderId, invoiceId,
    });
    return res.status(201).json({ success: true, review });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/:bizId/reviews — public listing
exports.listReviews = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const biz = await prisma.businessProfile.findUnique({ where: { bizId: req.params.bizId } });
    if (!biz || biz.isSuspended) return res.status(404).json({ success: false, message: 'Business not found.' });
    const result = await reviewSvc.listReviews(prisma, {
      businessProfileId: biz.id, limit: req.query.limit, cursor: req.query.cursor,
    });
    return res.json({ success: true, ...result });
  } catch (err) { return _err(res, err); }
};
