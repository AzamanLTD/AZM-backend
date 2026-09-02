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

function normalizeVariantGroups(raw) {
  if (Array.isArray(raw)) {
    return raw.map(group => ({
      name: String(group?.name ?? group?.id ?? '').trim(),
      required: group?.required !== false,
      options: normalizedOptionList(group?.options ?? group?.values),
    })).filter(group => group.name);
  }
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([name, values]) => ({
    name: String(name).trim(),
    required: true,
    options: normalizedOptionList(values),
  })).filter(group => group.name);
}

function normalizeModifierGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(group => ({
    name: String(group?.name ?? group?.id ?? '').trim(),
    required: group?.required === true,
    maxSelection: Math.max(1, Math.floor(numeric(group?.maxSelection ?? group?.max ?? 1))),
    options: normalizedOptionList(group?.options ?? group?.values),
  })).filter(group => group.name);
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

  const variants = normalizeVariantGroups(product.variants);
  const groups = normalizeModifierGroups(product.modifierGroups);
  const variantNames = new Set(variants.map(group => group.name));
  const modifierNames = new Set(groups.map(group => group.name));

  for (const key of Object.keys(selection)) {
    if (!variantNames.has(key) && key !== 'size' && key !== 'variant' && !modifierNames.has(key)) {
      return { error: `Unknown product option group: ${key}.` };
    }
  }

  for (const group of variants) {
    const chosen = selectionNames(selection[group.name] ?? (group.name.toLowerCase() === 'size' ? selection.size : selection.variant));
    if (group.required && chosen.length !== 1) return { error: `Variant option ${group.name} must be selected.` };
    if (!group.required && chosen.length === 0) continue;
    if (chosen.length > 1) return { error: `Variant option ${group.name} allows one selection.` };
    if (chosen.length && group.options.length > 0 && !group.options.some(option => option.name === chosen[0])) {
      return { error: `Invalid value for variant option ${group.name}.` };
    }
  }

  for (const group of groups) {
    const chosen = selectionNames(selection[group.name]);
    if (group.required && chosen.length === 0) return { error: `Required option ${group.name} must be selected.` };
    if (chosen.length > group.maxSelection) return { error: `Option group ${group.name} allows at most ${group.maxSelection} selections.` };
    for (const selectedName of chosen) {
      if (group.options.length > 0 && !group.options.some(option => option.name === selectedName)) return { error: `Invalid option for ${group.name}: ${selectedName}.` };
    }
  }

  return { error: null };
}

function configuredUnitPrice(product, selected) {
  const base = numeric(product.priceUsdc);
  const selection = selected && typeof selected === 'object' ? selected : {};
  let total = base;

  for (const group of normalizeVariantGroups(product.variants)) {
    const chosen = selectionNames(selection[group.name] ?? (group.name.toLowerCase() === 'size' ? selection.size : selection.variant));
    if (!chosen.length) continue;
    const option = group.options.find(candidate => candidate.name === chosen[0]);
    if (option) total += option.priceDelta;
  }

  for (const group of normalizeModifierGroups(product.modifierGroups)) {
    const chosen = new Set(selectionNames(selection[group.name]));
    for (const option of group.options) {
      if (chosen.has(option.name)) total += option.priceDelta;
    }
  }

  return Number(total.toFixed(6));
}

function normalizedSelection(product, selected) {
  const input = selected && typeof selected === 'object' ? selected : {};
  const result = {};
  for (const group of normalizeVariantGroups(product.variants)) {
    const chosen = selectionNames(input[group.name] ?? (group.name.toLowerCase() === 'size' ? input.size : input.variant));
    if (chosen.length) result[group.name.toLowerCase() === 'size' ? 'size' : group.name] = chosen[0];
  }
  for (const group of normalizeModifierGroups(product.modifierGroups)) {
    const chosen = [...new Set(selectionNames(input[group.name]))].sort();
    if (chosen.length) result[group.name] = chosen;
  }
  return result;
}

module.exports = {
  validateConfiguredProduct,
  configuredUnitPrice,
  normalizedSelection,
};
