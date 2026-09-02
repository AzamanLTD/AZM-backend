jest.mock('../controllers/reservationController', () => ({
    createReservation: jest.fn((req, res) => {
        return res.status(201).json({ success: true, reservation: { amountUsdc: req.body.amountUsdc } });
    }),
}));

const { createReservation } = require('../controllers/reservationController');
const hotelController = require('../controllers/hotelMarketplaceController');

function responseDouble() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

describe('hotelMarketplaceController', () => {
    beforeEach(() => jest.clearAllMocks());

    test('exposes HotelRoom inventory with explicit floor and status', async () => {
        const prisma = {
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'business-1',
                    bizId: 'BIZ-HOTEL',
                    businessName: 'Harbour House',
                    category: 'HOSPITALITY',
                    description: null,
                    website: null,
                    logoUrl: null,
                    coverPhotoUrl: null,
                    phoneNumber: null,
                    contactEmail: null,
                    address: 'Accra',
                    country: 'GH',
                    isVerified: true,
                    isSuspended: false,
                    isPausedByOwner: false,
                    kybStatus: 'VERIFIED',
                    totalEscrows: 0,
                    completedEscrows: 0,
                    totalVolume: 0,
                    averageRating: 4.8,
                    reviewCount: 12,
                    businessMeta: {},
                    locations: [],
                    products: [],
                    hotelRooms: [{
                        id: 'room-7',
                        businessProfileId: 'business-1',
                        locationId: 'location-1',
                        roomNumber: '701',
                        roomType: 'SUITE',
                        floor: 7,
                        capacity: 3,
                        bedConfig: '1 KING',
                        status: 'AVAILABLE',
                        basePriceUsdc: '110.00',
                        weekendPriceUsdc: '135.00',
                        amenities: ['AC', 'WIFI'],
                        imageUrls: ['https://example.test/room.jpg'],
                    }],
                }),
            },
        };
        const req = { params: { bizId: 'BIZ-HOTEL' }, app: { get: () => prisma } };
        const res = responseDouble();

        await hotelController.getBusinessDetail(req, res);

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            data: expect.objectContaining({
                hotelRooms: [expect.objectContaining({
                    id: 'room-7',
                    roomNumber: '701',
                    floor: 7,
                    roomType: 'SUITE',
                    status: 'AVAILABLE',
                    basePriceUsdc: 110,
                    weekendPriceUsdc: 135,
                })],
            }),
        }));
    });

    test('calculates nightly hotel total from authoritative rate data before delegating reservation creation', async () => {
        const prisma = {
            businessProfile: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({
                        id: 'business-1',
                        bizId: 'BIZ-HOTEL',
                        category: 'HOSPITALITY',
                        isSuspended: false,
                        isPausedByOwner: false,
                    }),
            },
            hotelRoom: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'room-7',
                    businessProfileId: 'business-1',
                    locationId: 'location-1',
                    roomNumber: '701',
                    roomType: 'SUITE',
                    capacity: 3,
                    status: 'AVAILABLE',
                    basePriceUsdc: '100.00',
                    weekendPriceUsdc: '120.00',
                }),
            },
            hotelRoomBlock: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
            hotelRateOverride: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 'override-1',
                    businessProfileId: 'business-1',
                    roomType: 'SUITE',
                    roomId: null,
                    date: new Date('2026-09-05T00:00:00.000Z'),
                    priceUsdc: '150.00',
                    note: 'Weekend event',
                }]),
            },
        };
        const req = {
            params: { bizId: 'BIZ-HOTEL' },
            body: {
                roomId: 'room-7',
                checkInDate: '2026-09-04T00:00:00.000Z',
                checkOutDate: '2026-09-06T00:00:00.000Z',
                partySize: 2,
            },
            app: { get: () => prisma },
            user: { id: 44 },
        };
        const res = responseDouble();

        await hotelController.createHotelReservation(req, res);

        expect(createReservation).toHaveBeenCalledTimes(1);
        expect(createReservation.mock.calls[0][0].body).toEqual(expect.objectContaining({
            bizId: 'BIZ-HOTEL',
            serviceItemId: 'room-7',
            amountUsdc: '270.00000000',
            partySize: 2,
        }));
    });
});
