// services/hotelPricingService.js
// =============================================================================
// AZAMAN — HOTEL STAY PRICING (shared by the stay quote, the reservation and
// the paid stay, so all three price a night the same way).
//
// A night is priced by, in order: a rate override for that date (room >
// room type > hotel-wide), the weekend rate on nights dated Saturday or
// Sunday (UTC), else the base rate. Days are UTC calendar days.
// =============================================================================

function startOfUtcDay(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(value, days) {
    const d = new Date(value);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

async function findNightlyRates(prisma, room, checkInDay, checkOutDay) {
    const nights = [];
    for (let cursor = new Date(checkInDay); cursor < checkOutDay; cursor = addUtcDays(cursor, 1)) {
        nights.push(new Date(cursor));
    }

    const overrides = await prisma.hotelRateOverride.findMany({
        where: {
            businessProfileId: room.businessProfileId,
            date: { gte: checkInDay, lt: checkOutDay },
            OR: [
                { roomId: room.id },
                { roomId: null, roomType: room.roomType },
                { roomId: null, roomType: null },
            ],
        },
        orderBy: [{ date: 'asc' }],
    });

    const overrideMap = new Map();
    for (const override of overrides) {
        const dateKey = new Date(override.date).toISOString().slice(0, 10);
        const priority = override.roomId === room.id ? 3 : override.roomType === room.roomType ? 2 : 1;
        const existing = overrideMap.get(dateKey);
        if (!existing || priority > existing.priority) {
            overrideMap.set(dateKey, { override, priority });
        }
    }

    return nights.map((date) => {
        const dateKey = date.toISOString().slice(0, 10);
        const override = overrideMap.get(dateKey)?.override;
        const day = date.getUTCDay();
        const weekend = day === 0 || day === 6;
        const base = weekend && room.weekendPriceUsdc != null
            ? room.weekendPriceUsdc
            : room.basePriceUsdc;
        return {
            date: dateKey,
            priceUsdc: override ? override.priceUsdc : base,
            source: override ? 'OVERRIDE' : weekend && room.weekendPriceUsdc != null ? 'WEEKEND' : 'BASE',
        };
    });
}

module.exports = { startOfUtcDay, addUtcDays, findNightlyRates };
