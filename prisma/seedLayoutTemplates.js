'use strict';

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedTemplates() {
  logger.info('[Seed] Seeding storefront layout templates...');

  // First ensure we have the themes to reference
  const classicLight = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'classic_light' } });
  const warmSunset = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'warm_sunset' } });
  const oceanBreeze = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'ocean_breeze' } });
  const royalGold = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'royal_gold' } });
  const neonPulse = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'neon_pulse' } });
  const minimalMono = await prisma.businessStorefrontTheme.findUnique({ where: { key: 'minimal_mono' } });

  const templates = [
    {
      name: 'Restaurant Starter',
      description: 'Hero header + quick info + product grid + reviews + contact',
      category: 'RESTAURANT',
      tier: 'FREE',
      minAzmStake: 0,
      themeId: classicLight?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_h001', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 }, props: { mediaUrl: null, title: null, subtitle: 'Restaurant · Open until 10 PM', overlayOpacity: 0.3, height: 'standard' } },
          { id: 'tile_q002', widgetType: 'quick_info_bar', position: { row: 2, col: 0, rowSpan: 1, colSpan: 4 }, props: { showHours: true, showRating: true, showCategory: true, customInfo: '' } },
          { id: 'tile_p003', widgetType: 'product_grid', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Popular Dishes', maxItems: 6, columns: 2, showPrice: true } },
          { id: 'tile_r004', widgetType: 'review_carousel', position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'What People Say', maxReviews: 5, minRating: 4 } },
          { id: 'tile_c005', widgetType: 'contact_card', position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: false } },
        ],
      },
      isActive: true, displayOrder: 0,
    },
    {
      name: 'Hotel Showcase',
      description: 'Hero + gallery + location + contact + action buttons',
      category: 'HOTEL',
      tier: 'FREE',
      minAzmStake: 0,
      themeId: classicLight?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_h101', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 3, colSpan: 4 }, props: { mediaUrl: null, title: 'Welcome', subtitle: 'Hotel · Book Your Stay', overlayOpacity: 0.3, height: 'tall' } },
          { id: 'tile_g102', widgetType: 'showcase_gallery', position: { row: 3, col: 0, rowSpan: 3, colSpan: 4 }, props: { title: 'Our Rooms', maxItems: 8, autoplay: false } },
          { id: 'tile_l103', widgetType: 'location_map', position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'Find Us', zoom: 14 } },
          { id: 'tile_a104', widgetType: 'action_buttons', position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 }, props: { showOrder: false, showBook: true, showFollow: true, showShare: true } },
          { id: 'tile_c105', widgetType: 'contact_card', position: { row: 9, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: true } },
        ],
      },
      isActive: true, displayOrder: 1,
    },
    {
      name: 'Retail Store',
      description: 'Hero + product grid + promo + reviews + contact',
      category: 'RETAIL',
      tier: 'FREE',
      minAzmStake: 0,
      themeId: classicLight?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_h201', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 }, props: { mediaUrl: null, title: null, subtitle: 'Shop Quality Products', overlayOpacity: 0.3, height: 'standard' } },
          { id: 'tile_p202', widgetType: 'product_grid', position: { row: 2, col: 0, rowSpan: 4, colSpan: 4 }, props: { title: 'Featured Products', maxItems: 8, columns: 2, showPrice: true } },
          { id: 'tile_r203', widgetType: 'review_carousel', position: { row: 6, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'Customer Reviews', maxReviews: 5, minRating: 4 } },
          { id: 'tile_c204', widgetType: 'contact_card', position: { row: 8, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: true, showEmail: false, showWebsite: true } },
        ],
      },
      isActive: true, displayOrder: 2,
    },
    {
      name: 'Food Delivery Pro',
      description: 'Restaurant with promo banner and video — Nitro Bronze',
      category: 'RESTAURANT',
      tier: 'NITRO_BRONZE',
      minAzmStake: 500,
      themeId: warmSunset?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_h301', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 }, props: { mediaUrl: null, title: null, subtitle: 'Hot Food, Fast Delivery', overlayOpacity: 0.3, height: 'standard' } },
          { id: 'tile_p302', widgetType: 'promo_banner', position: { row: 2, col: 0, rowSpan: 1, colSpan: 4 }, props: { title: '20% OFF First Order', subtitle: 'Use code WELCOME20', ctaText: 'Order Now', ctaAction: '', backgroundColor: null } },
          { id: 'tile_q303', widgetType: 'quick_info_bar', position: { row: 3, col: 0, rowSpan: 1, colSpan: 4 }, props: { showHours: true, showRating: true, showCategory: true, customInfo: '' } },
          { id: 'tile_p304', widgetType: 'product_grid', position: { row: 4, col: 0, rowSpan: 4, colSpan: 4 }, props: { title: 'Popular Dishes', maxItems: 8, columns: 2, showPrice: true } },
          { id: 'tile_r305', widgetType: 'review_carousel', position: { row: 8, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'What People Say', maxReviews: 5, minRating: 4 } },
          { id: 'tile_a306', widgetType: 'action_buttons', position: { row: 10, col: 0, rowSpan: 1, colSpan: 4 }, props: { showOrder: true, showBook: false, showFollow: true, showShare: true } },
        ],
      },
      isActive: true, displayOrder: 3,
    },
    {
      name: 'Luxury Brand',
      description: 'Premium layout with gradient hero and custom HTML — Nitro Gold',
      category: 'UNIVERSAL',
      tier: 'NITRO_GOLD',
      minAzmStake: 5000,
      themeId: royalGold?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_g401', widgetType: 'gradient_hero', position: { row: 0, col: 0, rowSpan: 4, colSpan: 4 }, props: { title: 'Premium Experience', subtitle: 'Discover Excellence', gradientFrom: '#D4AF37', gradientTo: '#1A1A1A', animationSpeed: 'medium' } },
          { id: 'tile_v402', widgetType: 'video_player', position: { row: 4, col: 0, rowSpan: 3, colSpan: 4 }, props: { videoUrl: null, posterUrl: null, autoplay: false, loop: true, muted: true } },
          { id: 'tile_p403', widgetType: 'product_grid', position: { row: 7, col: 0, rowSpan: 4, colSpan: 4 }, props: { title: 'Featured Collection', maxItems: 6, columns: 2, showPrice: true } },
          { id: 'tile_s404', widgetType: 'social_feed', position: { row: 11, col: 0, rowSpan: 3, colSpan: 4 }, props: { platform: 'instagram', handle: '', maxPosts: 6 } },
          { id: 'tile_l405', widgetType: 'location_map', position: { row: 14, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'Visit Us', zoom: 14 } },
          { id: 'tile_c406', widgetType: 'contact_card', position: { row: 16, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: false, showEmail: true, showWebsite: true } },
        ],
      },
      isActive: true, displayOrder: 4,
    },
    {
      name: 'Minimal Professional',
      description: 'Clean, minimal layout for services — Free',
      category: 'UNIVERSAL',
      tier: 'FREE',
      minAzmStake: 0,
      themeId: minimalMono?.id || null,
      layoutJson: {
        schemaVersion: 1,
        gridColumns: 4,
        tiles: [
          { id: 'tile_h501', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 2, colSpan: 4 }, props: { mediaUrl: null, title: null, subtitle: 'Professional Services', overlayOpacity: 0.2, height: 'compact' } },
          { id: 'tile_q502', widgetType: 'quick_info_bar', position: { row: 2, col: 0, rowSpan: 1, colSpan: 4 }, props: { showHours: true, showRating: false, showCategory: true, customInfo: '' } },
          { id: 'tile_c503', widgetType: 'contact_card', position: { row: 3, col: 0, rowSpan: 1, colSpan: 4 }, props: { showPhone: true, showWhatsApp: false, showEmail: true, showWebsite: true } },
          { id: 'tile_l504', widgetType: 'location_map', position: { row: 4, col: 0, rowSpan: 2, colSpan: 4 }, props: { title: 'Office Location', zoom: 15 } },
        ],
      },
      isActive: true, displayOrder: 5,
    },
  ];

  for (const tpl of templates) {
    const existing = await prisma.businessStorefrontLayoutTemplate.findFirst({
      where: { name: tpl.name },
    });
    if (existing) {
      await prisma.businessStorefrontLayoutTemplate.update({
        where: { id: existing.id },
        data: tpl,
      });
    } else {
      await prisma.businessStorefrontLayoutTemplate.create({ data: tpl });
    }
  }

  logger.info(`[Seed] ${templates.length} storefront templates seeded`);
}

module.exports = { seedTemplates };

if (require.main === module) {
  seedTemplates()
    .catch((e) => { logger.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
