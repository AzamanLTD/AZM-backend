'use strict';

/**
 * Serialize read-modify-write tracking mutations per order.
 *
 * OrderTracking.timeline is stored as a JSON value. A plain findUnique +
 * update sequence lets two concurrent status events both read the same
 * timeline and the later write silently discard the earlier event. A
 * transaction-scoped PostgreSQL advisory lock closes that lost-update window
 * while also protecting the no-row initialization path.
 */
async function withOrderTrackingMutation(prisma, orderId, businessProfileId, mutate) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

        const tracking = await tx.orderTracking.upsert({
            where: { orderId },
            create: { orderId, businessProfileId },
            update: {},
        });

        return mutate(tx, tracking);
    });
}

module.exports = {
    withOrderTrackingMutation,
};
