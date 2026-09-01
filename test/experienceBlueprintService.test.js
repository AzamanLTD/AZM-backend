const {
  EXPERIENCE_BLUEPRINT_VERSION,
  PRESETS,
  COMMIT_STYLES,
  defaultsForCategory,
  normalizeExperienceBlueprint,
  getExperienceBlueprint,
} = require('../services/experienceBlueprintService');

describe('experienceBlueprintService', () => {
  test('every supported category receives a native journey preset', () => {
    expect(defaultsForCategory('FOOD_BEVERAGE').preset).toBe(PRESETS.DINING_JOURNEY);
    expect(defaultsForCategory('RETAIL').preset).toBe(PRESETS.SHOP_FLOOR);
    expect(defaultsForCategory('HOSPITALITY').preset).toBe(PRESETS.BUILDING_WALK);
    expect(defaultsForCategory('LOGISTICS').preset).toBe(PRESETS.TRAVEL_JOURNEY);
  });

  test('commit styles expose stable enum values and category defaults', () => {
    expect(COMMIT_STYLES.MATERIAL).toBe('MATERIAL');
    expect(COMMIT_STYLES.PAPER_RIP).toBe('PAPER_RIP');
    expect(COMMIT_STYLES.LIFT_INTO_TRAY).toBe('LIFT_INTO_TRAY');

    const blueprint = defaultsForCategory('FOOD_BEVERAGE');
    expect(blueprint.detail.presentation).toBe('DISH_DOSSIER');
    expect(blueprint.customerContext.tableNumber).toBe(true);
    expect(blueprint.customerContext.serviceMode).toBe(true);
    expect(blueprint.commit.style).toBe(COMMIT_STYLES.PAPER_RIP);
  });

  test('invalid or cross-category preset requests normalize back to the category grammar', () => {
    const blueprint = normalizeExperienceBlueprint(
      {
        preset: PRESETS.BUILDING_WALK,
        commit: { style: COMMIT_STYLES.PAPER_RIP },
      },
      'FOOD_BEVERAGE',
    );

    expect(blueprint.schemaVersion).toBe(EXPERIENCE_BLUEPRINT_VERSION);
    expect(blueprint.preset).toBe(PRESETS.DINING_JOURNEY);
    expect(blueprint.commit.style).toBe(COMMIT_STYLES.PAPER_RIP);
  });

  test('reduced-motion fallback is always platform controlled', () => {
    const blueprint = normalizeExperienceBlueprint(
      { motion: { reducedMotionSafe: false, tempo: 'QUICK' } },
      'RETAIL',
    );
    expect(blueprint.motion.reducedMotionSafe).toBe(true);
    expect(blueprint.motion.tempo).toBe('QUICK');
  });

  test('stored blueprint is exposed only through the normalized contract', () => {
    const business = {
      category: 'HOSPITALITY',
      businessMeta: {
        experienceBlueprint: {
          schemaVersion: 1,
          preset: PRESETS.BUILDING_WALK,
          navigation: { showProgress: false },
          motion: { tempo: 'RELAXED' },
        },
      },
    };

    const result = getExperienceBlueprint(business);
    expect(result.schemaVersion).toBe(1);
    expect(result.preset).toBe(PRESETS.BUILDING_WALK);
    expect(result.navigation.showProgress).toBe(false);
    expect(result.motion.reducedMotionSafe).toBe(true);
    expect(result.commit.persistentTray).toBe(true);
  });
});
