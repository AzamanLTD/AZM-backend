'use strict';

const { z } = require('zod');

// ── layoutJson schema ──
const tilePositionSchema = z.object({
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  rowSpan: z.number().int().min(1).max(6),
  colSpan: z.number().int().min(1).max(4),
});

const tileSchema = z.object({
  id: z.string().regex(/^tile_[a-z0-9]{4,16}$/),
  widgetType: z.string().min(1),
  position: tilePositionSchema,
  props: z.record(z.any()).default({}),
});

const layoutJsonSchema = z.object({
  schemaVersion: z.number().int().min(1).max(1),
  gridColumns: z.literal(4),
  tiles: z.array(tileSchema),
});

// ── API request schemas ──
const saveDraftSchema = z.object({
  layoutJson: layoutJsonSchema,
  themeId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(),
});

const applyTemplateSchema = z.object({
  templateId: z.string().uuid(),
});

const revertSchema = z.object({
  versionId: z.string().uuid(),
});

const createStakeSchema = z.object({
  amountAzm: z.number().positive(),
});

const unstakeSchema = z.object({
  stakeId: z.string().uuid(),
});

// ── Token set schema for themes ──
const tokenSetSchema = z.object({
  background: z.string().optional(),
  surface: z.string().optional(),
  surfaceSolid: z.string().optional(),
  border: z.string().optional(),
  textPrimary: z.string().optional(),
  textSecondary: z.string().optional(),
  textMuted: z.string().optional(),
  accent: z.string(),
  accentHover: z.string().optional(),
  success: z.string().optional(),
  warning: z.string().optional(),
  danger: z.string().optional(),
  info: z.string().optional(),
});

module.exports = {
  layoutJsonSchema,
  tileSchema,
  tilePositionSchema,
  saveDraftSchema,
  applyTemplateSchema,
  revertSchema,
  createStakeSchema,
  unstakeSchema,
  tokenSetSchema,
};
