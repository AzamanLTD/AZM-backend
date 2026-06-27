// prisma/seedSubcategories.js
// Run: node prisma/seedSubcategories.js
// Safe to re-run — uses upsert on wire value.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SUBCATEGORIES = [
  // FOOD_BEVERAGE
  { parentWire: 'FOOD_BEVERAGE', wire: 'RESTAURANT_FINE_DINING',    label: 'Fine Dining',             displayOrder: 1 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'RESTAURANT_CASUAL',         label: 'Casual Dining',           displayOrder: 2 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'RESTAURANT_FAST_FOOD',      label: 'Fast Food',               displayOrder: 3 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'RESTAURANT_STREET_FOOD',    label: 'Street Food / Chop Bar',  displayOrder: 4 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'CAFE_COFFEE',               label: 'Cafés & Coffee',          displayOrder: 5 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'BAR_NIGHTLIFE',             label: 'Bars & Nightlife',        displayOrder: 6 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'BAKERY',                    label: 'Bakeries & Pastries',     displayOrder: 7 },
  { parentWire: 'FOOD_BEVERAGE', wire: 'CATERING',                  label: 'Catering & Events',       displayOrder: 8 },

  // REAL_ESTATE (accommodation + property)
  { parentWire: 'REAL_ESTATE',   wire: 'ACCOMMODATION_HOTEL',       label: 'Hotels',                  displayOrder: 1 },
  { parentWire: 'REAL_ESTATE',   wire: 'ACCOMMODATION_GUESTHOUSE',  label: 'Guesthouses',             displayOrder: 2 },
  { parentWire: 'REAL_ESTATE',   wire: 'ACCOMMODATION_SHORT_STAY',  label: 'Short-term Rentals',      displayOrder: 3 },
  { parentWire: 'REAL_ESTATE',   wire: 'ACCOMMODATION_RESORT',      label: 'Resorts & Lodges',        displayOrder: 4 },
  { parentWire: 'REAL_ESTATE',   wire: 'REAL_ESTATE_RESIDENTIAL',   label: 'Residential Rentals',     displayOrder: 5 },
  { parentWire: 'REAL_ESTATE',   wire: 'REAL_ESTATE_OFFICE',        label: 'Office / Coworking',      displayOrder: 6 },
  { parentWire: 'REAL_ESTATE',   wire: 'REAL_ESTATE_LAND',          label: 'Land & Commercial',       displayOrder: 7 },

  // LOGISTICS
  { parentWire: 'LOGISTICS',     wire: 'TRANSIT_INTERCITY_BUS',     label: 'Inter-city Bus',          displayOrder: 1 },
  { parentWire: 'LOGISTICS',     wire: 'TRANSIT_CAR_HIRE',          label: 'Car Hire',                displayOrder: 2 },
  { parentWire: 'LOGISTICS',     wire: 'TRANSIT_DELIVERY',          label: 'Delivery Services',       displayOrder: 3 },
  { parentWire: 'LOGISTICS',     wire: 'TRANSIT_FREIGHT',           label: 'Freight / Cargo',         displayOrder: 4 },

  // RETAIL
  { parentWire: 'RETAIL',        wire: 'RETAIL_FASHION',            label: 'Fashion & Clothing',      displayOrder: 1 },
  { parentWire: 'RETAIL',        wire: 'RETAIL_ELECTRONICS',        label: 'Electronics',             displayOrder: 2 },
  { parentWire: 'RETAIL',        wire: 'RETAIL_GROCERIES',          label: 'Groceries & Food',        displayOrder: 3 },
  { parentWire: 'RETAIL',        wire: 'RETAIL_PHONES',             label: 'Phones & Accessories',    displayOrder: 4 },
  { parentWire: 'RETAIL',        wire: 'RETAIL_FURNITURE',          label: 'Furniture & Home',        displayOrder: 5 },

  // HEALTH_WELLNESS
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_CLINIC',           label: 'Clinics & Hospitals',    displayOrder: 1 },
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_PHARMACY',         label: 'Pharmacies',             displayOrder: 2 },
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_SALON_BARBER',     label: 'Salons & Barbershops',   displayOrder: 3 },
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_GYM_FITNESS',      label: 'Fitness & Gyms',         displayOrder: 4 },
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_SPA_MASSAGE',      label: 'Spas & Massage',         displayOrder: 5 },
  { parentWire: 'HEALTH_WELLNESS', wire: 'HEALTH_OPTICAL_DENTAL',   label: 'Optical & Dental',       displayOrder: 6 },

  // EDUCATION
  { parentWire: 'EDUCATION',     wire: 'EDUCATION_TUTORING',        label: 'Tutoring',               displayOrder: 1 },
  { parentWire: 'EDUCATION',     wire: 'EDUCATION_VOCATIONAL',      label: 'Vocational Training',    displayOrder: 2 },
  { parentWire: 'EDUCATION',     wire: 'EDUCATION_LANGUAGE',        label: 'Language Schools',       displayOrder: 3 },

  // FREELANCE_SERVICES
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_HOME_REPAIR',  label: 'Home Repairs & Plumbing', displayOrder: 1 },
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_ELECTRICAL',   label: 'Electricians',            displayOrder: 2 },
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_WEB_TECH',     label: 'Web & Tech Services',     displayOrder: 3 },
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_PHOTOGRAPHY',  label: 'Photography & Video',     displayOrder: 4 },
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_LEGAL',        label: 'Legal & Consulting',      displayOrder: 5 },
  { parentWire: 'FREELANCE_SERVICES', wire: 'SERVICE_CLEANING',     label: 'Cleaning Services',       displayOrder: 6 },

  // ENTERTAINMENT
  { parentWire: 'ENTERTAINMENT',  wire: 'EVENT_VENUE',              label: 'Event Spaces & Venues',  displayOrder: 1 },
  { parentWire: 'ENTERTAINMENT',  wire: 'EVENT_PLANNING',           label: 'Event Planning',          displayOrder: 2 },
  { parentWire: 'ENTERTAINMENT',  wire: 'ENTERTAINMENT_MUSIC',      label: 'Music & DJs',             displayOrder: 3 },
  { parentWire: 'ENTERTAINMENT',  wire: 'ENTERTAINMENT_ACTIVITIES', label: 'Activities & Recreation', displayOrder: 4 },

  // FINANCIAL_SERVICES
  { parentWire: 'FINANCIAL_SERVICES', wire: 'FINANCE_ACCOUNTING',   label: 'Accounting & Audit',     displayOrder: 1 },
  { parentWire: 'FINANCIAL_SERVICES', wire: 'FINANCE_INSURANCE',    label: 'Insurance',              displayOrder: 2 },
  { parentWire: 'FINANCIAL_SERVICES', wire: 'FINANCE_INVESTMENT',   label: 'Investment & Advisory',  displayOrder: 3 },

  // TECHNOLOGY
  { parentWire: 'TECHNOLOGY',    wire: 'TECH_SOFTWARE',             label: 'Software & Apps',        displayOrder: 1 },
  { parentWire: 'TECHNOLOGY',    wire: 'TECH_IT_SUPPORT',           label: 'IT Support',             displayOrder: 2 },
  { parentWire: 'TECHNOLOGY',    wire: 'TECH_ECOMMERCE',            label: 'E-commerce Solutions',   displayOrder: 3 },
];

async function main() {
  console.log(`Seeding ${SUBCATEGORIES.length} subcategories...`);
  let created = 0;
  let updated = 0;
  for (const sub of SUBCATEGORIES) {
    // BusinessSubcategory has no createdAt/updatedAt timestamps, so we can't infer
    // created-vs-updated from the upsert result. A pre-check on the unique `wire`
    // keeps the stats accurate (50 rows — the extra read is negligible).
    const existing = await prisma.businessSubcategory.findUnique({
      where:  { wire: sub.wire },
      select: { id: true },
    });
    await prisma.businessSubcategory.upsert({
      where:  { wire: sub.wire },
      update: { parentWire: sub.parentWire, label: sub.label, displayOrder: sub.displayOrder, isActive: true },
      create: sub,
    });
    if (existing) updated++; else created++;
  }
  console.log(`Done. Created: ${created}, Updated: ${updated}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
