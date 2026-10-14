'use strict';
// =============================================================================
// MARKETPLACE MIX P1 — public cross-business item discovery routes.
//
// Authority: docs/MARKETPLACE_MIX_REDESIGN_2026-10-10.md §3.1.
//
// ROUTE CONTRACT: the approved plan specifies GET /api/discovery/items —
// this IS that endpoint (category, item query q, taxonomy, location filters,
// stable cursor pagination). The exploratory `/api/marketplace/mix/offers`
// sketch from the frontend PR #153 description is NOT implemented: the
// approved contract route wins, and no second parallel discovery API is
// introduced.
//
// Feature flag (P1 rollout: "backend discovery API … feature-flagged, no
// UI"): AZM_MARKETPLACE_DISCOVERY_ENABLED. Disabled by default — the route
// responds 404 (the surface is hidden, not advertised) until the owner
// flips the flag. The flag is read per-request, so runtime config tools
// and tests can toggle it without a process restart.
//
// Public, unauthenticated by contract (it must be browsable pre-login, like
// business search), rate-limited by the general limiter. Mutations: none —
// this surface is read-only.
// =============================================================================

const express = require('express');
const logger = require('../src/config/logger');
const discoveryService = require('../services/marketplace/discoveryService');

const router = express.Router();

function discoveryEnabled() {
    return String(process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED || '').toLowerCase() === 'true';
}

router.get('/items', async (req, res) => {
    if (!discoveryEnabled()) {
        // Feature-flagged off: indistinguishable from an unknown route.
        return res.status(404).json({ success: false, message: 'Not found' });
    }
    const prisma = req.app.get('prisma');
    try {
        const result = await discoveryService.searchDiscoveryItems(prisma, req.query);
        return res.status(200).json({
            success: true,
            items: result.items,
            nextCursor: result.nextCursor,
            cache: result.cache,
        });
    } catch (err) {
        if (err instanceof discoveryService.DiscoveryParamError) {
            return res.status(422).json({
                success: false,
                message: err.message,
                field: err.field,
            });
        }
        logger.error({ err: err }, '[discovery/items] error');
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

module.exports = router;
