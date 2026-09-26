'use strict';

// =============================================================================
// AZAMAN — EXPERIENCE BLUEPRINT
//
// Describes how a marketplace journey should behave without becoming an
// arbitrary page or animation builder. Domain data remains authoritative in
// the existing catalog, hotel and transit models.
// =============================================================================

const EXPERIENCE_BLUEPRINT_VERSION = 1;

const PRESETS = Object.freeze({
  DINING_JOURNEY: 'DINING_JOURNEY',
  SHOP_FLOOR: 'SHOP_FLOOR',
  BUILDING_WALK: 'BUILDING_WALK',
  TRAVEL_JOURNEY: 'TRAVEL_JOURNEY',
  SERVICE_JOURNEY: 'SERVICE_JOURNEY',
});

const NAVIGATION_MODES = Object.freeze([
  'CONTEXTUAL',
  'FLOOR_TRAVERSE',
  'AISLE_TRAVERSE',
  'JOURNEY_TIMELINE',
]);

const DETAIL_PRESENTATIONS = Object.freeze([
  'MORPH',
  'DISH_DOSSIER',
  'PRODUCT_DOSSIER',
  'ROOM_DOSSIER',
  'SEAT_DOSSIER',
  'SERVICE_DOSSIER',
]);

const MOTION_TEMPOS = Object.freeze(['RELAXED', 'BALANCED', 'QUICK']);
const COMMIT_STYLES = Object.freeze({
  MATERIAL: 'MATERIAL',
  PAPER_RIP: 'PAPER_RIP',
  LIFT_INTO_TRAY: 'LIFT_INTO_TRAY',
});

const CATEGORY_OPTIONS = Object.freeze({
  FOOD_BEVERAGE: Object.freeze({
    navigationModes: Object.freeze(['CONTEXTUAL']),
    detailPresentations: Object.freeze(['MORPH', 'DISH_DOSSIER']),
    commitStyles: Object.freeze([COMMIT_STYLES.MATERIAL, COMMIT_STYLES.PAPER_RIP]),
    customerContext: Object.freeze({ tableNumber: true, serviceMode: true, passenger: false }),
    persistentTray: true,
  }),
  RETAIL: Object.freeze({
    navigationModes: Object.freeze(['CONTEXTUAL', 'AISLE_TRAVERSE']),
    detailPresentations: Object.freeze(['MORPH', 'PRODUCT_DOSSIER']),
    commitStyles: Object.freeze([COMMIT_STYLES.MATERIAL, COMMIT_STYLES.LIFT_INTO_TRAY]),
    customerContext: Object.freeze({ tableNumber: false, serviceMode: false, passenger: false }),
    persistentTray: true,
  }),
  HOSPITALITY: Object.freeze({
    navigationModes: Object.freeze(['CONTEXTUAL', 'FLOOR_TRAVERSE']),
    detailPresentations: Object.freeze(['MORPH', 'ROOM_DOSSIER']),
    commitStyles: Object.freeze([COMMIT_STYLES.MATERIAL]),
    customerContext: Object.freeze({ tableNumber: false, serviceMode: false, passenger: false }),
    persistentTray: false,
  }),
  LOGISTICS: Object.freeze({
    navigationModes: Object.freeze(['CONTEXTUAL', 'JOURNEY_TIMELINE']),
    detailPresentations: Object.freeze(['MORPH', 'SEAT_DOSSIER']),
    commitStyles: Object.freeze([COMMIT_STYLES.MATERIAL]),
    customerContext: Object.freeze({ tableNumber: false, serviceMode: false, passenger: true }),
    persistentTray: false,
  }),
  DEFAULT: Object.freeze({
    navigationModes: Object.freeze(['CONTEXTUAL']),
    detailPresentations: Object.freeze(['MORPH', 'SERVICE_DOSSIER']),
    commitStyles: Object.freeze([COMMIT_STYLES.MATERIAL]),
    customerContext: Object.freeze({ tableNumber: false, serviceMode: false, passenger: false }),
    persistentTray: false,
  }),
});

function categoryKey(category) {
  return String(category || '').trim().toUpperCase();
}

function categoryOptions(category) {
  return CATEGORY_OPTIONS[categoryKey(category)] || CATEGORY_OPTIONS.DEFAULT;
}

function presetForCategory(category) {
  switch (categoryKey(category)) {
    case 'FOOD_BEVERAGE': return PRESETS.DINING_JOURNEY;
    case 'RETAIL': return PRESETS.SHOP_FLOOR;
    case 'HOSPITALITY': return PRESETS.BUILDING_WALK;
    case 'LOGISTICS': return PRESETS.TRAVEL_JOURNEY;
    default: return PRESETS.SERVICE_JOURNEY;
  }
}

function defaultsForCategory(category) {
  const key = categoryKey(category);
  const options = categoryOptions(key);
  const base = {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset: presetForCategory(key),
    navigation: {
      mode: options.navigationModes[0],
      showProgress: true,
      allowDirectJump: false,
    },
    detail: {
      presentation: options.detailPresentations[options.detailPresentations.length - 1],
      showGallery: true,
      showSpecifications: true,
      showOptions: true,
      showQuantity: true,
    },
    customerContext: {
      enabled: true,
      tableNumber: options.customerContext.tableNumber,
      serviceMode: options.customerContext.serviceMode,
      passenger: options.customerContext.passenger,
    },
    commit: {
      style: options.commitStyles[0],
      persistentTray: options.persistentTray,
    },
    motion: { tempo: 'BALANCED', reducedMotionSafe: true },
  };

  if (key === 'FOOD_BEVERAGE') {
    base.detail.presentation = 'DISH_DOSSIER';
    base.commit.style = COMMIT_STYLES.PAPER_RIP;
  } else if (key === 'HOSPITALITY') {
    base.navigation.mode = 'FLOOR_TRAVERSE';
    base.detail.presentation = 'ROOM_DOSSIER';
  } else if (key === 'RETAIL') {
    base.navigation.mode = 'AISLE_TRAVERSE';
    base.detail.presentation = 'PRODUCT_DOSSIER';
    base.commit.style = COMMIT_STYLES.LIFT_INTO_TRAY;
  } else if (key === 'LOGISTICS') {
    base.navigation.mode = 'JOURNEY_TIMELINE';
    base.detail.presentation = 'SEAT_DOSSIER';
  }

  return base;
}

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeExperienceBlueprint(input, category) {
  const key = categoryKey(category);
  const defaults = defaultsForCategory(key);
  const options = categoryOptions(key);
  const raw = asPlainObject(input);
  const preset = enumValue(raw.preset, [defaults.preset], defaults.preset);

  return {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset,
    navigation: {
      mode: enumValue(raw.navigation?.mode, options.navigationModes, defaults.navigation.mode),
      showProgress: bool(raw.navigation?.showProgress, defaults.navigation.showProgress),
      allowDirectJump: false,
    },
    detail: {
      presentation: enumValue(raw.detail?.presentation, options.detailPresentations, defaults.detail.presentation),
      showGallery: bool(raw.detail?.showGallery, defaults.detail.showGallery),
      showSpecifications: bool(raw.detail?.showSpecifications, defaults.detail.showSpecifications),
      showOptions: bool(raw.detail?.showOptions, defaults.detail.showOptions),
      showQuantity: bool(raw.detail?.showQuantity, defaults.detail.showQuantity),
    },
    customerContext: {
      enabled: bool(raw.customerContext?.enabled, defaults.customerContext.enabled),
      tableNumber: options.customerContext.tableNumber
        ? bool(raw.customerContext?.tableNumber, defaults.customerContext.tableNumber)
        : false,
      serviceMode: options.customerContext.serviceMode
        ? bool(raw.customerContext?.serviceMode, defaults.customerContext.serviceMode)
        : false,
      passenger: options.customerContext.passenger
        ? bool(raw.customerContext?.passenger, defaults.customerContext.passenger)
        : false,
    },
    commit: {
      style: enumValue(raw.commit?.style, options.commitStyles, defaults.commit.style),
      persistentTray: options.persistentTray
        ? bool(raw.commit?.persistentTray, defaults.commit.persistentTray)
        : false,
    },
    motion: {
      tempo: enumValue(raw.motion?.tempo, MOTION_TEMPOS, defaults.motion.tempo),
      reducedMotionSafe: true,
    },
  };
}

function getStoredBlueprint(businessMeta) {
  return asPlainObject(businessMeta).experienceBlueprint || null;
}

function getExperienceBlueprint(business) {
  const defaults = defaultsForCategory(business?.category);
  const stored = getStoredBlueprint(business?.businessMeta);
  return stored ? normalizeExperienceBlueprint(stored, business?.category) : defaults;
}

async function saveExperienceBlueprint(prisma, businessProfileId, blueprint) {
  const business = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { category: true, businessMeta: true },
  });
  if (!business) {
    const error = new Error('Business profile not found.');
    error.statusCode = 404;
    throw error;
  }

  const normalized = normalizeExperienceBlueprint(blueprint, business.category);
  const meta = asPlainObject(business.businessMeta);
  const updated = await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { businessMeta: { ...meta, experienceBlueprint: normalized } },
    select: { id: true, category: true, businessMeta: true },
  });

  return getExperienceBlueprint(updated);
}

module.exports = {
  EXPERIENCE_BLUEPRINT_VERSION,
  PRESETS,
  NAVIGATION_MODES,
  DETAIL_PRESENTATIONS,
  MOTION_TEMPOS,
  COMMIT_STYLES,
  CATEGORY_OPTIONS,
  categoryOptions,
  presetForCategory,
  defaultsForCategory,
  normalizeExperienceBlueprint,
  getExperienceBlueprint,
  saveExperienceBlueprint,
};