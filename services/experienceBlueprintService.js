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
const COMMIT_STYLES = Object.freeze(['MATERIAL', 'PAPER_RIP', 'LIFT_INTO_TRAY']);

function categoryKey(category) {
  return String(category || '').toUpperCase();
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
  const base = {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset: presetForCategory(key),
    navigation: {
      mode: 'CONTEXTUAL',
      showProgress: true,
      allowDirectJump: false,
    },
    detail: {
      presentation: 'MORPH',
      showGallery: true,
      showSpecifications: true,
      showOptions: true,
      showQuantity: true,
    },
    customerContext: { enabled: true },
    commit: { style: COMMIT_STYLES.MATERIAL, persistentTray: true },
    motion: { tempo: 'BALANCED', reducedMotionSafe: true },
  };

  if (key === 'FOOD_BEVERAGE') {
    base.detail.presentation = 'DISH_DOSSIER';
    base.customerContext = { enabled: true, tableNumber: true, serviceMode: true };
    base.commit.style = COMMIT_STYLES.PAPER_RIP;
  } else if (key === 'HOSPITALITY') {
    base.navigation.mode = 'FLOOR_TRAVERSE';
    base.detail.presentation = 'ROOM_DOSSIER';
    base.commit.style = COMMIT_STYLES.LIFT_INTO_TRAY;
  } else if (key === 'RETAIL') {
    base.navigation.mode = 'AISLE_TRAVERSE';
    base.detail.presentation = 'PRODUCT_DOSSIER';
    base.commit.style = COMMIT_STYLES.LIFT_INTO_TRAY;
  } else if (key === 'LOGISTICS') {
    base.navigation.mode = 'JOURNEY_TIMELINE';
    base.detail.presentation = 'SEAT_DOSSIER';
    base.customerContext = { enabled: true, passenger: true };
  } else {
    base.detail.presentation = 'SERVICE_DOSSIER';
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
  const defaults = defaultsForCategory(category);
  const raw = asPlainObject(input);
  const preset = enumValue(raw.preset, [defaults.preset], defaults.preset);

  return {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset,
    navigation: {
      mode: enumValue(raw.navigation?.mode, NAVIGATION_MODES, defaults.navigation.mode),
      showProgress: bool(raw.navigation?.showProgress, defaults.navigation.showProgress),
      // Direct jumping remains platform-controlled until a later information
      // architecture proves it helps the specific journey.
      allowDirectJump: false,
    },
    detail: {
      presentation: enumValue(raw.detail?.presentation, DETAIL_PRESENTATIONS, defaults.detail.presentation),
      showGallery: bool(raw.detail?.showGallery, defaults.detail.showGallery),
      showSpecifications: bool(raw.detail?.showSpecifications, defaults.detail.showSpecifications),
      showOptions: bool(raw.detail?.showOptions, defaults.detail.showOptions),
      showQuantity: bool(raw.detail?.showQuantity, defaults.detail.showQuantity),
    },
    customerContext: {
      enabled: bool(raw.customerContext?.enabled, defaults.customerContext.enabled),
      tableNumber: bool(raw.customerContext?.tableNumber, defaults.customerContext.tableNumber === true),
      serviceMode: bool(raw.customerContext?.serviceMode, defaults.customerContext.serviceMode === true),
      passenger: bool(raw.customerContext?.passenger, defaults.customerContext.passenger === true),
    },
    commit: {
      style: enumValue(raw.commit?.style, COMMIT_STYLES, defaults.commit.style),
      persistentTray: bool(raw.commit?.persistentTray, defaults.commit.persistentTray),
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
  presetForCategory,
  defaultsForCategory,
  normalizeExperienceBlueprint,
  getExperienceBlueprint,
  saveExperienceBlueprint,
};
