'use strict';

// =============================================================================
// AZAMAN — STOREFRONT STUDIO V2 SERVER VALIDATOR
//
// The browser editor is not a trust boundary. This validator protects the
// publish/runtime boundary by constraining the semantic document to known
// nodes, bounded structure, safe actions and finite layout/style data.
// =============================================================================

const { STOREFRONT_ACTION_TYPES, validateStorefrontAction } = require('../src/lib/storefrontStudioActions');
