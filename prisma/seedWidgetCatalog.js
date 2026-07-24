'use strict';

const logger = require('../src/config/logger');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedWidgets() {
  logger.info('[Seed] Seeding storefront widget catalog...');

  const widgets = [
    // ── FREE widgets ──
    {
      widgetType: 'hero_header',
      displayName: 'Hero Header',
      description: 'Large banner with optional image, title, and subtitle',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'HEADER',
      icon: 'Image',
      configSchema: {
        type: 'object',
        properties: {
          mediaUrl: { type: 'string', title: 'Background Image URL' },
          mediaType: { type: 'string', enum: ['image', 'video'], default: 'image' },
          title: { type: 'string', title: 'Title' },
          subtitle: { type: 'string', title: 'Subtitle' },
          overlayOpacity: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
          height: { type: 'string', enum: ['compact', 'standard', 'tall'], default: 'standard' },
        },
      },
      defaultProps: { mediaUrl: null, mediaType: 'image', title: null, subtitle: null, overlayOpacity: 0.3, height: 'standard' },
      minRowSpan: 2, maxRowSpan: 4, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 0,
    },
    {
      widgetType: 'quick_info_bar',
      displayName: 'Quick Info Bar',
      description: 'Horizontal bar with business hours, rating, category',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'CONTENT',
      icon: 'Info',
      configSchema: {
        type: 'object',
        properties: {
          showHours: { type: 'boolean', default: true },
          showRating: { type: 'boolean', default: true },
          showCategory: { type: 'boolean', default: true },
          customInfo: { type: 'string' },
        },
      },
      defaultProps: { showHours: true, showRating: true, showCategory: true, customInfo: '' },
      minRowSpan: 1, maxRowSpan: 1, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 1,
    },
    {
      widgetType: 'product_grid',
      displayName: 'Product Grid',
      description: 'Grid of products with images, names, and prices',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'COMMERCE',
      icon: 'ShoppingBag',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'Featured Products' },
          maxItems: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
          columns: { type: 'integer', enum: [2, 3], default: 2 },
          showPrice: { type: 'boolean', default: true },
        },
      },
      defaultProps: { title: 'Featured Products', maxItems: 6, columns: 2, showPrice: true },
      minRowSpan: 2, maxRowSpan: 6, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 2,
    },
    {
      widgetType: 'showcase_gallery',
      displayName: 'Showcase Gallery',
      description: 'Swipeable image gallery for business showcase',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'MEDIA',
      icon: 'Images',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'Gallery' },
          maxItems: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
          autoplay: { type: 'boolean', default: false },
        },
      },
      defaultProps: { title: 'Gallery', maxItems: 8, autoplay: false },
      minRowSpan: 2, maxRowSpan: 4, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 3,
    },
    {
      widgetType: 'review_carousel',
      displayName: 'Review Carousel',
      description: 'Scrolling customer reviews with ratings',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'SOCIAL',
      icon: 'Star',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'What People Say' },
          maxReviews: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
          minRating: { type: 'integer', minimum: 1, maximum: 5, default: 4 },
        },
      },
      defaultProps: { title: 'What People Say', maxReviews: 5, minRating: 4 },
      minRowSpan: 2, maxRowSpan: 3, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 4,
    },
    {
      widgetType: 'contact_card',
      displayName: 'Contact Card',
      description: 'Phone, email, WhatsApp, website links',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'CONTENT',
      icon: 'Phone',
      configSchema: {
        type: 'object',
        properties: {
          showPhone: { type: 'boolean', default: true },
          showWhatsApp: { type: 'boolean', default: true },
          showEmail: { type: 'boolean', default: true },
          showWebsite: { type: 'boolean', default: false },
        },
      },
      defaultProps: { showPhone: true, showWhatsApp: true, showEmail: true, showWebsite: false },
      minRowSpan: 1, maxRowSpan: 2, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 5,
    },
    {
      widgetType: 'location_map',
      displayName: 'Location Map',
      description: 'Interactive map with business location',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'CONTENT',
      icon: 'MapPin',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'Find Us' },
          zoom: { type: 'integer', minimum: 1, maximum: 20, default: 14 },
        },
      },
      defaultProps: { title: 'Find Us', zoom: 14 },
      minRowSpan: 2, maxRowSpan: 4, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 6,
    },
    {
      widgetType: 'action_buttons',
      displayName: 'Action Buttons',
      description: 'Quick action buttons (order, book, follow)',
      tier: 'FREE',
      minAzmStake: 0,
      category: 'COMMERCE',
      icon: 'MousePointerClick',
      configSchema: {
        type: 'object',
        properties: {
          showOrder: { type: 'boolean', default: true },
          showBook: { type: 'boolean', default: false },
          showFollow: { type: 'boolean', default: true },
          showShare: { type: 'boolean', default: true },
        },
      },
      defaultProps: { showOrder: true, showBook: false, showFollow: true, showShare: true },
      minRowSpan: 1, maxRowSpan: 1, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 7,
    },

    // ── NITRO BRONZE widgets ──
    {
      widgetType: 'video_player',
      displayName: 'Video Player',
      description: 'Embedded video widget with autoplay and loop',
      tier: 'NITRO_BRONZE',
      minAzmStake: 500,
      category: 'MEDIA',
      icon: 'Video',
      configSchema: {
        type: 'object',
        properties: {
          videoUrl: { type: 'string', title: 'Video URL' },
          posterUrl: { type: 'string', title: 'Poster Image' },
          autoplay: { type: 'boolean', default: false },
          loop: { type: 'boolean', default: true },
          muted: { type: 'boolean', default: true },
        },
      },
      defaultProps: { videoUrl: null, posterUrl: null, autoplay: false, loop: true, muted: true },
      minRowSpan: 2, maxRowSpan: 4, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 8,
    },
    {
      widgetType: 'promo_banner',
      displayName: 'Promo Banner',
      description: 'Full-width promotional banner with CTA',
      tier: 'NITRO_BRONZE',
      minAzmStake: 500,
      category: 'COMMERCE',
      icon: 'BadgePercent',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          ctaText: { type: 'string', default: 'Shop Now' },
          ctaAction: { type: 'string' },
          backgroundColor: { type: 'string' },
        },
      },
      defaultProps: { title: '', subtitle: '', ctaText: 'Shop Now', ctaAction: '', backgroundColor: null },
      minRowSpan: 1, maxRowSpan: 2, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 9,
    },
    {
      widgetType: 'social_feed',
      displayName: 'Social Feed',
      description: 'Live Instagram/social media feed',
      tier: 'NITRO_BRONZE',
      minAzmStake: 500,
      category: 'SOCIAL',
      icon: 'Instagram',
      configSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['instagram', 'tiktok', 'facebook'], default: 'instagram' },
          handle: { type: 'string' },
          maxPosts: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
        },
      },
      defaultProps: { platform: 'instagram', handle: '', maxPosts: 6 },
      minRowSpan: 2, maxRowSpan: 4, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 10,
    },

    // ── NITRO SILVER widgets ──
    {
      widgetType: 'live_stats',
      displayName: 'Live Stats',
      description: 'Animated counters showing followers, reviews, orders',
      tier: 'NITRO_SILVER',
      minAzmStake: 2000,
      category: 'CONTENT',
      icon: 'BarChart',
      configSchema: {
        type: 'object',
        properties: {
          showFollowers: { type: 'boolean', default: true },
          showReviews: { type: 'boolean', default: true },
          showOrders: { type: 'boolean', default: true },
          showRating: { type: 'boolean', default: true },
        },
      },
      defaultProps: { showFollowers: true, showReviews: true, showOrders: true, showRating: true },
      minRowSpan: 1, maxRowSpan: 2, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 11,
    },
    {
      widgetType: 'animated_counter',
      displayName: 'Animated Counter',
      description: 'Single large animated number with label',
      tier: 'NITRO_SILVER',
      minAzmStake: 2000,
      category: 'CONTENT',
      icon: 'Hash',
      configSchema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'number' },
          suffix: { type: 'string' },
          prefix: { type: 'string' },
        },
      },
      defaultProps: { label: 'Happy Customers', value: 0, suffix: '+', prefix: '' },
      minRowSpan: 1, maxRowSpan: 1, minColSpan: 2, maxColSpan: 4,
      isActive: true, displayOrder: 12,
    },

    // ── NITRO GOLD widgets ──
    {
      widgetType: 'custom_html',
      displayName: 'Custom HTML',
      description: 'Raw HTML content block (sanitized on render)',
      tier: 'NITRO_GOLD',
      minAzmStake: 5000,
      category: 'CONTENT',
      icon: 'Code',
      configSchema: {
        type: 'object',
        properties: {
          html: { type: 'string', title: 'HTML Content' },
          sanitize: { type: 'boolean', default: true },
        },
      },
      defaultProps: { html: '', sanitize: true },
      minRowSpan: 1, maxRowSpan: 6, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 13,
    },
    {
      widgetType: 'gradient_hero',
      displayName: 'Gradient Hero',
      description: 'Full-screen animated gradient hero with text',
      tier: 'NITRO_GOLD',
      minAzmStake: 5000,
      category: 'HEADER',
      icon: 'Sparkles',
      configSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          gradientFrom: { type: 'string', default: '#6C4FD1' },
          gradientTo: { type: 'string', default: '#E07B30' },
          animationSpeed: { type: 'string', enum: ['slow', 'medium', 'fast'], default: 'medium' },
        },
      },
      defaultProps: { title: '', subtitle: '', gradientFrom: '#6C4FD1', gradientTo: '#E07B30', animationSpeed: 'medium' },
      minRowSpan: 3, maxRowSpan: 6, minColSpan: 4, maxColSpan: 4,
      isActive: true, displayOrder: 14,
    },
  ];

  for (const widget of widgets) {
    await prisma.businessStorefrontWidgetCatalog.upsert({
      where: { widgetType: widget.widgetType },
      create: widget,
      update: widget,
    });
  }

  logger.info(`[Seed] ${widgets.length} storefront widgets seeded`);
}

module.exports = { seedWidgets };

if (require.main === module) {
  seedWidgets()
    .catch((e) => { logger.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
