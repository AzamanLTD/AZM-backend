// services/businessInvoiceService.js
// =============================================================================
// AZAMAN — BUSINESS INVOICE SERVICE (Discovery Sprint, 2026-06-20)
//
// The financial heart of the invoice feature. Invoice settlement is INSTANT,
// not escrowed. payInvoice mirrors peerTransferController.sendFunds exactly:
//   • idempotency anchored on invoice.payTxHash
//   • a single $transaction with { decrement } / { increment }
//   • two signed TransactionHistory rows (payer −, payee +)
//   • a profit log + SystemProfitFees bump when fee > 0
// Socket emits + notifications happen in the controller AFTER commit — never
// inside the $transaction.
// =============================================================================
'use strict';
const { computeLineItems, computeTaxLines } = require('../utils/invoiceMath');
const { emitWebhookEvent } = require('./webhookEmitter');

// Generates: INV-YYMMDD-XXXX (e.g. INV-260620-A3F2)
const _invoiceRef = () => {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  const rand = Math.random().toString(36).slice(2,6).toUpperCase();
  return `INV-${yy}${mm}${dd}-${rand}`;
};

// ── createInvoice ──────────────────────────────────────────────────────────
const createInvoice = async (prisma, {
  businessProfileId, customerId, locationId, tableId,
  lineItems, taxLines, businessNote,
}) => {
  // Validate line items
  if (!Array.isArray(lineItems) || lineItems.length === 0)
    throw new Error('At least one line item is required.');
  if (lineItems.length > 50)
    throw new Error('Maximum 50 line items per invoice.');

  // Compute subtotal + tax lines (extracted to utils/invoiceMath.js)
  const { subtotal: subtotalUsdc, lineItems: cleanLineItems } = computeLineItems(lineItems);
  const { taxTotal: taxTotalUsdc, taxLines: cleanTaxLines } = computeTaxLines(taxLines, subtotalUsdc);
  const billTotalUsdc = subtotalUsdc + taxTotalUsdc;

  // Validate customer exists
  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, username: true },
  });
  if (!customer) throw new Error('Customer not found.');

  // Generate unique invoiceRef (retry on collision)
  let invoiceRef = null;
  for (let i = 0; i < 5; i++) {
    const candidate = _invoiceRef();
    const clash = await prisma.businessInvoice.findUnique({ where: { invoiceRef: candidate } });
    if (!clash) { invoiceRef = candidate; break; }
  }
  if (!invoiceRef) throw new Error('Could not generate invoice reference. Retry.');

  const invoice = await prisma.businessInvoice.create({
    data: {
      businessProfileId, customerId, locationId: locationId || null,
      tableId: tableId || null,
      invoiceRef,
      status: 'DRAFT',
      subtotalUsdc, taxTotalUsdc, billTotalUsdc,
      businessNote: businessNote ? String(businessNote).slice(0, 500) : null,
      lineItems: { create: cleanLineItems },
      taxLines: { create: cleanTaxLines },
    },
    include: { lineItems: true, taxLines: true },
  });

  // Fire-and-forget webhook for invoice creation
  emitWebhookEvent(businessProfileId, 'invoice.created', {
    invoiceId: invoice.id,
    invoiceRef: invoice.invoiceRef,
    customerId,
    billTotal: invoice.billTotalUsdc,
    status: invoice.status,
  });

  return invoice;
};

// ── sendInvoice ────────────────────────────────────────────────────────────
const sendInvoice = async (prisma, { invoiceId, businessProfileId }) => {
  const invoice = await prisma.businessInvoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true, taxLines: true },
  });
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.businessProfileId !== businessProfileId) throw new Error('Not authorized.');
  if (invoice.status !== 'DRAFT') throw new Error(`Cannot send invoice with status ${invoice.status}.`);

  return prisma.businessInvoice.update({
    where: { id: invoiceId },
    data: { status: 'SENT', sentAt: new Date() },
    include: { lineItems: true, taxLines: true,
      customer: { select: { id: true, username: true, profilePictureUrl: true } } },
  });
};

// ── voidInvoice ────────────────────────────────────────────────────────────
const voidInvoice = async (prisma, { invoiceId, businessProfileId }) => {
  const invoice = await prisma.businessInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.businessProfileId !== businessProfileId) throw new Error('Not authorized.');
  if (!['DRAFT','SENT'].includes(invoice.status)) {
    throw new Error(`Cannot void invoice with status ${invoice.status}.`);
  }
  return prisma.businessInvoice.update({
    where: { id: invoiceId },
    data: { status: 'VOIDED', voidedAt: new Date() },
  });
};

// ── payInvoice ─────────────────────────────────────────────────────────────
// THE FINANCIAL FUNCTION. Mirrors peerTransferController.sendFunds.
// Idempotency: invoice.payTxHash is the anchor. If it is already set, the
// invoice was already paid — return it (replay).
const payInvoice = async (prisma, {
  invoiceId, customerId, tipUsdc, customerNote, customerCoveredFee,
}) => {
  const tip = Math.max(0, parseFloat(tipUsdc) || 0);
  const coveredFee = !!customerCoveredFee;

  const invoice = await prisma.businessInvoice.findUnique({
    where: { id: invoiceId },
    include: { businessProfile: { select: { userId: true, businessName: true } } },
  });
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.customerId !== customerId) throw new Error('Not authorized to pay this invoice.');
  if (invoice.status !== 'SENT') throw new Error(`Invoice cannot be paid from status ${invoice.status}.`);

  // ── IDEMPOTENCY REPLAY ──────────────────────────────────────────────────
  if (invoice.payTxHash) {
    return { invoice, customerPays: Number(invoice.customerPaidUsdc), alreadyPaid: true };
  }

  // ── FEE CALCULATION ─────────────────────────────────────────────────────
  const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
  const feePct = Number(settings?.businessInvoiceFeePct ?? 0.015);
  const billPlusTip = Number(invoice.billTotalUsdc) + tip;
  const fee = parseFloat((billPlusTip * feePct).toFixed(8));

  let customerPays, businessReceives;
  if (coveredFee) {
    customerPays = parseFloat((billPlusTip + fee).toFixed(8));
    businessReceives = billPlusTip;          // business gets full amount
  } else {
    customerPays = billPlusTip;
    businessReceives = parseFloat((billPlusTip - fee).toFixed(8));  // business absorbs fee
  }

  const businessOwnerUserId = invoice.businessProfile.userId;
  const payTxHash = `INV_PAY_${invoiceId}`;  // invoiceId IS the idempotency anchor

  // ── ATOMIC TRANSACTION ──────────────────────────────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.user.findUnique({
      where: { id: customerId }, select: { availableBalance: true, username: true },
    });
    if (!customer) throw new Error('Customer not found.');
    if (Number(customer.availableBalance) < customerPays) {
      throw new Error('INSUFFICIENT_FUNDS');
    }

    // Debit customer
    await tx.user.update({
      where: { id: customerId },
      data: { availableBalance: { decrement: customerPays } },
    });
    // Credit business owner
    await tx.user.update({
      where: { id: businessOwnerUserId },
      data: { availableBalance: { increment: businessReceives } },
    });
    // Platform fee
    if (fee > 0) {
      await tx.systemProfitFees.upsert({
        where: { id: 1 },
        update: { balance: { increment: fee } },
        create: { id: 1, balance: fee },
      });
      await tx.adminProfitLog.create({ data: {
        source: 'BUSINESS_INVOICE_FEE',
        amountUsdc: fee,
        relatedTxId: payTxHash,
      }});
    }
    // Mark invoice PAID
    const updated = await tx.businessInvoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID', paidAt: new Date(),
        tipUsdc: tip, customerCoveredFee: coveredFee,
        feeUsdc: fee, customerPaidUsdc: customerPays,
        payTxHash,
        customerNote: customerNote ? String(customerNote).slice(0, 500) : null,
      },
      include: { lineItems: true, taxLines: true,
        businessProfile: { select: { userId: true, businessName: true, bizId: true } } },
    });
    // TransactionHistory — customer debit (signed: negative)
    await tx.transactionHistory.create({ data: {
      userId: customerId,
      type: 'BUSINESS_INVOICE_PAYMENT',
      amountUsdc: -customerPays,
      feeUsdc: coveredFee ? fee : 0,
      txHash: `${payTxHash}_PAYER`,
      status: 'COMPLETED',
    }});
    // TransactionHistory — business credit (signed: positive)
    await tx.transactionHistory.create({ data: {
      userId: businessOwnerUserId,
      type: 'BUSINESS_INVOICE_RECEIPT',
      amountUsdc: businessReceives,
      feeUsdc: coveredFee ? 0 : fee,
      txHash: `${payTxHash}_PAYEE`,
      status: 'COMPLETED',
    }});
    return updated;
  }); // end $transaction

  return { invoice: result, customerPays, businessReceives, fee };
};

// ── getInvoice ─────────────────────────────────────────────────────────────
const getInvoice = async (prisma, { invoiceId }) => {
  return prisma.businessInvoice.findUnique({
    where: { id: invoiceId },
    include: {
      lineItems: true,
      taxLines: true,
      review: true,
      customer: { select: { id: true, username: true, profilePictureUrl: true } },
      businessProfile: { select: { id: true, bizId: true, businessName: true, logoUrl: true } },
      location: { select: { id: true, label: true, address: true } },
      table: { select: { id: true, label: true } },
    },
  });
};

// ── listInvoicesForBusiness ─────────────────────────────────────────────────
const listInvoicesForBusiness = async (prisma, { businessProfileId, status, limit, cursor }) => {
  const take = Math.min(parseInt(limit, 10) || 20, 50);
  const where = { businessProfileId };
  if (status) where.status = status;
  const invoices = await prisma.businessInvoice.findMany({
    where, take: take + 1,
    orderBy: { createdAt: 'desc' },
    include: {
      customer: { select: { id: true, username: true, profilePictureUrl: true } },
      location: { select: { label: true } },
      table: { select: { label: true } },
    },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = invoices.length > take;
  return { invoices: invoices.slice(0, take), hasMore, nextCursor: hasMore ? invoices[take-1].id : null };
};

// ── listInvoicesForCustomer ─────────────────────────────────────────────────
const listInvoicesForCustomer = async (prisma, { customerId, status, limit, cursor }) => {
  const take = Math.min(parseInt(limit, 10) || 20, 50);
  const where = { customerId, status: status || { in: ['SENT','PAID'] } };
  const invoices = await prisma.businessInvoice.findMany({
    where, take: take + 1,
    orderBy: { createdAt: 'desc' },
    include: {
      lineItems: true, taxLines: true,
      businessProfile: { select: { bizId: true, businessName: true, logoUrl: true } },
      location: { select: { label: true, address: true } },
      table: { select: { label: true } },
    },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = invoices.length > take;
  return { invoices: invoices.slice(0, take), hasMore, nextCursor: hasMore ? invoices[take-1].id : null };
};

// ── lookupCustomerByAzamanId ────────────────────────────────────────────────
// Powers the business portal "find customer to bill" search field.
// ONLY returns public-safe fields — never balance, email, or phone.
const lookupCustomerByAzamanId = async (prisma, { azamanId }) => {
  if (!azamanId || !String(azamanId).trim()) return null;
  return prisma.user.findUnique({
    where: { azamanId: String(azamanId).trim() },
    select: { id: true, username: true, profilePictureUrl: true, azamanId: true },
  });
};

module.exports = { createInvoice, sendInvoice, voidInvoice, payInvoice,
  getInvoice, listInvoicesForBusiness, listInvoicesForCustomer, lookupCustomerByAzamanId };
