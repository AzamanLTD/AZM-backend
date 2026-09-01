'use strict';

// =============================================================================
// AZAMAN — EXPERIENCE BLUEPRINT
//
// The blueprint describes how the marketplace experience should behave without
// becoming an arbitrary page builder. Domain data remains authoritative in the
// existing catalog / hotel / transit / reservation models. This object only
// configures the safe interaction grammar, contextual affordances and motion
// personality exposed to the customer.
// =============================================================================

const EXPERIENCE_BLUEPRINT_VERSION = 1;

const PRESETS = Object.freeze({
  DINING_JOURNEY: 'DINING_JOURNEY',
  SHOP_FLOOR: 'SHOP_FLOOR',
  BUILDING_WALK: 'BUILDING_WALK',
  TRAVEL_JOURNEY: 'TRAVEL_JOURNEY',
  SERVICE_JOURNEY: 'SERVICE_JOURNEY',
});

const MOTION_TEMPOS = Object.freeze(['RELAXED', 'BALANCED', 'QUICK']);
const COMMIT_STYLES = Object.freeze(['MATERIAL', 'PAPER_RIP', 'LIFT_INTO_TRAY']);

function categoryKey(category) {
  return String(category || '').toUpperCase();
}

function presetForCategory(category) {
  switch (categoryKey(category)) {
    case 'FOOD_BEVERAGE':
      return PRESETS.DINING_JOURNEY;
    case 'RETAIL':
      return PRESETS.SHOP_FLOOR;
    case 'HOSPITALITY':
      return PRESETS.BUILDING_WALK;
    case 'LOGISTICS':
      return PRESETS.TRAVEL_JOURNEY;
    default:
      return PRESETS.SERVICE_JOURNEY;
  }
}

function defaultsForCategory(category) {
  const key = categoryKey(category);
  const preset = presetForCategory(key);

  const base = {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset,
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
    customerContext: {
      enabled: true,
    },
    commit: {
      style: COMMIT_STYLES.MATERIAL,
      persistentTray: true,
    },
    motion: {
      tempo: 'BALANCED',
      reducedMotionSafe: true,
    },
  };

  if (key === 'FOOD_BEVERAGE') {
    base.detail.presentation = 'DISH_DOSSIER';
    base.customerContext = {
      enabled: true,
      tableNumber: true,
      serviceMode: true,
    };
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
    base.commit.style = COMMIT_STYLES.MATERIAL;
    base.customerContext = {
      enabled: true,
      passenger: true,
    };
  } else {
    base.detail.presentation = 'SERVICE_DOSSIER';
  }

  return base;
}

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return {};
    }
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

  const requestedPreset = enumValue(raw.preset, Object.values(PRESETS), defaults.preset);
  const preset = requestedPreset === defaults.preset ? requestedPreset : defaults.preset;

  return {
    schemaVersion: EXPERIENCE_BLUEPRINT_VERSION,
    preset,
    navigation: {
      mode: typeof raw.navigation?.mode === 'string'
        ? raw.navigation.mode
        : defaults.navigation.mode,
      showProgress: bool(raw.navigation?.showProgress, defaults.navigation.showProgress),
      allowDirectJump: bool(raw.navigation?.allowDirectJump, defaults.navigation.allowDirectJump),
    },
    detail: {
      presentation: typeof raw.detail?.presentation === 'string'
        ? raw.detail.presentation
        : defaults.detail.presentation,
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
      // This cannot be switched off by the business: every preset has an
      // accessibility-safe non-motion fallback owned by the platform.
      reducedMotionSafe: true,
    },
  };
}

function getStoredBlueprint(businessMeta) {
  const meta = asPlainObject(businessMeta);
  return meta.experienceBlueprint || null;
}

function getExperienceBlueprint(business) {
  const category = business?.category;
  const defaults = defaultsForCategory(category);
  const stored = getStoredBlueprint(business?.businessMeta);
  return stored ? normalizeExperienceBlueprint(stored, category) : defaults;
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
  const nextMeta = {
    ...meta,
    experienceBlueprint: normalized,
  };

  const updated = await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { businessMeta: nextMeta },
    select: { id: true, category: true, businessMeta: true },
  });

  return getExperienceBlueprint(updated);
}

module.exports = {
  EXPERIENCE_BLUEPRINT_VERSION,
  PRESETS,
  MOTION_TEMPOS,
  COMMIT_STYLES,
  presetForCategory,
  defaultsForCategory,
  normalizeExperienceBlueprint,
  getExperienceBlueprint,
  saveExperienceBlueprint,
};
