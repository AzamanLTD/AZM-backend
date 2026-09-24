'use strict';

// __tests__/r39-exact-invoice-authority.test.js
// =============================================================================
// r39/P1 — EXACT INVOICE AUTHORITY: strict quantity contract + exact-decimal
// idempotency fingerprint. Three proof layers:
//
//   1. exactInvoiceMath unit proofs — the strict quantity parser (every
//      invalid class rejects, valid integers preserved), the Decimal(20,8)
//      persistence-envelope invariant (huge quantity/overflow rejected BEFORE
//      persistence), the 0.12345678 / 5% / 0.00617284 quantization contract,
//      multi-tax-line reconciliation, and ordinary 2dp regression behavior.
//   2. Fingerprint proofs through the REAL replay-boundary function —
//      exact 8dp replay identity, and the large-magnitude float64-collapse
//      regression: two DISTINCT 8dp decimal intents that Number() would
//      collapse must still mismatch (409), never silently replay.
//   3. REAL PostgreSQL proofs — the same contracts exercised through the
//      canonical creation boundary against the disposable test database
//      (create -> replay -> mismatched replay -> overflow refusal), so the
//      fingerprint and the execution path are proven identical on real rows.
// =============================================================================

const { Prisma } = require('@prisma/client');
const {
    parseStrictQuantity,
    computeInvoiceTotalsExact,
    computeLineItemsExact,
    computeTaxLinesExact,
    MAX_PERSISTABLE,
    MAX_REASONABLE_QUANTITY,
} = require('../utils/exactInvoiceMath');
const boundary = require('../services/businessInvoiceCreationBoundary');

// Asserts fn() throws the intent-mismatch refusal (409 IDEMPOTENCY_INTENT_MISMATCH).
const expectIntentMismatch = (fn) => {
    let thrown = null;
    try { fn(); } catch (e) { thrown = e; }
    expect(thrown).not.toBeNull();
    expect(thrown.code).toBe('IDEMPOTENCY_INTENT_MISMATCH');
    expect(thrown.status).toBe(409);
};

// ---------------------------------------------------------------------------
// 1. STRICT QUANTITY CONTRACT (unit proofs)
// ---------------------------------------------------------------------------
describe('r39 exact invoice authority — strict quantity contract', () => {
    test('preserves valid integer quantities exactly (number and canonical string forms)', () => {
        expect(parseStrictQuantity(1)).toBe(1);
        expect(parseStrictQuantity(2)).toBe(2);
        expect(parseStrictQuantity('2')).toBe(2);
        expect(parseStrictQuantity(' 7 ')).toBe(7); // whitespace-padded integer string
        expect(parseStrictQuantity(1000000)).toBe(1000000);
        // 2.0 is an integral value — accepted as the integer 2 (JSON cannot
        // distinguish 2 from 2.0 anyway).
        expect(parseStrictQuantity(2.0)).toBe(2);
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['zero', 0],
        ['negative', -1],
        ['fractional number', 1.5],
        ['fractional via exponent literal', 5e-1],
        ['fractional string', '1.5'],
        ['exponent string', '1e2'],
        ['empty string', ''],
        ['whitespace string', '   '],
        ['non-numeric string', 'abc'],
        ['hex-ish string', '0x10'],
        ['underscored string', '1_000'],
        ['zero string', '0'],
        ['boolean true', true],
        ['boolean false', false],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['plain object', { toString: () => '2' }],
        ['array', ['2']],
        ['Decimal instance', new Prisma.Decimal(2)],
        ['unsafe magnitude number', 2 ** 53],
        ['unsafe magnitude string', '99999999999999999999'],
    ])('rejects invalid quantity class: %s', (_label, value) => {
        expect(() => parseStrictQuantity(value)).toThrow();
    });

    test('rejects unreasonable quantities BEFORE multiplication', () => {
        expect(MAX_REASONABLE_QUANTITY).toBe(1_000_000_000);
        expect(parseStrictQuantity(1_000_000_000)).toBe(1_000_000_000); // at the ceiling: legal
        expect(() => parseStrictQuantity(1_000_000_001)).toThrow(/unreasonably large/i);
        expect(() => parseStrictQuantity('1000000001')).toThrow(/unreasonably large/i);
    });

    test('computeLineItemsExact rejects malformed quantities instead of defaulting them to 1', () => {
        // The OLD parseInt-based code turned each of these into qty=1 — a
        // DIFFERENT economic request. Now they must throw.
        for (const quantity of [0, -2, 1.5, '1.5', '1e2', '', null, undefined, true, {}]) {
            expect(() => computeLineItemsExact([
                { description: 'Jollof', quantity, unitPrice: '20' },
            ])).toThrow();
        }
    });

    test('magnitude invariant: a legal unit price times a huge quantity is rejected before persistence', () => {
        const MAX_STRING = '999999999999.99999999';
        expect(MAX_PERSISTABLE.toFixed(8)).toBe(MAX_STRING);

        // At the envelope ceiling with qty=1: legal, preserved exactly.
        const atCeiling = computeLineItemsExact([
            { description: 'Gold bar', quantity: 1, unitPrice: MAX_STRING },
        ]);
        expect(atCeiling.lineItems[0].lineTotal.toFixed(8)).toBe(MAX_STRING);

        // Doubling overflows Decimal(20,8) — rejected HERE, not by the DB.
        expect(() => computeLineItemsExact([
            { description: 'Gold bar', quantity: 2, unitPrice: MAX_STRING },
        ])).toThrow(/persistence envelope/i);

        // A huge (but in-ceiling) quantity with a real price overflows —
        // rejected at the exact-math boundary before persistence.
        expect(() => computeLineItemsExact([
            { description: 'Grain', quantity: 1_000_000_000, unitPrice: '1000' },
        ])).toThrow(/persistence envelope/i);

        // Subtotal accumulation across lines is envelope-checked too.
        expect(() => computeLineItemsExact([
            { description: 'A', quantity: 1, unitPrice: '600000000000' },
            { description: 'B', quantity: 1, unitPrice: '600000000000' },
        ])).toThrow(/persistence envelope/i);

        // Bill total (subtotal + tax) is envelope-checked even when every
        // individual component fits: 9e11 subtotal + 9e11 flat tax = 1.8e12.
        expect(() => computeInvoiceTotalsExact(
            [{ description: 'A', quantity: 1, unitPrice: '900000000000' }],
            [{ name: 'VAT', type: 'FLAT', value: '900000000000' }],
        )).toThrow(/persistence envelope/i);
    });
});

// ---------------------------------------------------------------------------
// 1b. EXACT TAX / LINE MATH (unit proofs)
// ---------------------------------------------------------------------------
describe('r39 exact invoice authority — exact decimal math contracts', () => {
    test('0.12345678 line price is exact through the full invoice computation', () => {
        const { subtotal, taxTotal, billTotal, lineItems, taxLines } = computeInvoiceTotalsExact(
            [{ description: 'Bread', quantity: 1, unitPrice: '0.12345678' }],
            [{ name: 'VAT', type: 'PERCENTAGE', value: '5' }],
        );
        expect(subtotal.toFixed(8)).toBe('0.12345678');
        expect(lineItems[0].lineTotal.toFixed(8)).toBe('0.12345678');
        // 0.12345678 x 5% = 0.006172839 exact, quantized HALF_UP to 0.00617284.
        expect(taxLines[0].computedAmount.toFixed(8)).toBe('0.00617284');
        expect(taxTotal.toFixed(8)).toBe('0.00617284');
        expect(billTotal.toFixed(8)).toBe('0.12962962');
    });

    test('multiple tax lines reconcile exactly with the stored tax total', () => {
        const { subtotal } = computeLineItemsExact([
            { description: 'Bread', quantity: 1, unitPrice: '0.12345678' },
        ]);
        const { taxTotal, taxLines } = computeTaxLinesExact([
            { name: 'VAT', type: 'PERCENTAGE', value: '5' },
            { name: 'NHIL', type: 'PERCENTAGE', value: '2.5' },
            { name: 'Service', type: 'FLAT', value: '0.0001' },
        ], subtotal);
        // VAT: 0.006172839 -> 0.00617284 ; NHIL: 0.0030864195 -> 0.00308642
        // Service: flat 0.0001. Sum of QUANTIZED lines = stored total.
        expect(taxLines[0].computedAmount.toFixed(8)).toBe('0.00617284');
        expect(taxLines[1].computedAmount.toFixed(8)).toBe('0.00308642');
        expect(taxLines[2].computedAmount.toFixed(8)).toBe('0.00010000');
        const sum = taxLines.reduce((acc, l) => acc.plus(l.computedAmount), new Prisma.Decimal(0));
        expect(taxTotal.toFixed(8)).toBe(sum.toFixed(8));
        expect(taxTotal.toFixed(8)).toBe('0.00935926');
    });

    test('ordinary 2dp regression behavior remains unchanged', () => {
        const { subtotal, taxTotal, billTotal } = computeInvoiceTotalsExact(
            [
                { description: 'Meal', quantity: 2, unitPrice: 20 },
                { description: 'Drink', quantity: 3, unitPrice: '1.50' },
            ],
            [{ name: 'VAT', type: 'PERCENTAGE', value: 12.5 }],
        );
        expect(subtotal.toFixed(8)).toBe('44.50000000');
        expect(taxTotal.toFixed(8)).toBe('5.56250000');
        expect(billTotal.toFixed(8)).toBe('50.06250000');
    });
});

// ---------------------------------------------------------------------------
// 2. EXACT FINGERPRINT PROOFS (real replay-boundary function, no DB)
// ---------------------------------------------------------------------------
describe('r39 exact invoice authority — exact-decimal replay fingerprint', () => {
    const storedInvoice = (unitPrice, quantity) => ({
        businessProfileId: 'biz-1',
        customerId: 7,
        locationId: 'loc-1',
        tableId: 'table-1',
        businessNote: 'Lunch',
        lineItems: [{ description: 'Gold bar', quantity, unitPrice }],
        taxLines: [],
    });

    const request = (unitPrice, quantity) => ({
        businessProfileId: 'biz-1',
        customerId: 7,
        locationId: 'loc-1',
        tableId: 'table-1',
        businessNote: 'Lunch',
        lineItems: [{ description: 'Gold bar', quantity, unitPrice }],
        taxLines: [],
        idempotencyKey: 'r39-fingerprint-1',
    });

    test('exact 8dp replay identity: same exact decimal intent replays, regardless of wire form', () => {
        // Stored as Prisma.Decimal (the DB representation), requested as a
        // plain string/number — all canonicalize to the same exact value.
        const invoice = storedInvoice(new Prisma.Decimal('0.12345678'), 2);
        for (const unitPrice of ['0.12345678', 0.12345678, new Prisma.Decimal('0.12345678')]) {
            for (const quantity of [2, '2', 2.0]) {
                expect(() =>
                    boundary.assertReplayBelongsToIntent(invoice, request(unitPrice, quantity)),
                ).not.toThrow();
            }
        }
    });

    test('large-magnitude float64-collapse regression: two DISTINCT 8dp intents never compare equal', () => {
        // float64 collapses BOTH of these to the same number
        // (Number("999999999999.99999999") === Number("999999999999.99999998")),
        // so a Number()-based fingerprint would silently replay the WRONG
        // invoice. The exact canonical string fingerprint must still mismatch.
        expect(Number('999999999999.99999999')).toBe(Number('999999999999.99999998'));

        const invoice = storedInvoice(new Prisma.Decimal('999999999999.99999999'), 1);
        expectIntentMismatch(() =>
            boundary.assertReplayBelongsToIntent(invoice, request('999999999999.99999998', 1)));
        // And the mirror direction.
        const invoice2 = storedInvoice(new Prisma.Decimal('999999999999.99999998'), 1);
        expectIntentMismatch(() =>
            boundary.assertReplayBelongsToIntent(invoice2, request('999999999999.99999999', 1)));
        // The identical intent still replays cleanly.
        expect(() =>
            boundary.assertReplayBelongsToIntent(invoice, request('999999999999.99999999', 1)),
        ).not.toThrow();
    });

    test('a mid-magnitude 8dp difference still mismatches (not only float64-collapse ranges)', () => {
        const invoice = storedInvoice(new Prisma.Decimal('12345678.12345678'), 1);
        expectIntentMismatch(() =>
            boundary.assertReplayBelongsToIntent(invoice, request('12345678.12345677', 1)));
    });

    test('quantity identity is strict on replay: malformed quantities are refused, never defaulted to 1', () => {
        const invoice = storedInvoice(new Prisma.Decimal('20'), 1);
        for (const quantity of [0, 1.5, '1.5', '1e2', '', null, undefined, true]) {
            expect(() =>
                boundary.assertReplayBelongsToIntent(invoice, request('20', quantity)),
            ).toThrow();
        }
        // A genuinely different quantity is an intent mismatch (409), while
        // a malformed quantity is a strict parse refusal — both refuse;
        // neither silently reshapes the request.
        expectIntentMismatch(() =>
            boundary.assertReplayBelongsToIntent(invoice, request('20', 3)));
    });

    test('tax fingerprints compare exact 4dp canonical values, never Number coercion', () => {
        const invoice = {
            businessProfileId: 'biz-1',
            customerId: 7,
            locationId: 'loc-1',
            tableId: 'table-1',
            businessNote: 'Lunch',
            lineItems: [{ description: 'Meal', quantity: 2, unitPrice: '20' }],
            taxLines: [{ name: 'VAT', type: 'PERCENTAGE', value: new Prisma.Decimal('12.5000') }],
        };
        const req = (value) => ({
            businessProfileId: 'biz-1',
            customerId: 7,
            locationId: 'loc-1',
            tableId: 'table-1',
            businessNote: 'Lunch',
            lineItems: [{ description: 'Meal', quantity: 2, unitPrice: '20' }],
            taxLines: [{ name: 'VAT', type: 'PERCENTAGE', value }],
            idempotencyKey: 'r39-fingerprint-2',
        });

        // Same exact tax intent in different wire forms: replays.
        expect(() => boundary.assertReplayBelongsToIntent(invoice, req(12.5))).not.toThrow();
        expect(() => boundary.assertReplayBelongsToIntent(invoice, req('12.5'))).not.toThrow();
        // Different exact value: mismatch.
        expectIntentMismatch(() => boundary.assertReplayBelongsToIntent(invoice, req('12.501')));
        // >4dp tax value is refused (the Decimal(10,4) column ceiling the
        // execution path enforces), not silently rounded into a false match.
        expect(() => boundary.assertReplayBelongsToIntent(invoice, req('12.50001')))
            .toThrow(/4 decimal places/i);
    });
});

// ---------------------------------------------------------------------------
// 3. REAL POSTGRESQL PROOFS (disposable test database)
// ---------------------------------------------------------------------------
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('r39 exact invoice authority — real PostgreSQL boundary proofs', () => {
    const { PrismaClient } = require('@prisma/client');
    const { seedUser, seedBusiness } = require('./helpers/factories');

    let prisma;
    let customer;
    let business;
    const createdInvoiceIds = [];
    const createdUserIds = [];
    const createdBusinessIds = [];

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        prisma = new PrismaClient();
        customer = await seedUser(prisma, {});
        const seeded = await seedBusiness(prisma, {});
        business = seeded;
        createdUserIds.push(customer.id, business.owner.id);
        createdBusinessIds.push(business.biz.id);
    });

    afterAll(async () => {
        if (prisma) {
            for (const id of createdInvoiceIds) {
                await prisma.businessInvoice.deleteMany({ where: { id } }).catch(() => {});
            }
            for (const id of createdBusinessIds) {
                await prisma.businessProfile.deleteMany({ where: { id } }).catch(() => {});
            }
            for (const id of createdUserIds) {
                await prisma.transactionHistory.deleteMany({ where: { userId: id } }).catch(() => {});
                await prisma.user.deleteMany({ where: { id } }).catch(() => {});
            }
            await prisma.$disconnect().catch(() => {});
        }
    });

    const baseArgs = (lineItems, taxLines, key) => ({
        businessProfileId: business.biz.id,
        customerId: customer.id,
        lineItems,
        taxLines,
        idempotencyKey: key,
    });

    test('creates an exact 8dp invoice through the real boundary and replays it byte-identically', async () => {
        const key = `r39-exact-${Date.now()}`;
        const lineItems = [{ description: 'Bread', quantity: 1, unitPrice: '0.12345678' }];
        const taxLines = [{ name: 'VAT', type: 'PERCENTAGE', value: '5' }];

        const first = await boundary.createInvoice(prisma, baseArgs(lineItems, taxLines, key));
        expect(first.replayed).toBe(false);
        createdInvoiceIds.push(first.invoice.id);

        // Persisted exact-decimal contracts.
        const row = await prisma.businessInvoice.findUnique({
            where: { id: first.invoice.id },
            include: { lineItems: true, taxLines: true },
        });
        expect(row.subtotalUsdc.toFixed(8)).toBe('0.12345678');
        expect(row.lineItems[0].lineTotal.toFixed(8)).toBe('0.12345678');
        expect(row.lineItems[0].quantity).toBe(1);
        expect(row.taxLines[0].computedAmount.toFixed(8)).toBe('0.00617284');
        expect(row.taxTotalUsdc.toFixed(8)).toBe('0.00617284');
        expect(row.billTotalUsdc.toFixed(8)).toBe('0.12962962');

        // Exact replay: same key + same exact intent -> the SAME invoice,
        // regardless of quantity/unitPrice wire form.
        const replay = await boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Bread', quantity: '1', unitPrice: 0.12345678 }],
            [{ name: 'VAT', type: 'PERCENTAGE', value: 5 }],
            key,
        ));
        expect(replay.replayed).toBe(true);
        expect(replay.invoice.id).toBe(first.invoice.id);
        expect(await prisma.businessInvoice.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    test('multi-tax-line invoices persist lines that reconcile exactly with the stored tax total', async () => {
        const key = `r39-multitax-${Date.now()}`;
        const { invoice } = await boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Bread', quantity: 1, unitPrice: '0.12345678' }],
            [
                { name: 'VAT', type: 'PERCENTAGE', value: '5' },
                { name: 'NHIL', type: 'PERCENTAGE', value: '2.5' },
                { name: 'Service', type: 'FLAT', value: '0.0001' },
            ],
            key,
        ));
        createdInvoiceIds.push(invoice.id);

        const row = await prisma.businessInvoice.findUnique({
            where: { id: invoice.id },
            include: { taxLines: true },
        });
        const amounts = row.taxLines.map((l) => l.computedAmount.toFixed(8));
        expect(amounts.sort()).toEqual(['0.00010000', '0.00308642', '0.00617284']);
        const sum = row.taxLines.reduce((acc, l) => acc.plus(l.computedAmount), new Prisma.Decimal(0));
        expect(row.taxTotalUsdc.toFixed(8)).toBe(sum.toFixed(8));
        expect(row.taxTotalUsdc.toFixed(8)).toBe('0.00935926');
    });

    test('float64-collapse regression on real rows: a distinct large-magnitude 8dp intent is refused, not replayed', async () => {
        // These two unit prices are indistinguishable as float64.
        expect(Number('999999999999.99999999')).toBe(Number('999999999999.99999998'));

        const key = `r39-collapse-${Date.now()}`;
        const { invoice } = await boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Gold bar', quantity: 1, unitPrice: '999999999999.99999999' }],
            [],
            key,
        ));
        createdInvoiceIds.push(invoice.id);

        // The stored row kept the exact 8dp value (no float64 loss on the way in).
        const row = await prisma.businessInvoice.findUnique({
            where: { id: invoice.id },
            include: { lineItems: true },
        });
        expect(row.lineItems[0].unitPrice.toFixed(8)).toBe('999999999999.99999999');
        expect(row.billTotalUsdc.toFixed(8)).toBe('999999999999.99999999');

        // The float64-collapsed twin is a DIFFERENT economic intent: 409.
        await expect(boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Gold bar', quantity: 1, unitPrice: '999999999999.99999998' }],
            [],
            key,
        ))).rejects.toMatchObject({
            code: 'IDEMPOTENCY_INTENT_MISMATCH',
            status: 409,
        });

        // The identical exact intent still replays the same row.
        const replay = await boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Gold bar', quantity: 1, unitPrice: '999999999999.99999999' }],
            [],
            key,
        ));
        expect(replay.replayed).toBe(true);
        expect(replay.invoice.id).toBe(invoice.id);
    });

    test('overflow and malformed-quantity requests are refused BEFORE persistence (no row created)', async () => {
        // Huge in-ceiling quantity that overflows Decimal(20,8).
        const overflowKey = `r39-overflow-${Date.now()}`;
        await expect(boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Grain', quantity: 1_000_000_000, unitPrice: '1000' }],
            [],
            overflowKey,
        ))).rejects.toThrow(/persistence envelope/i);
        expect(await prisma.businessInvoice.count({ where: { idempotencyKey: overflowKey } })).toBe(0);

        // Quantity above the unreasonable ceiling: rejected before multiplication.
        const absurdKey = `r39-absurd-${Date.now()}`;
        await expect(boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Grain', quantity: 2_000_000_000, unitPrice: '0.01' }],
            [],
            absurdKey,
        ))).rejects.toThrow(/unreasonably large/i);
        expect(await prisma.businessInvoice.count({ where: { idempotencyKey: absurdKey } })).toBe(0);

        // Malformed quantity: refused, never silently defaulted to 1.
        const malformedKey = `r39-malformed-${Date.now()}`;
        await expect(boundary.createInvoice(prisma, baseArgs(
            [{ description: 'Jollof', quantity: '1.5', unitPrice: '20' }],
            [],
            malformedKey,
        ))).rejects.toThrow();
        expect(await prisma.businessInvoice.count({ where: { idempotencyKey: malformedKey } })).toBe(0);
    });

    test('ordinary 2dp invoices still work end-to-end through the real boundary', async () => {
        const key = `r39-2dp-${Date.now()}`;
        const { invoice, replayed } = await boundary.createInvoice(prisma, baseArgs(
            [
                { description: 'Meal', quantity: 2, unitPrice: 20 },
                { description: 'Drink', quantity: 3, unitPrice: '1.50' },
            ],
            [{ name: 'VAT', type: 'PERCENTAGE', value: 12.5 }],
            key,
        ));
        expect(replayed).toBe(false);
        createdInvoiceIds.push(invoice.id);

        const row = await prisma.businessInvoice.findUnique({ where: { id: invoice.id } });
        expect(row.subtotalUsdc.toFixed(8)).toBe('44.50000000');
        expect(row.taxTotalUsdc.toFixed(8)).toBe('5.56250000');
        expect(row.billTotalUsdc.toFixed(8)).toBe('50.06250000');
    });
});
