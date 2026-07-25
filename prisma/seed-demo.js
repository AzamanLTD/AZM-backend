// prisma/seed-demo.js
// =============================================================================
// AZM — Sandbox / Demo Mode Seed Script
//
// Creates realistic demo data across all three business verticals:
//   1. Hotel (Hospitality)
//   2. Restaurant (Food & Beverage)
//   3. Transit (Logistics)
//
// Usage: npm run seed:demo
// Requires: DATABASE_URL env var + migrated database
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv/config');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DEMO_PASSWORD = 'Demo1234!';
const hashedPassword = bcrypt.hashSync(DEMO_PASSWORD, 12);

// Helper: generate bizId
function genBizId() {
    return 'BIZ-' + String(Math.floor(100000000 + Math.random() * 900000000));
}

// Helper: generate unique slug
let slugCounter = 0;
function genSlug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + (++slugCounter);
}

// Helper: random date within last N days
function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - Math.floor(Math.random() * n));
    return d;
}

// Helper: date N days from now
function daysAhead(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
}

async function main() {
    console.log('🌱 Seeding AZM demo data...\n');

    // ── 1. Demo business owner ──────────────────────────────────────────
    const owner = await prisma.user.upsert({
        where: { email: 'demo-owner@azm.azm' },
        update: { password: hashedPassword, role: 'BUSINESS' },
        create: {
            username: 'DemoOwner',
            email: 'demo-owner@azm.azm',
            password: hashedPassword,
            role: 'BUSINESS',
            availableBalance: 15000.0,
            phoneHash: 'demo-owner-hash',
        },
    });
    console.log(`  ✓ Owner: ${owner.email}`);

    // ── 2. Demo customers ────────────────────────────────────────────────
    const customers = [];
    for (let i = 1; i <= 5; i++) {
        const c = await prisma.user.upsert({
            where: { email: `demo-customer${i}@azm.azm` },
            update: {},
            create: {
                username: `DemoCustomer${i}`,
                email: `demo-customer${i}@azm.azm`,
                password: hashedPassword,
                role: 'USER',
                availableBalance: 500 + i * 200,
                phoneHash: `demo-customer-${i}-hash`,
            },
        });
        customers.push(c);
    }
    console.log(`  ✓ ${customers.length} customers`);

    // ── 3. Hotel business ────────────────────────────────────────────────
    const hotel = await prisma.businessProfile.create({
        data: {
            userId: owner.id,
            bizId: genBizId(),
            businessName: 'Royal Acacia Hotel',
            category: 'HOSPITALITY',
            description: 'A boutique hotel in the heart of Accra with 40 rooms, a pool, and restaurant.',
            website: 'https://demo.azm.azm/royal-acacia',
            phoneNumber: '+233500000001',
            contactEmail: 'royal@demo.azm.azm',
            isVerified: true,
            verifiedAt: new Date(),
            kybStatus: 'VERIFIED',
            businessMeta: {
                starRating: 4,
                totalRooms: 40,
                checkInTime: '14:00',
                checkOutTime: '11:00',
                facilities: ['Pool', 'Gym', 'Restaurant', 'Bar', 'Conference Room', 'Free WiFi'],
            },
            amenities: ['WIFI', 'PARKING', 'AC', 'POOL', 'GYM'],
        },
    });

    const hotelLocation = await prisma.businessLocation.create({
        data: {
            businessProfileId: hotel.id,
            label: 'Main Branch — Osu',
            address: 'Oxford Street, Osu, Accra',
            city: 'Accra',
            region: 'Greater Accra',
            country: 'GH',
            latitude: 5.5570167,
            longitude: -0.1735154,
            phoneNumber: '+233500000001',
            isPrimary: true,
            operatingHours: {
                mon: '24h', tue: '24h', wed: '24h', thu: '24h',
                fri: '24h', sat: '24h', sun: '24h'
            },
        },
    });
    console.log(`  ✓ Hotel: ${hotel.businessName} (${hotel.bizId})`);

    // Hotel rooms
    const roomTypes = [
        { type: 'STANDARD', floor: 1, capacity: 2, bed: '1 QUEEN', price: 65, weekend: 85, amenities: ['AC', 'WIFI', 'TV'] },
        { type: 'DELUXE', floor: 2, capacity: 2, bed: '1 KING', price: 95, weekend: 120, amenities: ['AC', 'WIFI', 'TV', 'MINIBAR'] },
        { type: 'SUITE', floor: 3, capacity: 4, bed: '1 KING + 1 SOFA BED', price: 150, weekend: 180, amenities: ['AC', 'WIFI', 'TV', 'MINIBAR', 'BALCONY'] },
        { type: 'EXECUTIVE', floor: 4, capacity: 2, bed: '1 KING', price: 200, weekend: 240, amenities: ['AC', 'WIFI', 'TV', 'MINIBAR', 'OCEAN_VIEW'] },
    ];

    const rooms = [];
    let roomNum = 101;
    for (const rt of roomTypes) {
        for (let i = 0; i < 5; i++) {
            const room = await prisma.hotelRoom.create({
                data: {
                    businessProfileId: hotel.id,
                    locationId: hotelLocation.id,
                    roomNumber: String(roomNum++),
                    roomType: rt.type,
                    floor: rt.floor,
                    capacity: rt.capacity,
                    bedConfig: rt.bed,
                    basePriceUsdc: rt.price,
                    weekendPriceUsdc: rt.weekend,
                    amenities: rt.amenities,
                    status: i === 0 ? 'OCCUPIED' : i === 1 ? 'DIRTY' : 'AVAILABLE',
                },
            });
            rooms.push(room);
        }
    }
    console.log(`  ✓ ${rooms.length} hotel rooms`);

    // Hotel reservations
    for (let i = 0; i < 3; i++) {
        const room = rooms[i];
        await prisma.reservation.create({
            data: {
                reservationRef: 'RES-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
                businessProfileId: hotel.id,
                locationId: hotelLocation.id,
                customerId: customers[i].id,
                serviceItemId: null,
                status: i === 0 ? 'CHECKED_IN' : i === 1 ? 'CONFIRMED' : 'PENDING',
                startDatetime: daysAhead(i),
                endDatetime: daysAhead(i + 2),
                partySize: 2,
                amountUsdc: room.basePriceUsdc * 2,
                depositUsdc: room.basePriceUsdc,
                customerNotes: i === 0 ? 'Need extra towels please' : null,
                confirmedAt: i === 0 ? daysAgo(1) : i === 1 ? new Date() : null,
                checkedInAt: i === 0 ? new Date() : null,
            },
        });
    }
    console.log(`  ✓ 3 hotel reservations`);

    // ── 4. Restaurant business ──────────────────────────────────────────
    const restaurant = await prisma.businessProfile.create({
        data: {
            userId: owner.id,
            bizId: genBizId(),
            businessName: 'Binta\'s Kitchen',
            category: 'FOOD_BEVERAGE',
            description: 'Authentic Ghanaian cuisine with a modern twist. Open for lunch and dinner.',
            website: 'https://demo.azm.azm/bintas-kitchen',
            phoneNumber: '+233500000002',
            contactEmail: 'binta@demo.azm.azm',
            isVerified: true,
            verifiedAt: new Date(),
            kybStatus: 'VERIFIED',
            cuisineTypes: ['GHANAIAN', 'CONTINENTAL'],
            priceRange: 2,
            businessMeta: {
                seatingCapacity: 60,
                servesAlcohol: true,
                reservationRequired: false,
            },
            amenities: ['WIFI', 'AC', 'PARKING'],
        },
    });

    const restaurantLocation = await prisma.businessLocation.create({
        data: {
            businessProfileId: restaurant.id,
            label: 'Main Branch — East Legon',
            address: 'Boundary Road, East Legon, Accra',
            city: 'Accra',
            region: 'Greater Accra',
            country: 'GH',
            latitude: 5.6360,
            longitude: -0.1700,
            phoneNumber: '+233500000002',
            isPrimary: true,
            operatingHours: {
                mon: '11:00-22:00', tue: '11:00-22:00', wed: '11:00-22:00',
                thu: '11:00-22:00', fri: '11:00-23:00', sat: '10:00-23:00', sun: '10:00-21:00'
            },
        },
    });
    console.log(`  ✓ Restaurant: ${restaurant.businessName} (${restaurant.bizId})`);

    // Restaurant products (menu items)
    const menuItems = [
        { name: 'Jollof Rice with Chicken', price: 12.5, desc: 'Smoky jollof rice with grilled chicken and salad', cat: 'FOOD_BEVERAGE', tags: ['POPULAR'], calories: 650, prep: 20 },
        { name: 'Banku & Tilapia', price: 18.0, desc: 'Fresh tilapia grilled with banku and pepper sauce', cat: 'FOOD_BEVERAGE', tags: ['POPULAR'], calories: 580, prep: 25 },
        { name: 'Kelewele (Plantain)', price: 5.0, desc: 'Spicy fried plantain cubes — a Ghanaian street favorite', cat: 'FOOD_BEVERAGE', tags: ['VEGAN'], calories: 320, prep: 10 },
        { name: 'Waakye Special', price: 10.0, desc: 'Rice and beans with spaghetti, egg, and beef stew', cat: 'FOOD_BEVERAGE', tags: ['POPULAR'], calories: 720, prep: 15 },
        { name: 'Fresh Palm Wine', price: 4.0, desc: 'Naturally fermented palm wine — chilled', cat: 'FOOD_BEVERAGE', tags: [], calories: 150, prep: 2 },
        { name: 'Sobolo (Hibiscus Drink)', price: 3.0, desc: 'Refreshing hibiscus iced tea with ginger', cat: 'FOOD_BEVERAGE', tags: ['VEGAN', 'GLUTEN_FREE'], calories: 90, prep: 2 },
    ];

    const products = [];
    for (const item of menuItems) {
        const p = await prisma.businessProduct.create({
            data: {
                businessProfileId: restaurant.id,
                name: item.name,
                description: item.desc,
                priceUsdc: item.price,
                category: item.cat,
                slug: genSlug(item.name),
                isActive: true,
                isAvailable: true,
                tags: item.tags,
                calorieCount: item.calories,
                preparationMins: item.prep,
                variants: item.name.includes('Chicken') ? [
                    { label: 'Regular', priceDelta: 0 },
                    { label: 'Extra Chicken', priceDelta: 3.0 },
                ] : null,
                locationId: restaurantLocation.id,
            },
        });
        products.push(p);
    }
    console.log(`  ✓ ${products.length} menu items`);

    // Restaurant tables
    for (let i = 1; i <= 10; i++) {
        await prisma.businessTable.create({
            data: {
                locationId: restaurantLocation.id,
                label: `Table ${i}`,
                isActive: true,
                metadata: { seats: i <= 4 ? 2 : i <= 8 ? 4 : 6, position: { x: i * 100, y: 50 } },
            },
        }).catch(() => {});
    }
    console.log(`  ✓ 10 restaurant tables`);

    // Restaurant orders
    for (let i = 0; i < 5; i++) {
        const p = products[i % products.length];
        await prisma.businessOrder.create({
            data: {
                businessProfileId: restaurant.id,
                customerId: customers[i % customers.length].id,
                productId: p.id,
                status: i === 0 ? 'COMPLETED' : i === 1 ? 'DELIVERED' : i === 2 ? 'PAID' : 'AWAITING_PAYMENT',
                orderRef: 'ORD-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
                title: p.name,
                description: p.description,
                amountUsdc: p.priceUsdc,
                paymentMethod: i < 2 ? 'AZAMAN_BALANCE' : null,
                completedAt: i === 0 ? daysAgo(1) : null,
                deliveredAt: i === 1 ? daysAgo(0) : null,
            },
        });
    }
    console.log(`  ✓ 5 restaurant orders`);

    // Restaurant invoices
    for (let i = 0; i < 3; i++) {
        const subtotal = 15 + i * 10;
        const tax = subtotal * 0.05;
        const total = subtotal + tax;
        await prisma.businessInvoice.create({
            data: {
                businessProfileId: restaurant.id,
                locationId: restaurantLocation.id,
                customerId: customers[i].id,
                invoiceRef: 'INV-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
                status: i === 0 ? 'PAID' : 'SENT',
                subtotalUsdc: subtotal,
                taxTotalUsdc: tax,
                billTotalUsdc: total,
                tipUsdc: i === 0 ? 2.0 : 0,
                customerPaidUsdc: i === 0 ? total + 2.0 : null,
                paymentMethod: i === 0 ? 'AZAMAN_BALANCE' : null,
                paidAt: i === 0 ? daysAgo(1) : null,
                sentAt: new Date(),
                lineItems: {
                    create: [
                        { name: products[i].name, quantity: 1 + i, unitPriceUsdc: products[i].priceUsdc, totalUsdc: (1 + i) * products[i].priceUsdc },
                        { name: products[(i + 1) % products.length].name, quantity: 1, unitPriceUsdc: products[(i + 1) % products.length].priceUsdc, totalUsdc: products[(i + 1) % products.length].priceUsdc },
                    ],
                },
            },
        });
    }
    console.log(`  ✓ 3 restaurant invoices`);

    // ── 5. Transit business ──────────────────────────────────────────────
    const transit = await prisma.businessProfile.create({
        data: {
            userId: owner.id,
            bizId: genBizId(),
            businessName: 'Accra Express Transit',
            category: 'LOGISTICS',
            description: 'Intercity bus and shared taxi service across Ghana.',
            website: 'https://demo.azm.azm/accra-express',
            phoneNumber: '+233500000003',
            contactEmail: 'transit@demo.azm.azm',
            isVerified: true,
            verifiedAt: new Date(),
            kybStatus: 'VERIFIED',
            businessMeta: {
                fleetSize: 12,
                coverageAreas: ['Accra', 'Kumasi', 'Takoradi', 'Tamale', 'Cape Coast'],
                serviceType: 'Intercity + Shared Taxi',
            },
            amenities: ['AC', 'WIFI'],
        },
    });

    const transitLocation = await prisma.businessLocation.create({
        data: {
            businessProfileId: transit.id,
            label: 'Main Terminal — Circle',
            address: 'Kwame Nkrumah Circle, Accra',
            city: 'Accra',
            region: 'Greater Accra',
            country: 'GH',
            latitude: 5.5630,
            longitude: -0.2090,
            phoneNumber: '+233500000003',
            isPrimary: true,
            operatingHours: { mon: '5:00-22:00', tue: '5:00-22:00', wed: '5:00-22:00', thu: '5:00-22:00', fri: '5:00-22:00', sat: '5:00-22:00', sun: '6:00-20:00' },
        },
    });
    console.log(`  ✓ Transit: ${transit.businessName} (${transit.bizId})`);

    // Transit trips (using BusinessProduct as trip slots)
    const routes = [
        { name: 'Accra → Kumasi', price: 25.0, dep: '07:00', arr: '11:00' },
        { name: 'Accra → Takoradi', price: 30.0, dep: '08:00', arr: '12:30' },
        { name: 'Accra → Cape Coast', price: 15.0, dep: '09:00', arr: '11:00' },
        { name: 'Accra → Tamale', price: 45.0, dep: '06:00', arr: '14:00' },
    ];

    for (const r of routes) {
        await prisma.businessProduct.create({
            data: {
                businessProfileId: transit.id,
                name: r.name,
                description: `Departure ${r.dep}, arrival ${r.arr}. AC bus with WiFi.`,
                priceUsdc: r.price,
                category: 'LOGISTICS',
                slug: genSlug(r.name),
                isActive: true,
                isAvailable: true,
                locationId: transitLocation.id,
                tags: ['AC', 'WIFI'],
                preparationMins: null,
            },
        });
    }
    console.log(`  ✓ 4 transit trips`);

    // ── 6. Employees ──────────────────────────────────────────────────────
    const employeeUsers = [];
    const roles = [
        { name: 'Kwame', role: 'MANAGER', dept: 'Management', title: 'General Manager', salary: 2500, type: 'SALARY' },
        { name: 'Ama', role: 'RECEPTIONIST', dept: 'Front Desk', title: 'Front Desk Lead', salary: 800, type: 'SALARY' },
        { name: 'Yaw', role: 'HOUSEKEEPER', dept: 'Housekeeping', title: 'Housekeeper', rate: 12, type: 'HOURLY' },
        { name: 'Akosua', role: 'CHEF', dept: 'Kitchen', title: 'Head Chef', salary: 1800, type: 'SALARY' },
        { name: 'Kofi', role: 'DRIVER', dept: 'Operations', title: 'Senior Driver', salary: 1200, type: 'SALARY' },
    ];

    for (let i = 0; i < roles.length; i++) {
        const r = roles[i];
        const u = await prisma.user.upsert({
            where: { email: `demo-emp${i}@azm.azm` },
            update: {},
            create: {
                username: r.name,
                email: `demo-emp${i}@azm.azm`,
                password: hashedPassword,
                role: 'USER',
                phoneHash: `demo-emp-${i}-hash`,
            },
        });
        employeeUsers.push(u);

        const biz = i < 3 ? hotel : i === 3 ? restaurant : transit;
        await prisma.businessEmployee.create({
            data: {
                businessProfileId: biz.id,
                userId: u.id,
                role: r.role,
                status: 'ACTIVE',
                title: r.title,
                department: r.dept,
                payrollType: r.type,
                salaryAmount: r.type === 'SALARY' ? r.salary : null,
                hourlyRate: r.type === 'HOURLY' ? r.rate : null,
                permissions: r.role === 'MANAGER' ? ['view_dashboard', 'manage_employees', 'view_finance', 'process_payroll'] : ['view_dashboard'],
                totalShifts: 10 + i * 3,
                totalHours: 80 + i * 10,
            },
        });
    }
    console.log(`  ✓ ${employeeUsers.length} employees`);

    // ── 7. Reviews ────────────────────────────────────────────────────────
    const reviewTexts = [
        'Excellent service! The staff were very professional.',
        'Great experience overall. Will definitely come back.',
        'Good value for money. The room was clean and comfortable.',
        'Food was delicious but service was a bit slow.',
        'Amazing atmosphere and friendly staff.',
    ];

    for (let i = 0; i < 5; i++) {
        const biz = i < 2 ? hotel : i < 4 ? restaurant : transit;
        await prisma.businessReview.create({
            data: {
                businessProfileId: biz.id,
                reviewerId: customers[i].id,
                rating: 4 + (i % 2),
                comment: reviewTexts[i],
                sourceType: i < 2 ? 'RESERVATION' : 'INVOICE',
                businessResponse: i < 2 ? 'Thank you for your kind words!' : null,
                businessResponseAt: i < 2 ? daysAgo(1) : null,
            },
        }).catch(() => {});
    }
    console.log(`  ✓ 5 reviews`);

    // ── 8. Business notifications ────────────────────────────────────────
    const notifTypes = [
        { type: 'NEW_ORDER', title: 'New order received', body: 'Order ORD-DEMO001 for Jollof Rice with Chicken' },
        { type: 'RESERVATION_NEW', title: 'New reservation request', body: 'Customer requested a room for 2 nights' },
        { type: 'INVOICE_PAID', title: 'Invoice paid', body: 'Invoice INV-DEMO001 has been paid — $35.50' },
        { type: 'RESERVATION_CHECKED_IN', title: 'Guest checked in', body: 'A guest has checked into Room 101' },
        { type: 'TRANSIT_BOOKING_NEW', title: 'New trip booking', body: 'Customer booked Accra → Kumasi trip' },
    ];

    for (let i = 0; i < notifTypes.length; i++) {
        const n = notifTypes[i];
        const biz = i < 2 ? hotel : i < 4 ? restaurant : transit;
        await prisma.businessNotification.create({
            data: {
                businessProfileId: biz.id,
                type: n.type,
                title: n.title,
                body: n.body,
                isRead: i > 2,
            },
        }).catch(() => {});
    }
    console.log(`  ✓ 5 notifications`);

    // ── 9. Changelog entries ─────────────────────────────────────────────
    await prisma.changelog.createMany({
        data: [
            { version: 'v2.5.0', title: 'Business Portal 2.0 is here!', body: 'We\'ve completely redesigned the business portal with new modules for hotel operations, restaurant management, and transit scheduling. Plus: employee scheduling, payroll, and earned wage access.', category: 'feature', severity: 'info', publishedAt: daysAgo(7) },
            { version: 'v2.4.2', title: 'Security improvements', body: 'Added two-factor authentication (TOTP), session management, and GDPR data export. Your account is now more secure than ever.', category: 'security', severity: 'info', publishedAt: daysAgo(14) },
            { version: 'v2.4.0', title: 'Webhook delivery system', body: 'Businesses can now register webhook endpoints and receive real-time event notifications for orders, invoices, and reservations. Includes retry queue with exponential backoff.', category: 'feature', severity: 'info', publishedAt: daysAgo(21) },
            { version: 'v2.3.1', title: 'Performance: list virtualization', body: 'Orders, employees, and inventory lists now handle 400+ items smoothly with virtualized scrolling.', category: 'improvement', severity: 'info', publishedAt: daysAgo(30) },
        ],
    });
    console.log(`  ✓ 4 changelog entries`);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log('\n✅ Demo data seeded successfully!\n');
    console.log('📋 Demo Accounts:');
    console.log(`   Owner:    demo-owner@azm.azm / ${DEMO_PASSWORD}`);
    console.log(`   Customer: demo-customer1@azm.azm / ${DEMO_PASSWORD}`);
    console.log(`   Employee: demo-emp0@azm.azm / ${DEMO_PASSWORD}`);
    console.log('\n🏢 Businesses:');
    console.log(`   Hotel:      Royal Acacia Hotel (${hotel.bizId})`);
    console.log(`   Restaurant: Binta's Kitchen (${restaurant.bizId})`);
    console.log(`   Transit:    Accra Express Transit (${transit.bizId})`);
}

main()
    .catch((e) => {
        console.error('❌ Seed error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        if (pool) await pool.end();
        console.log('\n🔌 Seed connection closed.');
    });
