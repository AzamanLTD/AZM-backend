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
const { Prisma } = require('@prisma/client');
const ledger = require('./ledgerService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));
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

const createInvoice = async (prisma, {
  businessProfileId, customerId, locationId, tableId,
  lineItems, taxLines, businessNote, idempotencyKey,
}) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0)
    throw new Error('At least one line item is required.');
  if (lineItems.length > 50)
    throw new Error('Maximum 50 line items per invoice.');

  let effectiveTaxLines = taxLines;
  if (effectiveTaxLines === undefined) {
    const defaultPreset = await prisma.businessTaxPreset.findFirst({
      where: { businessProfileId, isDefault: true },
      orderBy: { createdAt: 'asc' },
      select: { name: true, type: true, value: true },
    });
    effectiveTaxLines = defaultPreset ? [defaultPreset] : [];
  }

  const { subtotal: subtotalUsdc, lineItems: cleanLineItems } = computeLineItems(lineItems);
  const { taxTotal: taxTotalUsdc, taxLines: cleanTaxLines } = computeTaxLines(effectiveTaxLines, subtotalUsdc);
  const billTotalUsdc = subtotalUsdc + taxTotalUsdc;

  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, username: true },
  });
  if (!customer) throw new Error('Customer not found.');

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
      idempotencyKey: idempotencyKey || null,
      status: 'DRAFT',
      subtotalUsdc, taxTotalUsdc, billTotalUsdc,
      businessNote: businessNote ? String(businessNote).slice(0, 500) : null,
      lineItems: { create: cleanLineItems },
      taxLines: { create: cleanTaxLines },
    },
    include: { lineItems: true, taxLines: true },
  });

  emitWebhookEvent(businessProfileId, 'invoice.created', {
    invoiceId: invoice.id,
    invoiceRef: invoice.invoiceRef,
    customerId,
    billTotal: invoice.billTotalUsdc,
    status: invoice.status,
  });

  return invoice;
};

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

  if (invoice.payTxHash) {
    return { invoice, customerPays: Number(invoice.customerPaidUsdc), alreadyPaid: true };
  }
  if (invoice.status !== 'SENT') throw new Error(`Invoice cannot be paid from status ${invoice.status}.`);

  const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
  const feePct = Number(settings?.businessInvoiceFeePct ?? 0.015);
  const billPlusTip = Number(invoice.billTotalUsdc) + tip;
  const fee = parseFloat((billPlusTip * feePct).toFixed(8));

  let customerPays, businessReceives;
  if (coveredFee) {
    customerPays = parseFloat((billPlusTip + fee).toFixed(8));
    businessReceives = billPlusTip;
  } else {
    customerPays = billPlusTip;
    businessReceives = parseFloat((billPlusTip - fee).toFixed(8));
  }

  const businessOwnerUserId = invoice.businessProfile.userId;
  const payTxHash = `INV_PAY_${invoiceId}`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.businessInvoice.updateMany({
        where: { id: invoiceId, status: 'SENT', payTxHash: null },
        data: { payTxHash },
      });
      if (claim.count !== 1) {
        throw new Error('INVOICE_ALREADY_PAID');
      }

      // The balance mutation itself is the concurrency guard. A read-then-
      // unconditional decrement is unsafe when the same customer pays two
      // different invoices concurrently: both transactions can observe the
      // same balance and both can subtract. This conditional UPDATE serializes
      // on the user row and only one claim succeeds when funds are exhausted.
      const balanceClaim = await tx.user.updateMany({
        where: { id: customerId, availableBalance: { gte: customerPays } },
        data: { availableBalance: { decrement: customerPays } },
      });
      if (balanceClaim.count !== 1) {
        throw new Error('INSUFFICIENT_FUNDS');
      }

      await tx.user.update({
        where: { id: businessOwnerUserId },
        data: { availableBalance: { increment: businessReceives } },
      });
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
      const updated = await tx.businessInvoice.update({
        where: { id: invoiceId },
        data: {
          status: 'PAID', paidAt: new Date(),
          tipUsdc: tip, customerCoveredFee: coveredFee,
          feeUsdc: fee, customerPaidUsdc: customerPays,
          customerNote: customerNote ? String(customerNote).slice(0, 500) : null,
        },
        include: { lineItems: true, taxLines: true,
          businessProfile: { select: { userId: true, businessName: true, bizId: true } } },
      });
      const payerHistory = await tx.transactionHistory.create({ data: {
        userId: customerId,
        type: 'BUSINESS_INVOICE_PAYMENT',
        amountUsdc: -customerPays,
        feeUsdc: coveredFee ? fee : 0,
        txHash: `${payTxHash}_PAYER`,
        status: 'COMPLETED',
      }});

      // §P.4 AUTHORITATIVE LEDGER — invoice settlement, same transaction,
      // idempotent on the invoice's DB-unique payTxHash (the conditional
      // claim above guarantees exactly one payer wins):
      //   D user:{customer}:liability — customer pays bill + tip (+ fee
      //                                 when customer covered it)
      //   C user:{businessOwner}:liability — business receives its share
      //   C equity:treasury — invoice fee realized (mirrors the
      //                       SystemProfitFees increment above)
      // Any float-rounding residual between the stored legs is absorbed by
      // revenue:fees so the posting balances EXACTLY without minting value.
      {
        const debit = new Prisma.Decimal(_exact(customerPays));
        const share = new Prisma.Decimal(_exact(businessReceives));
        const feeExact = new Prisma.Decimal(_exact(fee));
        const residual = debit.minus(share).minus(feeExact);
        const lines = [
          { account: `user:${customerId}:liability`, debit: debit.toFixed(8) },
          { account: `user:${businessOwnerUserId}:liability`, credit: share.toFixed(8) },
        ];
        if (!feeExact.isZero()) {
          lines.push({ account: 'equity:treasury', credit: feeExact.toFixed(8) });
        }
        if (!residual.isZero()) {
          const residualStr = residual.abs().toFixed(8);
          if (residual.isPositive()) lines.push({ account: 'revenue:fees', credit: residualStr });
          else lines.push({ account: 'revenue:fees', debit: residualStr });
        }
        await ledger.post(tx, {
          idempotencyKey: `ledger:invoice:pay:${payTxHash}`,
          entryType: 'BUSINESS_PAYMENT',
          description: 'Business invoice paid — liability moved customer→business, fee realized',
          userId: customerId,
          relatedEntity: 'businessInvoice',
          relatedEntityId: invoiceId,
          metadata: {
            tipUsdc: _exact(tip),
            feeUsdc: feeExact.toFixed(8),
            coveredFee,
            residual: residual.toFixed(8),
            payerHistoryId: payerHistory.id,
          },
          lines,
        });
      }
      await tx.transactionHistory.create({ data: {
        userId: businessOwnerUserId,
        type: 'BUSINESS_INVOICE_RECEIPT',
        amountUsdc: businessReceives,
        feeUsdc: coveredFee ? 0 : fee,
        txHash: `${payTxHash}_PAYEE`,
        status: 'COMPLETED',
      }});
      return updated;
    });

    return { invoice: result, customerPays, businessReceives, fee };
  } catch (err) {
    if (err.message === 'INVOICE_ALREADY_PAID') {
      const paidInvoice = await prisma.businessInvoice.findUnique({
        where: { id: invoiceId },
        include: { businessProfile: { select: { userId: true, businessName: true, bizId: true } } },
      });
      if (paidInvoice?.payTxHash) {
        return {
          invoice: paidInvoice,
          customerPays: Number(paidInvoice.customerPaidUsdc),
          alreadyPaid: true,
        };
      }
    }
    throw err;
  }
};

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

const lookupCustomerByAzamanId = async (prisma, { azamanId }) => {
  if (!azamanId || !String(azamanId).trim()) return null;
  return prisma.user.findUnique({
    where: { azamanId: String(azamanId).trim() },
    select: { id: true, username: true, profilePictureUrl: true, azamanId: true },
  });
};

module.exports = { createInvoice, sendInvoice, voidInvoice, payInvoice,
  getInvoice, listInvoicesForBusiness, listInvoicesForCustomer, lookupCustomerByAzamanId };