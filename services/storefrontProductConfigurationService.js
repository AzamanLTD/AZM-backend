'use strict';

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionLabel(option) {
  if (option && typeof option === 'object') {
    return String(option.name ?? option.label ?? option.value ?? '').trim();
  }
  return String(option ?? '').trim();
}

function normalizedOptionList(options) {
  if (!Array.isArray(options)) return [];
  return options.map(option => ({
    id: option && typeof option === 'object' ? String(option.id ?? option.value ?? option.name ?? '') : optionLabel(option),
    name: optionLabel(option),
    priceDelta: numeric(option && typeof option === 'object' ? option.priceDelta : 0),
  })).filter(option => option.name);
}

function normalizeSelectionValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (value == null) return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function selectionNames(selected) {
  return normalizeSelectionValue(selected);
}

function validateConfiguredProduct(product, selected) {
  const selection = selected == null ? {} : selected;
  if (!selection || Array.isArray(selection) || typeof selection !== 'object') {
    return { error: 'variants must be an object keyed by option group.' };
  }

  const variants = Array.isArray(product.variants) ? normalizedOptionList(product.variants) : [];
  const groups = Array.isArray(product.modifierGroups) ? product.modifierGroups : [];
  const allowedKeys = new Set(['size', 'variant', ...variants.map(option => option.name)]);

  for (const key of Object.keys(selection)) {
    if (key !== 'size' && key !== 'variant' && !groups.some(group => String(group?.name ?? '').trim() === key)) {
      return { error: `Unknown product option group: ${key}.` };
    }
  }

  const sizeSelection = selection.size ?? selection.variant;
  if (variants.length > 0) {
    const chosen = selectionNames(sizeSelection);
    if (chosen.length !== 1) return { error: 'A product size must be selected.' };
    if (!variants.some(option => option.name === chosen[0])) return { error: `Invalid product size: ${chosen[0]}.` };
  }

  for (const group of groups) {
    const name = String(group?.name ?? '').trim();
    if (!name) continue;
    const options = normalizedOptionList(group?.options);
    const chosen = selectionNames(selection[name]);
    const maxSelection = Math.max(1, Math.floor(numeric(group?.maxSelection ?? group?.max ?? 1)));
    if (group?.required && chosen.length === 0) return { error: `Required option ${name} must be selected.` };
    if (chosen.length > maxSelection) return { error: `Option group ${name} allows at most ${maxSelection} selections.` };
    for (const selectedName of chosen) {
      if (options.length > 0 && !options.some(option => option.name === selectedName)) return { error: `Invalid option for ${name}: ${selectedName}.` };
    }
  }

  return { error: null };
}

function configuredUnitPrice(product, selected) {
  const base = numeric(product.priceUsdc);
  const selection = selected && typeof selected === 'object' ? selected : {};
  let total = base;

  const variants = normalizedOptionList(product.variants);
  const variantName = selectionNames(selection.size ?? selection.variant)[0];
  if (variantName) {
    const variant = variants.find(option => option.name === variantName);
    if (variant) total += variant.priceDelta;
  }

  for (const group of Array.isArray(product.modifierGroups) ? product.modifierGroups : []) {
    const name = String(group?.name ?? '').trim();
    if (!name) continue;
    const chosen = new Set(selectionNames(selection[name]));
    for (const option of normalizedOptionList(group?.options)) {
      if (chosen.has(option.name)) total += option.priceDelta;
    }
  }

  return Number(total.toFixed(6));
}

function normalizedSelection(product, selected) {
  const input = selected && typeof selected === 'object' ? selected : {};
  const result = {};
  const variantName = selectionNames(input.size ?? input.variant)[0];
  if (variantName) result.size = variantName;
  for (const group of Array.isArray(product.modifierGroups) ? product.modifierGroups : []) {
    const name = String(group?.name ?? '').trim();
    if (!name) continue;
    const chosen = selectionNames(input[name]);
    if (chosen.length) result[name] = [...new Set(chosen)].sort();
  }
  return result;
}

module.exports = {
  validateConfiguredProduct,
  configuredUnitPrice,
  normalizedSelection,
};