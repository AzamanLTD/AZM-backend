'use strict';

function hasOwnExperience(layoutJson) {
  return Boolean(
    layoutJson &&
    typeof layoutJson === 'object' &&
    Object.prototype.hasOwnProperty.call(layoutJson, 'experience'),
  );
}

/**
 * Preserve the authoritative draft Experience Blueprint when a legacy or
 * partial layout save omits it. Explicit values, including null, are always
 * authoritative and are never overwritten by the previous snapshot.
 */
function preserveDraftExperience(layoutJson, currentDraftLayout) {
  const incoming = layoutJson && typeof layoutJson === 'object'
    ? { ...layoutJson }
    : {};

  if (!hasOwnExperience(incoming) && hasOwnExperience(currentDraftLayout)) {
    incoming.experience = currentDraftLayout.experience;
  }

  return incoming;
}

module.exports = {
  hasOwnExperience,
  preserveDraftExperience,
};
