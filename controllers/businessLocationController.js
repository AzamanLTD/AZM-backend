// controllers/businessLocationController.js
// =============================================================================
// AZAMAN — BUSINESS LOCATION CONTROLLER (Discovery Sprint, 2026-06-20)
//
// Thin HTTP layer over businessLocationService. Mirrors businessProductController
// conventions: prisma = req.app.get('prisma'); ownership via _ownedProfile.
// P2002 (duplicate table label) is surfaced as a 409.
// =============================================================================
'use strict';
const logger = require('../src/config/logger');
const locationSvc = require('../services/businessLocationService');

// Shared ownership check — load the BusinessProfile owned by the caller.
const _ownedProfile = async (prisma, userId) => {
  const profile = await prisma.businessProfile.findUnique({ where: { userId } });
  if (!profile) throw Object.assign(new Error('No business profile found.'), { status: 404 });
  if (profile.isSuspended) {
    throw Object.assign(
      new Error('Your business account is suspended. Contact support.'),
      { status: 403 }
    );
  }
  return profile;
};

const _err = (res, err) => {
  const status = err.status || (err.message?.includes("not found") ? 404 : 400);
  return res.status(status).json({ success: false, message: err.message });
};

// POST /api/business/locations
exports.createLocation = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const location = await locationSvc.createLocation(prisma, { businessProfileId: profile.id, ...req.body });
    return res.status(201).json({ success: true, location });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/locations
exports.listMyLocations = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const locations = await locationSvc.listMyLocations(prisma, { businessProfileId: profile.id });
    return res.json({ success: true, locations });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/:bizId/locations  (PUBLIC)
exports.getPublicLocations = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const biz = await prisma.businessProfile.findUnique({ where: { bizId: req.params.bizId } });
    if (!biz || biz.isSuspended) return res.status(404).json({ success: false, message: 'Business not found.' });
    const locations = await locationSvc.getPublicLocations(prisma, { businessProfileId: biz.id });
    return res.json({ success: true, locations });
  } catch (err) { return _err(res, err); }
};

// PATCH /api/business/locations/:locationId
exports.updateLocation = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const location = await locationSvc.updateLocation(prisma, {
      businessProfileId: profile.id, locationId: req.params.locationId, updates: req.body,
    });
    return res.json({ success: true, location });
  } catch (err) { return _err(res, err); }
};

// DELETE /api/business/locations/:locationId
exports.deleteLocation = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    await locationSvc.deleteLocation(prisma, { businessProfileId: profile.id, locationId: req.params.locationId });
    return res.json({ success: true });
  } catch (err) { return _err(res, err); }
};

// GET /api/business/search/nearby
exports.searchNearby = async (req, res) => {
  const prisma = req.app.get("prisma");
  const { lat, lng, radiusKm, category, q, verified, limit, page } = req.query;
  if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng are required.' });
  const latF = parseFloat(lat); const lngF = parseFloat(lng);
  if (isNaN(latF) || isNaN(lngF)) return res.status(400).json({ success: false, message: 'lat/lng must be valid numbers.' });
  try {
    const result = await locationSvc.searchNearby(prisma, {
      lat: latF, lng: lngF, radiusKm,
      category, q, verified: verified === "true",
      limit, page,
    });
    return res.json({ success: true, ...result });
  } catch (err) { return _err(res, err); }
};

// POST /api/business/locations/:locationId/tables
exports.createTable = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const table = await locationSvc.createTable(prisma, {
      businessProfileId: profile.id, locationId: req.params.locationId, label: req.body.label,
    });
    return res.status(201).json({ success: true, table });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ success: false, message: 'A table with this label already exists at this location.' });
    return _err(res, err);
  }
};

// GET /api/business/locations/:locationId/tables
exports.listTables = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    const tables = await locationSvc.listTables(prisma, { businessProfileId: profile.id, locationId: req.params.locationId });
    return res.json({ success: true, tables });
  } catch (err) { return _err(res, err); }
};

// DELETE /api/business/tables/:tableId
exports.deleteTable = async (req, res) => {
  const prisma = req.app.get("prisma");
  try {
    const profile = await _ownedProfile(prisma, req.user.id);
    await locationSvc.deleteTable(prisma, { businessProfileId: profile.id, tableId: req.params.tableId });
    return res.json({ success: true });
  } catch (err) { return _err(res, err); }
};
