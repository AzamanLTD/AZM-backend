const fs = require('node:fs');
const path = require('node:path');

describe('storefront widget catalog contract', () => {
  test('seeds retail collection and keeps a contiguous 16-widget display order', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../prisma/seedWidgetCatalog.js'),
      'utf8',
    );

    expect(source).toContain("widgetType: 'retail_collection_box'");
    expect(source).toContain("displayName: 'Retail Collection'");
    expect(source).toContain("collectionId: { type: 'string', title: 'Collection ID' }");
    expect(source).toContain("products: {\n            type: 'array'");
    expect(source).toContain("defaultProps: { collectionId: null, title: 'Collection', subtitle: '', products: [] }");
    expect(source).toContain("isActive: true, displayOrder: 8,");

    const displayOrders = [...source.matchAll(/isActive: true, displayOrder: (\d+),/g)]
      .map((match) => Number(match[1]));
    expect(displayOrders).toHaveLength(16);
    expect(displayOrders).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });
});
