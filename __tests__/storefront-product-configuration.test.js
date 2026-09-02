'use strict';

const {
  validateConfiguredProduct,
  configuredUnitPrice,
  normalizedSelection,
} = require('../services/storefrontProductConfigurationService');

describe('storefront product configuration', () => {
  const product = {
    priceUsdc: 12,
    variants: [
      { id: 'small', name: 'Regular', priceDelta: 0 },
      { id: 'large', name: 'Large', priceDelta: 3 },
    ],
    modifierGroups: [
      {
        name: 'Sauce',
        required: true,
        maxSelection: 1,
        options: [
          { id: 'pepper', name: 'Pepper', priceDelta: 1 },
          { id: 'mild', name: 'Mild', priceDelta: 0 },
        ],
      },
      {
        name: 'Extras',
        required: false,
        maxSelection: 2,
        options: [
          { id: 'egg', name: 'Egg', priceDelta: 2 },
          { id: 'plantain', name: 'Plantain', priceDelta: 2.5 },
        ],
      },
    ],
  };

  test('accepts a valid size and modifier selection', () => {
    expect(validateConfiguredProduct(product, {
      size: 'Large',
      Sauce: 'Pepper',
      Extras: 'Egg, Plantain',
    }).error).toBeNull();
  });

  test('rejects missing required modifier', () => {
    expect(validateConfiguredProduct(product, { size: 'Large' }).error).toContain('Sauce');
  });

  test('rejects an unknown option and excessive selections', () => {
    expect(validateConfiguredProduct(product, { size: 'Large', Sauce: 'BBQ' }).error).toContain('Invalid option');
    expect(validateConfiguredProduct(product, { size: 'Large', Sauce: 'Pepper', Extras: 'Egg, Plantain, Cheese' }).error).toContain('at most 2');
  });

  test('calculates authoritative configured price and normalized snapshot', () => {
    const selection = { size: 'Large', Sauce: 'Pepper', Extras: 'Egg, Plantain' };
    expect(configuredUnitPrice(product, selection)).toBe(20.5);
    expect(normalizedSelection(product, selection)).toEqual({ Size: 'Large', Sauce: ['Pepper'], Extras: ['Egg', 'Plantain'] });
  });
});
