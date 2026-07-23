'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
  console.log('Seeding storefront catalog (themes and widgets)...');

  // Create default theme if not exists
  const defaultTheme = await prisma.businessStorefrontTheme.upsert({
    where: { key: 'classic_light' },
    update: {},
    create: {
      key: 'classic_light',
      name: 'Classic Light',
      category: 'UNIVERSAL',
      isActive: true,
      tokenSet: {
        background: '#ffffff',
        surface: '#f8f9fa',
        textPrimary: '#1f2937',
        accent: '#6C4FD1',
      },
      typography: {
        fontFamily: 'Inter, sans-serif',
      },
    },
  });

  console.log('Upserted default theme:', defaultTheme.name);

  // Widget types that map to our Flutter widgets
  const widgetTypes = [
    'hero_header', 'quick_info_bar', 'product_grid', 'review_carousel',
    'showcase_gallery', 'location_map', 'action_buttons', 'contact_card'
  ];

  for (const widgetType of widgetTypes) {
    await prisma.businessStorefrontWidgetCatalog.upsert({
      where: { widgetType },
      update: { isActive: true },
      create: {
        widgetType,
        name: widgetType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        description: `Default ${widgetType} widget`,
        category: 'UNIVERSAL',
        isActive: true,
        defaultProps: {},
      },
    });
  }

  console.log('Seeded widget catalog');
  await prisma.$disconnect();
}

seed().catch(e => {
  console.error(e);
  process.exit(1);
});
