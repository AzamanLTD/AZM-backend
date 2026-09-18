jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messagingChannels', () => ({
    notifyBookingConfirmed: jest.fn().mockResolvedValue(undefined),
}));

const { randomUUID } = require('crypto');
const {
    createBookingEscrow,
    fundBookingEscrow,
    releaseBookingEscrow,
    refundBookingEscrow,
    splitReleaseFundedEscrow,
} = require('../services/bookingEscrowService');

function baseEscrow(overrides = {}) {
    return {
        id: 'escrow-1',
        ticketId: 'ticket-1',
        payerId: 10,
        payeeId: 20,
        amountUsdc: 100,
        feeUsdc: 0.5,
        status: 'DRAFT',
        ...overrides,
    };
}

function makeTx(overrides = {}) {
    return {
        ticket: {
            create: jest.fn().mockResolvedValue({ id: 'ticket-1' }),
        },
        smartEscrow: {
            create: jest.fn().mockResolvedValue(baseEscrow()),
            findUnique: jest.fn().mockResolvedValue(baseEscrow()),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        reservation: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        transitBooking: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        user: {
            findUnique: jest.fn().mockResolvedValue({ availableBalance: 250, phoneNumber: '+233000000000' }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({}),
        },
        systemProfitFees: {
            upsert: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
        },
        transactionHistory: {
            create: jest.fn().mockResolvedValue({}),
        },
        adminProfitLog: {
            create: jest.fn().mockResolvedValue({}),
        },
        // §P.4 ledger posting surface — the authoritative settlement now
        // runs inside the same mocked transaction.
        ledgerAccount: {
            upsert: jest.fn(({ create }) => ({ ...create })),
        },
        ledgerTransaction: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'lt-1', postingHash: 'h' }),
        },
        journalEntry: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({}),
        },
        ...overrides,
    };
}

function makePrisma(tx, overrides = {}) {
    return {
        globalSettings: {
            findUnique: jest.fn().mockResolvedValue({ smartEscrowFeePct: 0.005, escrowFundedExpiryDays: 30 }),
        },
        reservation: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'booking-1', status: 'CONFIRMED', businessProfileId: 'business-1',
                reservationTime: new Date(), user: { phoneNumber: '+233000000000' },
            }),
        },
        transitBooking: {
            findUnique: jest.fn().mockResolvedValue({
                id: 'booking-1', status: 'CONFIRMED', businessProfileId: 'business-1',
                trip: { businessProfileId: 'business-1', scheduledDeparture: new Date() },
                user: { phoneNumber: '+233000000000' },
            }),
        },
        $transaction: jest.fn(async (cb) => cb(tx)),
        ...overrides,
    };
}

describe('booking escrow financial integrity', () => {
    test('creates ticket, escrow, and booking linkage inside one transaction', async () => {
        const tx = makeTx({
            reservation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        });
        const prisma = makePrisma(tx);

        const result = await createBookingEscrow(prisma, {
            bookingType: 'RESERVATION', bookingId: 'booking-1', payerId: 10, payeeId: 20,
            amountUsdc: 100, businessProfileId: 'business-1', deliveryTerms: 'hotel stay',
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.ticket.create).toHaveBeenCalledTimes(1);
        expect(tx.smartEscrow.create).toHaveBeenCalledTimes(1);
        expect(tx.reservation.updateMany).toHaveBeenCalledWith({
            where: { id: 'booking-1', escrowId: null },
            data: expect.objectContaining({ escrowId: 'escrow-1', ticketId: 'ticket-1' }),
        });
        expect(result.escrow.id).toBe('escrow-1');
    });

    test('rejects a concurrent booking linkage conflict without leaving the new aggregate committed', async () => {
        const tx = makeTx({
            reservation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        });
        const prisma = makePrisma(tx);

        await expect(createBookingEscrow(prisma, {
            bookingType: 'RESERVATION', bookingId: 'booking-1', payerId: 10, payeeId: 20,
            amountUsdc: 100, businessProfileId: 'business-1',
        })).rejects.toMatchObject({ code: 'BOOKING_ESCROW_LINK_CONFLICT' });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    test('uses a conditional balance claim before funding the escrow', async () => {
        const tx = makeTx();
        const prisma = makePrisma(tx);

        await fundBookingEscrow(prisma, {
            escrowId: 'escrow-1', payerId: 10, bookingType: 'RESERVATION', bookingId: 'booking-1',
        });

        expect(tx.user.updateMany).toHaveBeenCalledWith({
            where: { id: 10, availableBalance: { gte: 100.5 } },
            data: { availableBalance: { decrement: 100.5 } },
        });
        expect(tx.smartEscrow.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'escrow-1', status: 'DRAFT', payerId: 10 },
            data: expect.objectContaining({ status: 'FUNDED' }),
        }));
        expect(tx.reservation.updateMany).toHaveBeenCalledTimes(1);
    });

    test('does not mutate funds when the conditional balance claim loses the race', async () => {
        const tx = makeTx({
            user: {
                findUnique: jest.fn().mockResolvedValue({ availableBalance: 1000 }),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest.fn().mockResolvedValue({}),
            },
        });
        const prisma = makePrisma(tx);

        await expect(fundBookingEscrow(prisma, {
            escrowId: 'escrow-1', payerId: 10,
            bookingType: 'RESERVATION', bookingId: 'booking-1',
        })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

        expect(tx.user.update).not.toHaveBeenCalled();
        expect(tx.systemProfitFees.update).not.toHaveBeenCalled();
        expect(tx.smartEscrow.updateMany).not.toHaveBeenCalled();
        expect(tx.transactionHistory.create).not.toHaveBeenCalled();
    });

    test('release and refund claim the current escrow row inside their transaction', async () => {
        for (const operation of [releaseBookingEscrow, refundBookingEscrow]) {
            const tx = makeTx({
                smartEscrow: {
                    findUnique: jest.fn().mockResolvedValue(baseEscrow({ status: 'FUNDED' })),
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
            });
            const prisma = makePrisma(tx);

            await operation(prisma, { escrowId: 'escrow-1' });

            expect(prisma.$transaction).toHaveBeenCalledTimes(1);
            expect(tx.smartEscrow.findUnique).toHaveBeenCalledTimes(2);
            expect(tx.smartEscrow.updateMany).toHaveBeenCalledTimes(1);
        }
    });

    test('split release records the booking NO_SHOW transition inside the same transaction', async () => {
        const tx = makeTx({
            smartEscrow: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(baseEscrow({ status: 'FUNDED' }))
                    .mockResolvedValueOnce(baseEscrow({ status: 'RELEASED' })),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        });
        const prisma = makePrisma(tx);

        const result = await splitReleaseFundedEscrow(prisma, {
            escrowId: 'escrow-1', penaltyPct: 0.1,
            bookingType: 'RESERVATION', bookingId: 'booking-1', reason: 'customer no-show',
        });

        expect(result.penaltyAmount).toBe(10);
        expect(tx.reservation.updateMany).toHaveBeenCalledWith({
            where: { id: 'booking-1' },
            data: expect.objectContaining({ status: 'NO_SHOW', penaltyAmountUsdc: 10 }),
        });
        expect(tx.transactionHistory.create).toHaveBeenCalledTimes(2);
    });
});
