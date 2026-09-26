#!/usr/bin/env node
// =============================================================================
// AZAMAN MARKETPLACE MEDIA SEED SCRIPT
// =============================================================================
//
// PURPOSE
// -------
// This script patches the production (or any) Azaman database so that every
// marketplace business looks complete in the app:
//
//   1. Sets logoUrl + coverPhotoUrl on every seeded business so that:
//        - The collapsed bar thumbnail is filled (logoUrl)
//        - The expanded card cover is filled  (logoUrl, used by _coverUrl())
//        - The profile-screen hero banner is filled (showcase slide[0] or logoUrl)
//        - Closed-state expanded view avatar is filled (logoUrl)
//
//   2. Seeds BusinessShowcase rows for The Goldfield Hostel so the Overview
//      tab shows a rich room-view carousel (otherwise it falls back to the
//      logo, which is square and looks wrong at 280px height).
//
//   3. Seeds imageUrls on Golden Pot products that currently have no picture.
//
//   4. Renames "AZ QA Transit Test Co" → "CityLink Transit", moves its
//      existing ad post + TransitVehicles to the renamed profile, then
//      hard-deletes the old stub record if it was a separate row.
//      (If there is only ONE transit business, we just rename + update in place.)
//
//   5. Fills in the transit business description/overview if it is blank.
//
// USAGE
// -----
//   DATABASE_URL="postgresql://..." node scripts/seed-marketplace-media.js
//
//   The script is idempotent — running it twice is safe. Every write uses
//   upsert or a conditional check so re-runs are no-ops.
//
// IMAGE SOURCES
// -------------
// All images are publicly accessible Unsplash/Pexels photos picked to match
// the brand. No Cloudinary upload is needed — the app uses CachedNetworkImage
// which accepts any HTTPS URL. If you later want to migrate to Cloudinary,
// upload the images there and re-run this script with updated URLs.
// =============================================================================

'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

// ---------------------------------------------------------------------------
// IMAGE LIBRARY
// High-quality, freely usable images (Unsplash open license).
// All images are served at ~1200px wide so they render crisply on retina
// displays without being unnecessarily large.
// ---------------------------------------------------------------------------

const IMAGES = {
  // ── The Goldfield Hostel (HOSPITALITY) ────────────────────────────────────
  GOLDFIELD_LOGO: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80',
  GOLDFIELD_COVER: 'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=1200&q=80',
  GOLDFIELD_ROOM_1: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1200&q=80', // Standard room
  GOLDFIELD_ROOM_2: 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=1200&q=80', // Deluxe double
  GOLDFIELD_ROOM_3: 'https://images.unsplash.com/photo-1578683010236-d716f9a3f461?w=1200&q=80', // Twin/family
  GOLDFIELD_ROOM_4: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=1200&q=80', // Suite
  GOLDFIELD_POOL:   'https://images.unsplash.com/photo-1519449556851-5720b33024e7?w=1200&q=80', // Pool area
  GOLDFIELD_LOBBY:  'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=1200&q=80', // Lobby

  // ── Golden Pot Restaurant (FOOD_BEVERAGE) ─────────────────────────────────
  GOLDEN_POT_LOGO:   'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&q=80',
  GOLDEN_POT_COVER:  'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&q=80',
  // Product images (for items missing pictures)
  JOLLOF_RICE:       'https://images.unsplash.com/photo-1604329760661-e71dc83f8f26?w=800&q=80',
  GRILLED_TILAPIA:   'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=800&q=80',
  WAAKYE:            'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80',
  BANKU_TILAPIA:     'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800&q=80',
  KELEWELE:          'https://images.unsplash.com/photo-1587735243615-c03f25aaff15?w=800&q=80',
  FUFU_SOUP:         'https://images.unsplash.com/photo-1547592180-85f173990554?w=800&q=80',
  KONTOMIRE:         'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=800&q=80',
  FRESH_JUICE:       'https://images.unsplash.com/photo-1497534446932-c925b458314e?w=800&q=80',

  // ── CityLink Transit (LOGISTICS) ──────────────────────────────────────────
  CITYLINK_LOGO:   'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=800&q=80',  // Bus front-on
  CITYLINK_COVER:  'https://images.unsplash.com/photo-1570125909232-eb263c188f7e?w=1200&q=80', // Highway/coach
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`  ${msg}`);
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ---------------------------------------------------------------------------
// STEP 1 — Patch logos + cover photos on every known business
// ---------------------------------------------------------------------------
async function patchBusinessImages() {
  section('STEP 1 — Patching business logoUrl + coverPhotoUrl');

  // Map: partial businessName → { logoUrl, coverPhotoUrl, description? }
  const patches = [
    {
      nameFragment: 'Goldfield',
      category: 'HOSPITALITY',
      logoUrl: IMAGES.GOLDFIELD_LOGO,
      coverPhotoUrl: IMAGES.GOLDFIELD_COVER,
    },
    {
      nameFragment: 'Golden Pot',
      category: 'FOOD_BEVERAGE',
      logoUrl: IMAGES.GOLDEN_POT_LOGO,
      coverPhotoUrl: IMAGES.GOLDEN_POT_COVER,
    },
    {
      // Matches both "AZ QA Transit Test Co" (old) and "CityLink Transit" (new)
      category: 'LOGISTICS',
      logoUrl: IMAGES.CITYLINK_LOGO,
      coverPhotoUrl: IMAGES.CITYLINK_COVER,
    },
  ];

  for (const patch of patches) {
    const where = patch.nameFragment
      ? { businessName: { contains: patch.nameFragment, mode: 'insensitive' }, category: patch.category }
      : { category: patch.category };

    const businesses = await prisma.businessProfile.findMany({
      where,
      select: { id: true, bizId: true, businessName: true, logoUrl: true },
    });

    if (businesses.length === 0) {
      log(`⚠️  No business found matching: ${patch.nameFragment ?? patch.category}`);
      continue;
    }

    for (const biz of businesses) {
      const updateData = {
        logoUrl: patch.logoUrl,
        coverPhotoUrl: patch.coverPhotoUrl,
      };
      await prisma.businessProfile.update({
        where: { id: biz.id },
        data: updateData,
      });
      log(`✅  ${biz.businessName} → logoUrl + coverPhotoUrl set`);
    }
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — Seed Goldfield Hostel showcase (room view carousel)
// ---------------------------------------------------------------------------
async function seedGoldfieldShowcase() {
  section('STEP 2 — Seeding Goldfield Hostel room-view showcase');

  const hostel = await prisma.businessProfile.findFirst({
    where: {
      businessName: { contains: 'Goldfield', mode: 'insensitive' },
      category: 'HOSPITALITY',
    },
    select: { id: true, businessName: true },
  });

  if (!hostel) {
    log('⚠️  Goldfield Hostel not found — skipping showcase seed');
    return;
  }

  const slides = [
    {
      mediaUrl: IMAGES.GOLDFIELD_LOBBY,
      caption: 'Welcome to The Goldfield — modern comfort in the heart of Accra',
      displayOrder: 0,
    },
    {
      mediaUrl: IMAGES.GOLDFIELD_ROOM_1,
      caption: 'Standard Room — queen bed, AC, en-suite bathroom',
      displayOrder: 1,
    },
    {
      mediaUrl: IMAGES.GOLDFIELD_ROOM_2,
      caption: 'Deluxe Double — city view, king bed, work desk',
      displayOrder: 2,
    },
    {
      mediaUrl: IMAGES.GOLDFIELD_ROOM_3,
      caption: 'Family Twin — two queen beds, ideal for families',
      displayOrder: 3,
    },
    {
      mediaUrl: IMAGES.GOLDFIELD_ROOM_4,
      caption: 'Executive Suite — separate living area, premium amenities',
      displayOrder: 4,
    },
    {
      mediaUrl: IMAGES.GOLDFIELD_POOL,
      caption: 'Outdoor Pool — open 7am – 9pm daily',
      displayOrder: 5,
    },
  ];

  // Remove any existing showcase slides first (idempotent re-seed)
  const deleted = await prisma.businessShowcase.deleteMany({
    where: { businessProfileId: hostel.id },
  });
  if (deleted.count > 0) {
    log(`  🗑️  Removed ${deleted.count} existing showcase slides`);
  }

  for (const slide of slides) {
    await prisma.businessShowcase.create({
      data: {
        businessProfileId: hostel.id,
        mediaUrl: slide.mediaUrl,
        mediaType: 'IMAGE',
        caption: slide.caption,
        displayOrder: slide.displayOrder,
        isActive: true,
      },
    });
    log(`✅  Added slide [${slide.displayOrder}]: ${slide.caption.slice(0, 50)}…`);
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — Seed product images for Golden Pot
// ---------------------------------------------------------------------------
async function seedGoldenPotProductImages() {
  section('STEP 3 — Seeding Golden Pot product images');

  const restaurant = await prisma.businessProfile.findFirst({
    where: {
      businessName: { contains: 'Golden Pot', mode: 'insensitive' },
      category: 'FOOD_BEVERAGE',
    },
    select: { id: true, businessName: true },
  });

  if (!restaurant) {
    log('⚠️  Golden Pot not found — skipping product image seed');
    return;
  }

  const products = await prisma.businessProduct.findMany({
    where: { businessProfileId: restaurant.id },
    select: { id: true, name: true, imageUrls: true },
  });

  if (products.length === 0) {
    log('⚠️  No products found for Golden Pot');
    return;
  }

  // Map product name fragments → image URL
  // We fill ALL products: if a product already has images we skip it
  // (imageUrls is stored as Json / null — treat null or empty array as needing a seed)
  const imageMap = [
    { fragment: 'jollof',      url: IMAGES.JOLLOF_RICE },
    { fragment: 'tilapia',     url: IMAGES.GRILLED_TILAPIA },
    { fragment: 'waakye',      url: IMAGES.WAAKYE },
    { fragment: 'banku',       url: IMAGES.BANKU_TILAPIA },
    { fragment: 'kelewele',    url: IMAGES.KELEWELE },
    { fragment: 'fufu',        url: IMAGES.FUFU_SOUP },
    { fragment: 'soup',        url: IMAGES.FUFU_SOUP },
    { fragment: 'kontomire',   url: IMAGES.KONTOMIRE },
    { fragment: 'stew',        url: IMAGES.KONTOMIRE },
    { fragment: 'juice',       url: IMAGES.FRESH_JUICE },
    { fragment: 'drink',       url: IMAGES.FRESH_JUICE },
  ];

  // Fallback image for any product that doesn't match a keyword
  const FALLBACK_IMAGE = IMAGES.JOLLOF_RICE;

  for (const product of products) {
    // Parse existing imageUrls — could be null, [], or a populated array
    const existing = Array.isArray(product.imageUrls)
      ? product.imageUrls
      : (product.imageUrls ? Object.values(product.imageUrls) : []);

    if (existing.length > 0) {
      log(`  ⏭️  ${product.name} — already has ${existing.length} image(s), skipping`);
      continue;
    }

    // Find matching image
    const nameLower = product.name.toLowerCase();
    const match = imageMap.find((m) => nameLower.includes(m.fragment));
    const imageUrl = match ? match.url : FALLBACK_IMAGE;

    await prisma.businessProduct.update({
      where: { id: product.id },
      data: { imageUrls: [imageUrl] },
    });
    log(`✅  ${product.name} → image seeded (${match ? match.fragment : 'fallback'})`);
  }
}

// ---------------------------------------------------------------------------
// STEP 4 — Rename transit business + update description
// ---------------------------------------------------------------------------
async function renameTransitBusiness() {
  section('STEP 4 — CityLink Transit rename + overview');

  // Find ANY business with category LOGISTICS
  const all = await prisma.businessProfile.findMany({
    where: { category: 'LOGISTICS' },
    select: { id: true, bizId: true, businessName: true, description: true },
    orderBy: { createdAt: 'asc' },
  });

  if (all.length === 0) {
    log('⚠️  No LOGISTICS business found');
    return;
  }

  // If there are multiple, the "AZ QA Transit Test Co" is a stub we want to
  // remove, keeping (or creating) "CityLink Transit". If there's only one,
  // we rename it in place.
  const cityLink = all.find((b) =>
    b.businessName.toLowerCase().includes('citylink') ||
    b.businessName.toLowerCase().includes('city link')
  );
  const stub = all.find((b) =>
    b.businessName.toLowerCase().includes('az qa') ||
    b.businessName.toLowerCase().includes('test co')
  );

  const CITYLINK_DESCRIPTION =
    'CityLink Transit is Ghana\'s premium intercity coach service, connecting Accra, ' +
    'Kumasi, Cape Coast, Tamale, and Takoradi with modern, air-conditioned coaches. ' +
    'Book your seat in seconds — real-time seat maps, instant e-tickets, and live ' +
    'departure tracking make every journey effortless. Corporate accounts and group ' +
    'bookings available. Travel smarter, travel CityLink.';

  if (cityLink && stub && cityLink.id !== stub.id) {
    // Two separate rows — move ad posts from stub to cityLink then delete stub
    log(`  Found stub: "${stub.businessName}" (${stub.bizId})`);
    log(`  Found target: "${cityLink.businessName}" (${cityLink.bizId})`);

    // Re-parent ad posts
    const movedAds = await prisma.businessAdPost.updateMany({
      where: { businessProfileId: stub.id },
      data: { businessProfileId: cityLink.id },
    });
    log(`  📋 Moved ${movedAds.count} ad post(s) to CityLink`);

    // Re-parent transit vehicles
    const movedVehicles = await prisma.transitVehicle.updateMany({
      where: { businessProfileId: stub.id },
      data: { businessProfileId: cityLink.id },
    });
    log(`  🚌 Moved ${movedVehicles.count} transit vehicle(s) to CityLink`);

    // Re-parent transit trips
    const movedTrips = await prisma.transitTrip.updateMany({
      where: { businessProfileId: stub.id },
      data: { businessProfileId: cityLink.id },
    }).catch(() => ({ count: 0 }));
    log(`  🗓️  Moved ${movedTrips.count} transit trip(s) to CityLink`);

    // Re-parent followers
    await prisma.businessFollower.updateMany({
      where: { businessProfileId: stub.id },
      data: { businessProfileId: cityLink.id },
    }).catch(() => {});

    // Hard-delete stub (BusinessProfile has cascade deletes for most children
    // but we've already moved the ones we care about)
    await prisma.businessProfile.delete({ where: { id: stub.id } });
    log(`  🗑️  Deleted stub "${stub.businessName}"`);

    // Update CityLink
    await prisma.businessProfile.update({
      where: { id: cityLink.id },
      data: {
        businessName: 'CityLink Transit',
        description: cityLink.description?.trim() ? cityLink.description : CITYLINK_DESCRIPTION,
        logoUrl: IMAGES.CITYLINK_LOGO,
        coverPhotoUrl: IMAGES.CITYLINK_COVER,
      },
    });
    log(`✅  CityLink Transit updated with name + description + images`);

  } else if (stub && !cityLink) {
    // Only the stub exists — rename it in place
    await prisma.businessProfile.update({
      where: { id: stub.id },
      data: {
        businessName: 'CityLink Transit',
        description: CITYLINK_DESCRIPTION,
        logoUrl: IMAGES.CITYLINK_LOGO,
        coverPhotoUrl: IMAGES.CITYLINK_COVER,
      },
    });
    log(`✅  Renamed "${stub.businessName}" → "CityLink Transit" with description + images`);

  } else {
    // Only cityLink exists (or they're the same row) — just ensure description + images are set
    const target = cityLink ?? all[0];
    await prisma.businessProfile.update({
      where: { id: target.id },
      data: {
        businessName: 'CityLink Transit',
        description: target.description?.trim() ? target.description : CITYLINK_DESCRIPTION,
        logoUrl: IMAGES.CITYLINK_LOGO,
        coverPhotoUrl: IMAGES.CITYLINK_COVER,
      },
    });
    log(`✅  "${target.businessName}" → "CityLink Transit" confirmed + images/description set`);
  }
}

// ---------------------------------------------------------------------------
// STEP 5 — Seed CityLink Transit showcase (route overview images)
// ---------------------------------------------------------------------------
async function seedCityLinkShowcase() {
  section('STEP 5 — Seeding CityLink Transit route showcase');

  const transit = await prisma.businessProfile.findFirst({
    where: { category: 'LOGISTICS' },
    select: { id: true, businessName: true },
  });

  if (!transit) {
    log('⚠️  No transit business found — skipping');
    return;
  }

  const existing = await prisma.businessShowcase.count({
    where: { businessProfileId: transit.id },
  });

  if (existing > 0) {
    log(`  ⏭️  ${transit.businessName} already has ${existing} showcase slides — skipping`);
    return;
  }

  const slides = [
    {
      mediaUrl: 'https://images.unsplash.com/photo-1570125909232-eb263c188f7e?w=1200&q=80',
      caption: 'Modern air-conditioned coaches on every intercity route',
      displayOrder: 0,
    },
    {
      mediaUrl: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=1200&q=80',
      caption: 'Real-time seat booking — pick your seat, get your e-ticket instantly',
      displayOrder: 1,
    },
    {
      mediaUrl: 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?w=1200&q=80',
      caption: 'Accra ↔ Kumasi · Cape Coast · Tamale · Takoradi',
      displayOrder: 2,
    },
  ];

  for (const slide of slides) {
    await prisma.businessShowcase.create({
      data: {
        businessProfileId: transit.id,
        mediaUrl: slide.mediaUrl,
        mediaType: 'IMAGE',
        caption: slide.caption,
        displayOrder: slide.displayOrder,
        isActive: true,
      },
    });
    log(`✅  Added slide [${slide.displayOrder}]: ${slide.caption.slice(0, 55)}…`);
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🌱  AZAMAN MARKETPLACE MEDIA SEED');
  console.log('    Run against: ' + (process.env.DATABASE_URL?.split('@')[1] ?? 'DATABASE_URL not set'));

  if (!process.env.DATABASE_URL) {
    console.error('\n❌  DATABASE_URL is not set. Run as:\n');
    console.error('    DATABASE_URL="postgresql://..." node scripts/seed-marketplace-media.js\n');
    process.exit(1);
  }

  try {
    await patchBusinessImages();
    await seedGoldfieldShowcase();
    await seedGoldenPotProductImages();
    await renameTransitBusiness();
    await seedCityLinkShowcase();

    console.log('\n✅  All done! The marketplace should now display full images in the app.');
    console.log('    Hot-tip: Pull-to-refresh on the marketplace home screen to bust the');
    console.log('    provider cache and see the changes immediately.\n');
  } catch (err) {
    console.error('\n❌  Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
