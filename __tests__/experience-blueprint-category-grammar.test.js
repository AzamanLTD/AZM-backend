'use strict';

const {
  CATEGORY_OPTIONS,
  categoryOptions,
  defaultsForCategory,
  normalizeExperienceBlueprint,
} = require('../services/experienceBlueprintService');

describe('Experience Blueprint category grammar', () => {
  test.each([
    ['FOOD_BEVERAGE', 'CONTEXTUAL', 'DISH_DOSSIER', 'PAPER_RIP'],
    ['RETAIL', 'AISLE_TRAVERSE', 'PRODUCT_DOSSIER', 'LIFT_INTO_TRAY'],
    ['HOSPITALITY', 'FLOOR_TRAVERSE', 'ROOM_DOSSIER', 'MATERIAL'],
    ['LOGISTICS', 'JOURNEY_TIMELINE', 'SEAT_DOSSIER', 'MATERIAL'],
  ])('defaults stay inside the valid %s grammar', (category, navigation, detail, commit) => {
    const blueprint = defaultsForCategory(category);

    expect(blueprint.navigation.mode).toBe(navigation);
    expect(blueprint.detail.presentation).toBe(detail);
    expect(blueprint.commit.style).toBe(commit);
    expect(categoryOptions(category).navigationModes).toContain(blueprint.navigation.mode);
    expect(categoryOptions(category).detailPresentations).toContain(blueprint.detail.presentation);
    expect(categoryOptions(category).commitStyles).toContain(blueprint.commit.style);
  });

  test('normalization rejects cross-vertical navigation, detail and commit values', () => {
    const blueprint = normalizeExperienceBlueprint({
      navigation: { mode: 'FLOOR_TRAVERSE' },
      detail: { presentation: 'ROOM_DOSSIER' },
      commit: { style: 'LIFT_INTO_TRAY' },
    }, 'FOOD_BEVERAGE');

    expect(blueprint.navigation.mode).toBe('CONTEXTUAL');
    expect(blueprint.detail.presentation).toBe('DISH_DOSSIER');
    expect(blueprint.commit.style).toBe('PAPER_RIP');
  });

  test('retail keeps aisle navigation while rejecting travel-only concepts', () => {
    const blueprint = normalizeExperienceBlueprint({
      navigation: { mode: 'JOURNEY_TIMELINE' },
      detail: { presentation: 'SEAT_DOSSIER' },
      commit: { style: 'PAPER_RIP' },
    }, 'RETAIL');

    expect(blueprint.navigation.mode).toBe('AISLE_TRAVERSE');
    expect(blueprint.detail.presentation).toBe('PRODUCT_DOSSIER');
    expect(blueprint.commit.style).toBe('LIFT_INTO_TRAY');
  });

  test('hospitality cannot opt into a consumer cart commit ritual', () => {
    const blueprint = normalizeExperienceBlueprint({
      commit: { style: 'LIFT_INTO_TRAY', persistentTray: true },
      customerContext: { tableNumber: true, passenger: true },
    }, 'HOSPITALITY');

    expect(blueprint.commit.style).toBe('MATERIAL');
    expect(blueprint.customerContext.tableNumber).toBe(false);
    expect(blueprint.customerContext.passenger).toBe(false);
  });

  test('logistics keeps passenger context and rejects restaurant-only context', () => {
    const blueprint = normalizeExperienceBlueprint({
      customerContext: { tableNumber: true, serviceMode: true, passenger: true },
    }, 'LOGISTICS');

    expect(blueprint.customerContext.tableNumber).toBe(false);
    expect(blueprint.customerContext.serviceMode).toBe(false);
    expect(blueprint.customerContext.passenger).toBe(true);
  });

  test('normalization is case-insensitive for category keys', () => {
    expect(defaultsForCategory(' retail ').preset).toBe(defaultsForCategory('RETAIL').preset);
    expect(categoryOptions('hospitality')).toEqual(categoryOptions('HOSPITALITY'));
  });

  test('unknown categories receive a safe service grammar', () => {
    const blueprint = normalizeExperienceBlueprint({
      navigation: { mode: 'AISLE_TRAVERSE' },
      detail: { presentation: 'PRODUCT_DOSSIER' },
      commit: { style: 'PAPER_RIP' },
      customerContext: { tableNumber: true, serviceMode: true, passenger: true },
    }, 'HEALTH_WELLNESS');

    expect(blueprint.navigation.mode).toBe('CONTEXTUAL');
    expect(blueprint.detail.presentation).toBe('SERVICE_DOSSIER');
    expect(blueprint.commit.style).toBe('MATERIAL');
    expect(blueprint.customerContext).toEqual({
      enabled: true,
      tableNumber: false,
      serviceMode: false,
      passenger: false,
    });
  });

  test('default grammar remains immutable to callers', () => {
    expect(Object.isFrozen(CATEGORY_OPTIONS.FOOD_BEVERAGE)).toBe(true);
    expect(Object.isFrozen(CATEGORY_OPTIONS.FOOD_BEVERAGE.navigationModes)).toBe(true);
  });
});