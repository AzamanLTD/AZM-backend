// =============================================================================
// A tiny in-memory Prisma for the transit money-path suites
// (transit-wallet-pay.test.js, transit-id-boarding.test.js).
//
// It implements only what those services call: equality, null, the
// operators below (every operator in a condition must hold), nested object
// matching, and `is` on a relation the table knows how to resolve. Rows are
// live objects, so a test can read or change state directly.
// =============================================================================

const num = (v) => Number(v);
const _ms = (v) => +new Date(v);

const OPS = {
    in: (v, x) => x.includes(v),
    notIn: (v, x) => !x.includes(v),
    equals: (v, x) => v === x,
    gte: (v, x) => num(v) >= num(x),
    gt: (v, x) => v != null && num(v) > num(x),
    lt: (v, x) => v != null && _ms(v) < _ms(x),
    lte: (v, x) => v != null && _ms(v) <= _ms(x),
    not: (v, x) => (x === null ? v !== null && v !== undefined : v !== x),
};

function matches(row, where = {}, rel = null) {
    return Object.entries(where).every(([k, cond]) => {
        const v = row[k];
        if (cond === null) return v === null || v === undefined;
        if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
            if ('is' in cond) {
                const related = rel ? rel(row, k) : v;
                return !!related && matches(related, cond.is);
            }
            const keys = Object.keys(cond);
            if (keys.length > 0 && keys.every((op) => op in OPS)) {
                return keys.every((op) => OPS[op](v, cond[op]));
            }
            return Object.entries(cond).every(([ck, cv]) => matches(v || {}, { [ck]: cv }));
        }
        return v === cond;
    });
}

function applyData(row, data) {
    for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
            row[k] = num(row[k] || 0) + ('increment' in v ? num(v.increment) : -num(v.decrement));
        } else {
            row[k] = v;
        }
    }
    return row;
}

// `rel(row, key)` resolves a relation for `is` filters (optional).
function table(rows, rel = null) {
    let seq = 0;
    const hit = (where) => (r) => matches(r, where, rel);
    return {
        rows,
        findUnique: jest.fn(async ({ where }) => rows.find(hit(where)) || null),
        findFirst: jest.fn(async ({ where } = {}) => rows.find(hit(where || {})) || null),
        findMany: jest.fn(async ({ where } = {}) => rows.filter(hit(where || {}))),
        count: jest.fn(async ({ where } = {}) => rows.filter(hit(where || {})).length),
        create: jest.fn(async ({ data }) => { const r = { id: data.id || `id-${rows.length + 1}-${++seq}`, ...data }; rows.push(r); return r; }),
        createMany: jest.fn(async ({ data }) => { data.forEach((d) => rows.push({ ...d })); return { count: data.length }; }),
        update: jest.fn(async ({ where, data }) => applyData(rows.find(hit(where)), data)),
        updateMany: jest.fn(async ({ where, data }) => {
            const found = rows.filter(hit(where));
            found.forEach((r) => applyData(r, data));
            return { count: found.length };
        }),
        upsert: jest.fn(async ({ where, create }) => rows.find(hit(where)) || (rows.push({ ...create }), create)),
        deleteMany: jest.fn(async ({ where }) => {
            const keep = rows.filter((r) => !matches(r, where, rel));
            const n = rows.length - keep.length;
            rows.splice(0, rows.length, ...keep);
            return { count: n };
        }),
    };
}

const LAYOUT = [
    { seatId: '1A', row: 1, col: 1, type: 'WINDOW' },
    { seatId: '1B', row: 1, col: 2, type: 'AISLE' },
    { seatId: '2A', row: 2, col: 1, type: 'WINDOW', tier: 'VIP' },
];
const DAY = 24 * 60 * 60 * 1000;

// One trip (operator 20 owns bp-1), a passenger (10) with a wallet, and the
// tables the booking, escrow and ledger paths touch.
function makeDb({ passengerBalance = 100, operatorId = 20, fee = null, departInDays = 3 } = {}) {
    const db = {
        transitTrip: table([{
            id: 'trip-1', businessProfileId: 'bp-1', vehicleId: 'v-1', status: 'SCHEDULED',
            routeName: 'Circle - Madina',
            origin: 'Circle', destination: 'Madina', departureAt: new Date(Date.now() + departInDays * DAY),
            fareUsdc: 2, availableSeats: 3, metadata: { tierFares: { VIP: 5 } },
            vehicle: { seatMap: { layout: LAYOUT } },
            businessProfile: { id: 'bp-1', userId: operatorId, isSuspended: false },
        }]),
        transitBookingSeat: table([]),
        transitBooking: table([], (row, key) => (key === 'escrow'
            ? db.smartEscrow.rows.find((e) => e.id === row.escrowId) || null
            : row[key])),
        globalSettings: table([{ id: 1, smartEscrowFeePct: fee, escrowFundedExpiryDays: 30 }]),
        user: table([
            {
                id: 10, availableBalance: passengerBalance, escrowLockedBalance: 0,
                azamanId: 'AZM-000000010', username: 'ama', displayName: 'Ama',
                legalName: 'Ama Owusu', profilePictureUrl: 'https://img.test/ama.png', kycStatus: 'VERIFIED',
            },
            { id: operatorId, availableBalance: 0, escrowLockedBalance: 0, azamanId: 'AZM-000000020', username: 'operator' },
        ]),
        ticket: table([]),
        smartEscrow: table([]),
        systemProfitFees: table([{ id: 1, balance: 0 }]),
        transactionHistory: table([]),
        adminProfitLog: table([]),
        financialOperation: table([{ id: 'op-1', status: 'IN_PROGRESS' }]),
        businessProfile: table([{ id: 'bp-1', userId: operatorId, businessName: 'Kofi Express' }]),
        reservation: table([]),
        $executeRaw: jest.fn(async () => 1),
    };
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}

module.exports = { num, matches, applyData, table, LAYOUT, DAY, makeDb };
