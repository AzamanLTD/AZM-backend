/**
 * Native-GHS invoices and tab finalisation, on real PostgreSQL.
 *
 * THE DEFECT THIS CLOSES: a cedi dine-in tab finalised and invoiced through the
 * USDC columns. `finalizeTab` summed `lineTotalUsdc` — zero on a cedi tab — so a
 * tab worth 12.65 GHS finalised at 0.00, and `confirmAndPay` then built the
 * invoice from `Number(item.unitPriceUsdc)`, billing the customer nothing while
 * labelling the result USDC.
 *
 * Now the tab's currency decides which durable columns carry the money, the
 * invoice inherits that currency, and a cedi bill carries cedi figures at exact
 * 2dp with the USDC columns at zero.
 *
 * PAYMENT is deliberately NOT faked: this rail moves USDC, so a GHS bill is
 * refused with GHS_PAYMENT_RAIL_UNAVAILABLE rather than charging an invented
 * rate. Cash handed to the merchant settles through the cash-close path, which
 * records native cedis.
 */
const { PrismaClient, Prisma } = require('@prisma/client');
const invoiceSvc = require('../services/businessInvoiceService');
const DineInService = require('../services/marketplace/dineInService');

const url = process.env.TEST_DATABASE_URL;
if (!url) console.warn('[invoice-ghs] TEST_DATABASE_URL not set — skipping.');
const run = url ? describe : describe.skip;

run('native-GHS invoices and tab finalisation (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });

    async function cleanup() {
        const profiles = await db.businessProfile.findMany({
            where: { businessName: { startsWith: 'InvoiceGhs Test' } }, select: { id: true },
        });
        const ids = profiles.map((p) => p.id);
        if (ids.length) {
            const invoices = await db.businessInvoice.findMany({ where: { businessProfileId: { in: ids } }, select: { id: true } });
            const invIds = invoices.map((i) => i.id);
            if (invIds.length) {
                await db.businessInvoiceLineItem.deleteMany({ where: { invoiceId: { in: invIds } } });
                await db.businessInvoiceTaxLine.deleteMany({ where: { invoiceId: { in: invIds } } });
            }
            const tabs = await db.dineInTab.findMany({ where: { businessProfileId: { in: ids } }, select: { id: true } });
            const tabIds = tabs.map((t) => t.id);
            if (tabIds.length) {
                await db.dineInTabItem.deleteMany({ where: { dineInTabId: { in: tabIds } } });
                await db.dineInTab.deleteMany({ where: { id: { in: tabIds } } });
            }
            await db.businessInvoice.deleteMany({ where: { id: { in: invIds } } });
            await db.businessLedgerEntry.deleteMany({ where: { businessProfileId: { in: ids } } });
            await db.businessTaxPreset.deleteMany({ where: { businessProfileId: { in: ids } } });
        }
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'InvoiceGhs Test' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'invoiceghs-user' } } });
    }

    beforeEach(cleanup);
    afterAll(cleanup);

    async function seed({ vat = null } = {}) {
        seq += 1;
        const owner = await db.user.create({
            data: { username: `invoiceghs-user-o${seq}-${Date.now()}`, email: `invoiceghs-o${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const customer = await db.user.create({
            data: { username: `invoiceghs-user-c${seq}-${Date.now()}`, email: `invoiceghs-c${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id, businessName: `InvoiceGhs Test ${seq}`,
                bizId: `BIZ-IG-${seq}-${String(Date.now()).slice(-6)}`, category: 'FOOD_BEVERAGE',
            },
        });
        if (vat) {
            await db.businessTaxPreset.create({
                data: { businessProfileId: profile.id, name: 'VAT', type: 'PERCENTAGE', value: new Prisma.Decimal(vat), isDefault: true },
            });
        }
        return { owner, customer, profile };
    }

    test('a cedi invoice stores its money in cedis at exact pesewa precision, with zero USDC', async () => {
        const { customer, profile } = await seed({ vat: '15.0' });

        const invoice = await invoiceSvc.createInvoice(db, {
            businessProfileId: profile.id,
            customerId: customer.id,
            currency: 'GHS',
            lineItems: [
                { description: 'Kelewele', quantity: 3, unitPrice: '0.10' },
                { description: 'Waakye', quantity: 1, unitPrice: '12.35' },
            ],
        });

        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "subtotalGhs"::text AS sub, "taxTotalGhs"::text AS tax,
                    "billTotalGhs"::text AS total,
                    "subtotalUsdc"::text AS usdc_sub, "billTotalUsdc"::text AS usdc_total
             FROM "BusinessInvoice" WHERE id = $1`, invoice.id);
        expect(row.currency).toBe('GHS');
        expect(row.sub).toBe('12.65');    // 0.30 + 12.35 exactly
        expect(row.tax).toBe('1.90');     // 15% of 12.65 = 1.8975 -> HALF_UP 2dp
        expect(row.total).toBe('14.55');
        // No cedi figure is written into a USDC-named column.
        expect(row.usdc_sub).toBe('0.00000000');
        expect(row.usdc_total).toBe('0.00000000');

        // Lines and taxes carry the cedi figures too.
        const lines = await db.$queryRawUnsafe(
            `SELECT "lineTotalGhs"::text AS total FROM "BusinessInvoiceLineItem" WHERE "invoiceId" = $1 ORDER BY "lineTotalGhs" ASC`, invoice.id);
        expect(lines.map((l) => l.total)).toEqual(['0.30', '12.35']);
        const taxes = await db.$queryRawUnsafe(
            `SELECT "computedAmountGhs"::text AS amount FROM "BusinessInvoiceTaxLine" WHERE "invoiceId" = $1`, invoice.id);
        expect(taxes.map((t) => t.amount)).toEqual(['1.90']);
    });

    test('a legacy invoice is byte-identical: untagged, USDC totals, no cedi fields', async () => {
        const { customer, profile } = await seed();

        const invoice = await invoiceSvc.createInvoice(db, {
            businessProfileId: profile.id, customerId: customer.id,
            lineItems: [{ description: 'Service', quantity: 2, unitPrice: '1.50' }],
        });

        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "billTotalUsdc"::text AS total, "billTotalGhs" FROM "BusinessInvoice" WHERE id = $1`, invoice.id);
        expect(row.currency).toBeNull();
        expect(row.total).toBe('3.00000000');
        expect(row.billTotalGhs).toBeNull();
    });

    test('a cedi bill refuses USDC settlement with a typed code instead of charging a converted rate', async () => {
        const { customer, profile } = await seed();

        const invoice = await invoiceSvc.createInvoice(db, {
            businessProfileId: profile.id, customerId: customer.id, currency: 'GHS',
            lineItems: [{ description: 'Jollof', quantity: 1, unitPrice: '40.00' }],
        });
        await invoiceSvc.sendInvoice(db, { invoiceId: invoice.id, businessProfileId: profile.id });

        await expect(invoiceSvc.payInvoice(db, { invoiceId: invoice.id, customerId: customer.id }))
            .rejects.toMatchObject({ code: 'GHS_PAYMENT_RAIL_UNAVAILABLE' });

        // Nothing moved: still SENT, nothing paid.
        const [row] = await db.$queryRawUnsafe(
            `SELECT "status", "payTxHash", "customerPaidGhs" FROM "BusinessInvoice" WHERE id = $1`, invoice.id);
        expect(row.status).toBe('SENT');
        expect(row.payTxHash).toBeNull();
        expect(row.customerPaidGhs).toBeNull();
    });

    test('the database refuses an invoice that mixes cedi and USDC money', async () => {
        const { customer, profile } = await seed();

        // Tagged GHS but carrying a USDC total.
        await expect(db.businessInvoice.create({
            data: {
                businessProfileId: profile.id, customerId: customer.id, invoiceRef: `BADGHS-${Date.now()}`,
                status: 'DRAFT', currency: 'GHS',
                subtotalUsdc: new Prisma.Decimal('5'), taxTotalUsdc: new Prisma.Decimal(0),
                billTotalUsdc: new Prisma.Decimal('5'),
                billTotalGhs: new Prisma.Decimal('10.00'),
            },
        })).rejects.toThrow(/ck_businessinvoice_currency_shape/);

        // Untagged but carrying cedi figures.
        await expect(db.businessInvoice.create({
            data: {
                businessProfileId: profile.id, customerId: customer.id, invoiceRef: `BADMIX-${Date.now()}`,
                status: 'DRAFT',
                subtotalUsdc: new Prisma.Decimal('5'), taxTotalUsdc: new Prisma.Decimal(0),
                billTotalUsdc: new Prisma.Decimal('5'),
                billTotalGhs: new Prisma.Decimal('10.00'),
            },
        })).rejects.toThrow(/ck_businessinvoice_currency_shape/);
    });

    test('a cedi tab finalises at its own value, not at zero, and invoices in cedis', async () => {
        const { customer, profile } = await seed();
        const svc = new DineInService(db);

        const tab = await db.dineInTab.create({
            data: { businessProfileId: profile.id, customerId: customer.id, status: 'OPEN', currency: 'GHS' },
        });
        for (const line of [
            { name: 'Kelewele', quantity: 3, unitPriceGhs: '0.10' },
            { name: 'Waakye', quantity: 1, unitPriceGhs: '12.35' },
        ]) {
            await db.dineInTabItem.create({
                data: {
                    dineInTabId: tab.id, name: line.name, quantity: line.quantity,
                    unitPriceGhs: new Prisma.Decimal(line.unitPriceGhs),
                    lineTotalGhs: new Prisma.Decimal(line.unitPriceGhs).times(line.quantity),
                    unitPriceUsdc: new Prisma.Decimal(0), lineTotalUsdc: new Prisma.Decimal(0),
                    addedBy: customer.id,
                },
            });
        }

        const finalized = await svc.finalizeTab(tab.id);
        expect(finalized.status).toBe('FINALIZED');
        const [tabRow] = await db.$queryRawUnsafe(
            `SELECT "grandTotalGhs"::text AS total, "subtotalGhs"::text AS sub, "grandTotalUsdc"::text AS usdc
             FROM "DineInTab" WHERE id = $1`, tab.id);
        // The tab is worth 12.65 cedis, NOT 0.00 USDC.
        expect(tabRow.total).toBe('12.65');
        expect(tabRow.sub).toBe('12.65');
        expect(tabRow.usdc).toBe('0.00000000');

        // Invoicing the cedi tab now raises a GHS bill with cedi lines; the USDC
        // payment rail then refuses, which is the honest boundary.
        await expect(svc.confirmAndPay(tab.id, customer.id, {}))
            .rejects.toMatchObject({ code: 'GHS_PAYMENT_RAIL_UNAVAILABLE' });

        const inv = await db.businessInvoice.findFirst({
            where: { businessProfileId: profile.id }, include: { lineItems: true },
        });
        expect(inv.currency).toBe('GHS');
        expect(new Prisma.Decimal(inv.billTotalGhs).toFixed(2)).toBe('12.65');
        // The line money came from the cedi column, never a zeroed USDC one.
        const lineTotals = inv.lineItems.map((l) => new Prisma.Decimal(l.lineTotalGhs).toFixed(2)).sort();
        expect(lineTotals).toEqual(['0.30', '12.35']);
    });
});
