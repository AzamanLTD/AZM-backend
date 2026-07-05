// services/businessReviewService.js
// =============================================================================
// AZAMAN — BUSINESS REVIEW SERVICE (Discovery Sprint, 2026-06-20)
//
// Reviews are written inside a $transaction that ALSO recomputes
// BusinessProfile.averageRating via aggregate(), so the denormalized rating can
// never drift from the actual review set. One review per order / per invoice is
// enforced by the @unique columns (orderId / invoiceId) on BusinessReview.
// =============================================================================
'use strict';

// ── createReview ───────────────────────────────────────────────────────────
const createReview = async (prisma, {
  businessProfileId, locationId, reviewerId, rating, comment, sourceType, orderId, invoiceId
}) => {
  const r = parseInt(rating, 10);
  if (isNaN(r) || r < 1 || r > 5) throw new Error('Rating must be an integer between 1 and 5.');
  const cleanComment = comment ? String(comment).slice(0, 1000) : null;

  if (sourceType === 'ORDER') {
    if (!orderId) throw new Error("orderId required for ORDER review.");
    const order = await prisma.businessOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new Error('Order not found.');
    if (order.businessProfileId !== businessProfileId) throw new Error('Order does not belong to this business.');
    if (order.status !== 'COMPLETED') throw new Error('Can only review completed orders.');
    if (order.customerId !== reviewerId) throw new Error('Only the customer can review this order.');
  } else if (sourceType === 'INVOICE') {
    if (!invoiceId) throw new Error("invoiceId required for INVOICE review.");
    const invoice = await prisma.businessInvoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error('Invoice not found.');
    if (invoice.businessProfileId !== businessProfileId) throw new Error('Invoice does not belong to this business.');
    if (invoice.status !== 'PAID') throw new Error('Can only review paid invoices.');
    if (invoice.customerId !== reviewerId) throw new Error('Only the customer can review this invoice.');
  } else {
    throw new Error('Invalid sourceType. Must be ORDER or INVOICE.');
  }

  const transactionResult = await prisma.$transaction(async (tx) => {
    let review;
    try {
      review = await tx.businessReview.create({ data: {
        businessProfileId,
        locationId: locationId || null,
        reviewerId,
        rating: r,
        comment: cleanComment,
        sourceType,
        orderId: orderId || null,
        invoiceId: invoiceId || null,
      }});
    } catch (err) {
      if (err.code === 'P2002') {
        throw new Error('You have already reviewed this order/invoice.');
      }
      throw err;
    }
    // Recompute averageRating atomically in the same transaction
    const agg = await tx.businessReview.aggregate({
      where: { businessProfileId },
      _avg: { rating: true },
      _count: true,
    });
    await tx.businessProfile.update({
      where: { id: businessProfileId },
      data: { 
        averageRating: agg._avg.rating || 0,
        reviewCount: agg._count,
      },
    });
    // MARKETPLACE v2: After a positive review, auto-follow the business
    // (if the customer hasn't already) — this seeds the story feed.
    if (r >= 4) {
        try {
            await tx.businessFollower.upsert({
                where: {
                    businessProfileId_customerId: { businessProfileId, customerId: reviewerId }
                },
                update: {},
                create: { businessProfileId, customerId: reviewerId }
            });
            await tx.businessProfile.update({
                where: { id: businessProfileId },
                data: { followerCount: { increment: 1 } }
            });
        } catch (e) {
            // Non-blocking — don't fail the review if the follow fails
        }
    }

    return review;
  });

  // Record trust score outcome after successful review
  try {
      const { recordBookingOutcome } = require('./marketplace/trustScoreService');
      await recordBookingOutcome(prisma, { customerId: reviewerId, outcome: 'COMPLETED' });
  } catch (e) {
      // Non-blocking
  }

  // Notify the business of the new review
  try {
      const business = await prisma.businessProfile.findUnique({
          where: { id: businessProfileId },
          select: { userId: true, businessName: true }
      });
      if (business) {
          await prisma.notification.create({
              data: {
                  userId: business.userId,
                  type: 'REVIEW_RECEIVED',
                  category: 'MARKETPLACE',
                  title: 'New review',
                  body: `${r}★ review from a customer.`,
                  metadata: { reviewId: transactionResult.id, businessProfileId, rating: r },
                  isRead: false,
              }
          });
      }
  } catch (e) {}

  return transactionResult;
};

// ── listReviews ────────────────────────────────────────────────────────────
const listReviews = async (prisma, { businessProfileId, limit, cursor }) => {
  const take = Math.min(parseInt(limit, 10) || 20, 50);
  const reviews = await prisma.businessReview.findMany({
    where: { businessProfileId },
    take: take + 1,
    orderBy: { createdAt: 'desc' },
    include: {
      reviewer: { select: { id: true, username: true, profilePictureUrl: true } },
      location: { select: { label: true } },
    },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = reviews.length > take;
  return { reviews: reviews.slice(0, take), hasMore, nextCursor: hasMore ? reviews[take-1].id : null };
};

module.exports = { createReview, listReviews };
