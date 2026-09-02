'use strict';

/**
 * Customer-facing hotel marketplace adapter.
 *
 * Hotel inventory lives in HotelRoom/HotelRateOverride/HotelRoomBlock, not in
 * BusinessProduct. This controller exposes that domain without creating a
 * second reservation engine: reservation creation is delegated to the
 * canonical reservationController after authoritative room/rate validation.
 */

const { Prisma } = require('@prisma/client');
const reservationController = require('./reservationController');

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

function toPublicRoom(room) {
    return {
        id: room.id,
        businessProfileId: room.businessProfileId,
        locationId: room.locationId,
        roomNumber: room.roomNumber,
        roomType: room.roomType,
        floor: room.floor,
        capacity: room.capacity,
        bedConfig: room.bedConfig,
        status: room.status,
        basePriceUsdc: Number(room.basePriceUsdc),
        weekendPriceUsdc: room.weekendPriceUsdc == null ? null : Number(room.weekendPriceUsdc),
        amenities: room.amenities || [],
        imageUrls: room.imageUrls || [],
    };
}

function toPublicBusinessMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const publicMeta = {};
    if (Array.isArray(meta.showcaseUrls)) {
        publicMeta.showcaseUrls = meta.showcaseUrls.filter((url) => typeof url === 'string').slice(0, 20);
    }
    if (meta.penaltyPolicy && typeof meta.penaltyPolicy === 'object') {
        const penaltyPct = Number(meta.penaltyPolicy.penaltyPct);
        const gracePeriodMins = Number(meta.penaltyPolicy.gracePeriodMins);
        if (Number.isFinite(penaltyPct) || Number.isFinite(gracePeriodMins)) {
            publicMeta.penaltyPolicy = {
                ...(Number.isFinite(penaltyPct) ? { penaltyPct } : {}),
                ...(Number.isFinite(gracePeriodMins) ? { gracePeriodMins } : {}),
            };
        }
    }
    return Object.keys(publicMeta).length ? publicMeta : null;
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

exports.getBusinessDetail = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { bizId } = req.params;

    const business = await prisma.businessProfile.findUnique({
        where: { bizId },
        select: {
            id: true,
            bizId: true,
            businessName: true,
            category: true,
            description: true,
            website: true,
            logoUrl: true,
            coverPhotoUrl: true,
            phoneNumber: true,
            contactEmail: true,
            address: true,
            country: true,
            isVerified: true,
            isSuspended: true,
            isPausedByOwner: true,
            kybStatus: true,
            totalEscrows: true,
            completedEscrows: true,
            totalVolume: true,
            averageRating: true,
            reviewCount: true,
            businessMeta: true,
            locations: {
                where: { isActive: true },
                orderBy: [{ isPrimary: 'desc' }, { label: 'asc' }],
            },
            products: {
                where: { isActive: true, isAvailable: true },
                orderBy: [{ catalogSectionId: 'asc' }, { name: 'asc' }],
            },
            hotelRooms: {
                where: { status: { not: 'MAINTENANCE' } },
                orderBy: [{ floor: 'asc' }, { roomNumber: 'asc' }],
            },
        },
    });

    if (!business || business.isSuspended) {
        return res.status(404).json({ success: false, message: 'Business not found.' });
    }

    const isHotel = business.category === 'HOSPITALITY';
    const products = business.products.map((product) => ({
        ...product,
        priceUsdc: Number(product.priceUsdc),
        totalRevenue: Number(product.totalRevenue),
        imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
        variants: product.variants ?? null,
        modifierGroups: product.modifierGroups ?? null,
    }));

    return res.json({
        success: true,
        data: {
            business: {
                ...business,
                businessMeta: toPublicBusinessMeta(business.businessMeta),
                totalVolume: Number(business.totalVolume),
                averageRating: Number(business.averageRating),
                products,
                locations: business.locations,
            },
            products,
            hotelRooms: isHotel ? business.hotelRooms.map(toPublicRoom) : [],
        },
    });
};

exports.createHotelReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { bizId } = req.params;
    const { checkInDate, checkOutDate, roomId, productId, partySize, customerNotes } = req.body || {};
    const selectedRoomId = roomId || productId;

    if (!selectedRoomId) {
        return res.status(400).json({ success: false, message: 'roomId is required.' });
    }

    const checkInDay = startOfUtcDay(checkInDate);
    const checkOutDay = startOfUtcDay(checkOutDate);
    if (!checkInDay || !checkOutDay || checkOutDay <= checkInDay) {
        return res.status(400).json({ success: false, message: 'Check-out must be after check-in.' });
    }

    const business = await prisma.businessProfile.findUnique({
        where: { bizId },
        select: { id: true, bizId: true, category: true, isSuspended: true, isPausedByOwner: true },
    });
    if (!business || business.isSuspended) {
        return res.status(404).json({ success: false, message: 'Business not found.' });
    }
    if (business.isPausedByOwner) {
        return res.status(409).json({ success: false, message: 'This hotel is temporarily unavailable for new bookings.' });
    }
    if (business.category !== 'HOSPITALITY') {
        return res.status(409).json({ success: false, message: 'This business is not configured as a hotel.' });
    }

    const room = await prisma.hotelRoom.findFirst({
        where: { id: selectedRoomId, businessProfileId: business.id },
    });
    if (!room) return res.status(404).json({ success: false, message: 'Room not found.' });
    if (room.status !== 'AVAILABLE') {
        return res.status(409).json({ success: false, message: `Room ${room.roomNumber} is currently ${room.status.toLowerCase()}.` });
    }

    const guests = Math.max(parseInt(partySize, 10) || 1, 1);
    if (guests > room.capacity) {
        return res.status(409).json({ success: false, message: `Room ${room.roomNumber} accommodates up to ${room.capacity} guest${room.capacity === 1 ? '' : 's'}.` });
    }

    const block = await prisma.hotelRoomBlock.findFirst({
        where: {
            roomId: room.id,
            startDate: { lt: checkOutDay },
            endDate: { gt: checkInDay },
        },
        select: { id: true, reason: true },
    });
    if (block) {
        return res.status(409).json({ success: false, message: block.reason ? `Room unavailable: ${block.reason}` : 'Room is unavailable for those dates.' });
    }

    const nightlyRates = await findNightlyRates(prisma, room, checkInDay, checkOutDay);
    const total = nightlyRates.reduce((sum, night) => sum.add(night.priceUsdc), new Prisma.Decimal(0));

    if (total.lte(0)) {
        return res.status(409).json({ success: false, message: 'Room pricing is not configured.' });
    }

    // Delegate the actual Reservation creation to the existing canonical
    // reservation controller so lifecycle/conflict semantics remain centralized.
    req.body = {
        bizId,
        locationId: room.locationId || undefined,
        serviceItemId: room.id,
        startDatetime: checkInDay.toISOString(),
        endDatetime: checkOutDay.toISOString(),
        partySize: guests,
        amountUsdc: total.toFixed(8),
        depositUsdc: '0',
        customerNotes: customerNotes || undefined,
    };

    return reservationController.createReservation(req, res);
};
