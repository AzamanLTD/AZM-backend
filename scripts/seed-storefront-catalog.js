'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
  console.log('Seeding storefront catalog (themes and widgets)...');

  // ── Themes ──────────────────────────────────────────────────────
  const themes = [
    {
      key: 'classic_light',
      name: 'Classic Light',
      category: 'UNIVERSAL',
      isActive: true,
      minAzmStake: 0,
      tier: 'FREE',
      tokenSet: { background: '#ffffff', surface: '#f8f9fa', surfaceSolid: '#ffffff', border: '#e5e7eb', textPrimary: '#1f2937', textSecondary: '#6b7280', textMuted: '#9ca3af', accent: '#6C4FD1', accentHover: '#5a3fb8' },
      typography: { fontFamily: 'Inter, sans-serif', headingFont: 'Inter, sans-serif' },
    },
    {
      key: 'classic_dark',
      name: 'Classic Dark',
      category: 'UNIVERSAL',
      isActive: true,
      minAzmStake: 0,
      tier: 'FREE',
      tokenSet: { background: '#0f0f14', surface: '#1a1a24', surfaceSolid: '#15151e', border: '#2a2a36', textPrimary: '#f3f4f6', textSecondary: '#9ca3af', textMuted: '#6b7280', accent: '#8b5cf6', accentHover: '#7c3aed' },
      typography: { fontFamily: 'Inter, sans-serif', headingFont: 'Inter, sans-serif' },
    },
    {
      key: 'warm_sunset',
      name: 'Warm Sunset',
      category: 'UNIVERSAL',
      isActive: true,
      minAzmStake: 500,
      tier: 'NITRO_BRONZE',
      tokenSet: { background: '#fff8f3', surface: '#fef3e8', surfaceSolid: '#ffffff', border: '#f0d9bc', textPrimary: '#3d2b1f', textSecondary: '#8b6f47', textMuted: '#c4a777', accent: '#d97706', accentHover: '#b45309' },
      typography: { fontFamily: 'Poppins, sans-serif', headingFont: 'Poppins, sans-serif' },
    },
    {
      key: 'ocean_breeze',
      name: 'Ocean Breeze',
      category: 'UNIVERSAL',
      isActive: true,
      minAzmStake: 1500,
      tier: 'NITRO_SILVER',
      tokenSet: { background: '#f0f9ff', surface: '#e0f2fe', surfaceSolid: '#ffffff', border: '#bae6fd', textPrimary: '#0c4a6e', textSecondary: '#0369a1', textMuted: '#7dd3fc', accent: '#0ea5e9', accentHover: '#0284c7' },
      typography: { fontFamily: 'Poppins, sans-serif', headingFont: 'Poppins, sans-serif' },
    },
    {
      key: 'midnight_gold',
      name: 'Midnight Gold',
      category: 'UNIVERSAL',
      isActive: true,
      minAzmStake: 5000,
      tier: 'NITRO_GOLD',
      tokenSet: { background: '#0a0a0f', surface: '#14141e', surfaceSolid: '#1a1a26', border: '#2a2a3e', textPrimary: '#fef3c7', textSecondary: '#d4af37', textMuted: '#92651e', accent: '#d4af37', accentHover: '#b8931f' },
      typography: { fontFamily: 'Playfair Display, serif', headingFont: 'Playfair Display, serif' },
    },
  ];

  for (const theme of themes) {
    const { key, ...data } = theme;
    await prisma.businessStorefrontTheme.upsert({
      where: { key },
      update: { ...data },
      create: { key, ...data },
    });
    console.log(`  Theme: ${theme.name} (${theme.tier})`);
  }

  // ── Widget Catalog (all 15 widgets) ─────────────────────────────
  const widgets = [
    { widgetType: 'hero_header',         name: 'Hero Header',         category: 'HEADER',  defaultProps: { mediaUrl: null, mediaType: 'image', title: null, subtitle: 'Welcome to our store', overlayOpacity: 0.3, height: 'standard' }, configSchema: { properties: { title: {}, subtitle: {}, mediaUrl: {}, overlayOpacity: {}, height: {} } } },
    { widgetType: 'quick_info_bar',      name: 'Quick Info Bar',      category: 'HEADER',  defaultProps: { showHours: true, showRating: true, showCategory: true, customInfo: '' }, configSchema: { properties: { customInfo: {} } } },
    { widgetType: 'product_grid',        name: 'Product Grid',        category: 'COMMERCE', defaultProps: { title: 'Popular Items', maxItems: 6, columns: 2, showPrice: true }, configSchema: { properties: { title: {}, maxItems: {}, columns: {}, showPrice: {} } } },
    { widgetType: 'review_carousel',     name: 'Review Carousel',     category: 'SOCIAL',  defaultProps: { title: 'What People Say', maxReviews: 5, minRating: 4 }, configSchema: { properties: { title: {}, maxReviews: {}, minRating: {} } } },
    { widgetType: 'contact_card',        name: 'Contact Card',        category: 'CONTENT', defaultProps: { showPhone: true, showWhatsApp: true, showEmail: false }, configSchema: { properties: { showPhone: {}, showWhatsApp: {}, showEmail: {} } } },
    { widgetType: 'showcase_gallery',     name: 'Showcase Gallery',    category: 'MEDIA',   defaultProps: { title: 'Our Gallery', maxItems: 8, autoplay: false }, configSchema: { properties: { title: {}, maxItems: {}, autoplay: {} } } },
    { widgetType: 'location_map',        name: 'Location Map',        category: 'CONTENT', defaultProps: { title: 'Find Us', zoom: 14 }, configSchema: { properties: { title: {}, zoom: {} } } },
    { widgetType: 'action_buttons',      name: 'Action Buttons',      category: 'CONTENT', defaultProps: { showOrder: true, showBook: false, showFollow: true, showShare: true }, configSchema: { properties: { showOrder: {}, showBook: {}, showFollow: {}, showShare: {} } } },
    { widgetType: 'announcement_banner',  name: 'Announcement Banner',  category: 'CONTENT', defaultProps: { title: 'Special Offer', body: 'Check out our latest deals!', ctaText: 'Learn More', ctaUrl: '' }, configSchema: { properties: { title: {}, body: {}, ctaText: {}, ctaUrl: {} } } },
    { widgetType: 'social_links',        name: 'Social Links',        category: 'SOCIAL',  defaultProps: { showInstagram: true, showTwitter: true, showFacebook: true, showTikTok: false }, configSchema: { properties: { showInstagram: {}, showTwitter: {}, showFacebook: {}, showTikTok: {} } } },
    { widgetType: 'staff_highlight',      name: 'Staff Highlight',     category: 'CONTENT', minAzmStake: 500, tier: 'NITRO_BRONZE', defaultProps: { title: 'Meet Our Team', maxStaff: 4 }, configSchema: { properties: { title: {}, maxStaff: {} } } },
    { widgetType: 'video_block',         name: 'Video Block',         category: 'MEDIA',   minAzmStake: 1500, tier: 'NITRO_SILVER', defaultProps: { videoUrl: '', autoplay: false, title: '' }, configSchema: { properties: { title: {}, videoUrl: {}, autoplay: {} } } },
    { widgetType: 'promo_countdown',      name: 'Promo Countdown',     category: 'COMMERCE', minAzmStake: 1500, tier: 'NITRO_SILVER', defaultProps: { title: 'Limited Time Offer', endDate: '', ctaText: 'Shop Now' }, configSchema: { properties: { title: {}, endDate: {}, ctaText: {} } } },
    { widgetType: 'loyalty_widget',      name: 'Loyalty Stamps',       category: 'COMMERCE', minAzmStake: 5000, tier: 'NITRO_GOLD', defaultProps: { title: 'Loyalty Card', maxStamps: 5 }, configSchema: { properties: { title: {}, maxStamps: {} } } },
    { widgetType: 'rich_text_block',     name: 'Rich Text Block',     category: 'CONTENT', defaultProps: { title: '', body: '' }, configSchema: { properties: { title: {}, body: {} } } },
  ];

  for (const widget of widgets) {
    const { widgetType, ...data } = widget;
    await prisma.businessStorefrontWidgetCatalog.upsert({
      where: { widgetType },
      update: { ...data, isActive: true },
      create: { widgetType, ...data, isActive: true },
    });
    console.log(`  Widget: ${widget.name} (${widget.category}${widget.minAzmStake ? ' / ' + widget.tier : ''})`);
  }

  console.log(`\nSeeded ${themes.length} themes and ${widgets.length} widgets.`);
  await prisma.$disconnect();
}

seed().catch(e => {
  console.error(e);
  process.exit(1);
});
