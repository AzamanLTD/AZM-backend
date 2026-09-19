'use strict';

// =============================================================================
// §P.5-C — versioned deterministic deposit route policy.
//
// SINGLE SOURCE OF TRUTH for the mounted deposit routes. Every route/rail here
// is derived from the ACTUALLY MOUNTED controllers (routes/depositRoutes.js):
//
//   • GENERIC_FIAT_AGGREGATOR — controllers/quoteFiatDepositController.js
//     POST /api/deposit/fiat/initiate → POST /api/deposit/fiat/webhook
//     MoMo rails may additionally be OTP-confirmed through the Moolre
//     collection service (POST /api/deposit/fiat/initiate/moolre/otp) and
//     then settle on the Moolre HMAC webhook.
//
//   • MOOLRE_MOMO_COLLECTION — controllers/moolreQuoteDepositController.js
//     POST /api/deposit/fiat/initiate/moolre → POST /api/deposit/fiat/webhook/moolre
//
// NO automatic route optimizer exists; selection is deterministic — the
// mounted initiation endpoint selects the route and the request's provider
// selects the rail. Kotani Model A on-ramp is NOT implemented: it exposes an
// off-ramp/rate surface only and is deliberately ABSENT from the candidate
// set. No provider/rail may be invented outside this policy.
// =============================================================================

const ROUTE_POLICY_VERSION = 'route-policy@1';

const MOMO_RAILS = ['MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH', 'AIRTELTIGO'];

// Rail-aware settlement contract (per route, per rail):
//   GENERIC + BANK_TRANSFER -> generic fiat webhook ONLY
//   GENERIC + MoMo rail     -> generic webhook OR the legitimate Moolre OTP path
//   MOOLRE  + MoMo rail     -> Moolre webhook ONLY (never the generic webhook)
const DEPOSIT_ROUTES = {
  GENERIC_FIAT_AGGREGATOR: {
    route: 'GENERIC_FIAT_AGGREGATOR',
    initiationEndpoint: 'POST /api/deposit/fiat/initiate',
    rails: [...MOMO_RAILS, 'BANK_TRANSFER'],
    settlementSurfaces: { BANK_TRANSFER: ['GENERIC_FIAT_WEBHOOK'], MOMO: ['GENERIC_FIAT_WEBHOOK', 'MOOLRE_WEBHOOK'] },
  },
  MOOLRE_MOMO_COLLECTION: {
    route: 'MOOLRE_MOMO_COLLECTION',
    initiationEndpoint: 'POST /api/deposit/fiat/initiate/moolre',
    rails: [...MOMO_RAILS],
    settlementSurfaces: { MOMO: ['MOOLRE_WEBHOOK'] },
  },
};

const SETTLEMENT_SURFACES = {
  GENERIC_FIAT_WEBHOOK: 'POST /api/deposit/fiat/webhook (x-azaman-webhook-secret)',
  MOOLRE_WEBHOOK: 'POST /api/deposit/fiat/webhook/moolre (x-moolre-signature HMAC)',
};

class RoutePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutePolicyError';
    this.code = code;
    this.statusCode = 409;
  }
}

function depositRouteCandidates() {
  return Object.values(DEPOSIT_ROUTES).map(({ route, rails, initiationEndpoint }) => ({
    route, rails, initiationEndpoint,
  }));
}

// Deterministic route resolution for a mounted initiation endpoint.
function resolveDepositRoute({ route, provider } = {}) {
  if (!route || !DEPOSIT_ROUTES[route]) {
    throw new RoutePolicyError('ROUTE_UNKNOWN', `Unknown deposit route "${route}"`);
  }
  const definition = DEPOSIT_ROUTES[route];
  if (!definition.rails.includes(provider)) {
    throw new RoutePolicyError('ROUTE_RAIL_UNSUPPORTED', `Provider/rail "${provider}" is not mounted on route ${route}`);
  }
  return {
    selectedRoute: definition.route,
    routeProviderRail: provider,
    routePolicyVersion: ROUTE_POLICY_VERSION,
    routeCandidates: depositRouteCandidates(),
    selectionProvenance: 'MOUNTED_INITIATION_ENDPOINT',
  };
}

// Unbound price-quote context for the generic /api/quotes surface: the
// persisted candidate set + policy version, but NO selected route — an honest
// unbound quote never claims a route decision it did not make.
function priceQuoteRouteContext() {
  return {
    selectedRoute: null,
    routeProviderRail: null,
    routePolicyVersion: ROUTE_POLICY_VERSION,
    routeCandidates: depositRouteCandidates(),
    selectionProvenance: 'UNBOUND_PRICE_QUOTE',
  };
}

// RAIL-AWARE settlement binding: BOTH the quoted route AND the quoted rail
// must be legal for the authenticated settlement surface — checked before
// any mutation. A quote with no selectedRoute is a historical/pre-§P.5-C
// quote — settlement proceeds without inventing missing route data
// (fail-closed only on contradictions).
function assertSettlementRouteAllowed({ quote, settlementSurface } = {}) {
  if (!SETTLEMENT_SURFACES[settlementSurface]) {
    throw new RoutePolicyError('SETTLEMENT_SURFACE_UNKNOWN', `Unknown settlement surface "${settlementSurface}"`);
  }
  const selectedRoute = quote?.selectedRoute || null;
  if (!selectedRoute) return true;
  const definition = DEPOSIT_ROUTES[selectedRoute];
  if (!definition) {
    throw new RoutePolicyError('ROUTE_UNKNOWN', `Quoted route "${selectedRoute}" is not a mounted route`);
  }
  const rail = quote?.routeProviderRail || null;
  if (rail && !definition.rails.includes(rail)) {
    throw new RoutePolicyError('ROUTE_RAIL_UNSUPPORTED',
      `Quoted rail "${rail}" is not mounted on route ${selectedRoute}`);
  }
  // Rail class: every MoMo rail shares one settlement contract.
  const railClass = rail ? (MOMO_RAILS.includes(rail) ? 'MOMO' : rail) : null;
  const allowed = railClass
    ? (definition.settlementSurfaces[railClass] || [])
    : Object.values(definition.settlementSurfaces).flat(); // route-only (legacy) quotes: the route's union
  if (!allowed.includes(settlementSurface)) {
    throw new RoutePolicyError('ROUTE_SETTLEMENT_MISMATCH',
      `Quote route ${selectedRoute} (rail ${rail || 'unspecified'}) cannot settle on ${settlementSurface}`);
  }
  return true;
}

module.exports = {
  ROUTE_POLICY_VERSION,
  DEPOSIT_ROUTES,
  SETTLEMENT_SURFACES,
  depositRouteCandidates,
  resolveDepositRoute,
  priceQuoteRouteContext,
  assertSettlementRouteAllowed,
  RoutePolicyError,
};
