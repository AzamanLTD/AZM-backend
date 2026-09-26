'use strict';

/**
 * Storefront Schema Migration Service
 * Handles layoutJson version upgrades for backward compatibility.
 * Currently only schemaVersion 1 exists, but this provides the framework.
 */

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Migrate a layoutJson to the current schema version.
 * @param {object} layoutJson - The layout JSON to migrate
 * @returns {object} - Migrated layout JSON
 */
function migrateLayout(layoutJson) {
  if (!layoutJson || typeof layoutJson !== 'object') {
    return generateEmptyLayout();
  }

  let version = layoutJson.schemaVersion || 1;
  let migrated = { ...layoutJson };

  // Future migrations would go here:
  // if (version < 2) { migrated = migrateV1toV2(migrated); version = 2; }

  // Ensure schemaVersion is set
  migrated.schemaVersion = CURRENT_SCHEMA_VERSION;
  migrated.gridColumns = 4;

  // Ensure tiles array exists
  if (!Array.isArray(migrated.tiles)) {
    migrated.tiles = [];
  }

  // Validate each tile has required fields
  migrated.tiles = migrated.tiles.map(tile => ({
    id: tile.id || `tile_${Math.random().toString(36).substring(2, 10)}`,
    widgetType: tile.widgetType || 'unknown',
    position: {
      row: tile.position?.row || 0,
      col: tile.position?.col || 0,
      rowSpan: Math.min(6, Math.max(1, tile.position?.rowSpan || 2)),
      colSpan: Math.min(4, Math.max(1, tile.position?.colSpan || 4)),
    },
    props: tile.props || {},
  }));

  return migrated;
}

/**
 * Generate an empty layout for a new business.
 */
function generateEmptyLayout() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    gridColumns: 4,
    tiles: [],
  };
}

module.exports = {
  migrateLayout,
  generateEmptyLayout,
  CURRENT_SCHEMA_VERSION,
};
