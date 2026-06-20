// services/businessLocationService.js
// =============================================================================
// AZAMAN — BUSINESS LOCATION SERVICE (Discovery Sprint, 2026-06-20)
//
// Pure service layer. No req/res. All logic here; controllers are thin wrappers.
// Manages branch locations, dine-in tables, and the bounding-box "nearby"
// discovery search. Soft-delete only (isActive=false) — never destroys data.
// =============================================================================
'use strict';

const MAX_GALLERY_URLS = 10;
const MAX_LOCATIONS_PER_BUSINESS = 20;

// ── Create Location ──────────────────────────────────────────────────────────
const createLocation = async (prisma, { businessProfileId, label, address, city,
    region, country, latitude, longitude, phoneNumber, operatingHours,
    galleryUrls, isPrimary }) => {

  const lat = parseFloat(latitude); const lng = parseFloat(longitude);
  if (isNaN(lat) || lat < -90 || lat > 90) throw new Error("Invalid latitude.");
  if (isNaN(lng) || lng < -180 || lng > 180) throw new Error("Invalid longitude.");

  const count = await prisma.businessLocation.count({ where: { businessProfileId } });
  if (count >= MAX_LOCATIONS_PER_BUSINESS) throw new Error(`Max ${MAX_LOCATIONS_PER_BUSINESS} locations per business.`);

  const cleanGallery = Array.isArray(galleryUrls)
    ? galleryUrls.slice(0, MAX_GALLERY_URLS).map(u => String(u).trim()).filter(Boolean)
    : [];

  return prisma.$transaction(async (tx) => {
    // If isPrimary, demote any existing primary
    if (isPrimary) {
      await tx.businessLocation.updateMany({
        where: { businessProfileId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return tx.businessLocation.create({ data: {
      businessProfileId,
      label: String(label).trim().slice(0, 100),
      address: String(address).trim().slice(0, 255),
      city: city ? String(city).slice(0, 100) : null,
      region: region ? String(region).slice(0, 100) : null,
      country: country ? String(country).slice(0, 2) : null,
      latitude: lat,
      longitude: lng,
      phoneNumber: phoneNumber ? String(phoneNumber).slice(0, 20) : null,
      operatingHours: operatingHours || null,
      galleryUrls: cleanGallery.length ? cleanGallery : null,
      isPrimary: !!isPrimary,
    }});
  });
};

// ── List My Locations ────────────────────────────────────────────────────────
const listMyLocations = async (prisma, { businessProfileId }) => {
  return prisma.businessLocation.findMany({
    where: { businessProfileId },
    include: { tables: { where: { isActive: true }, orderBy: { label: "asc" } } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
};

// ── Get Public Locations (for a business page) ───────────────────────────────
const getPublicLocations = async (prisma, { businessProfileId }) => {
  return prisma.businessLocation.findMany({
    where: { businessProfileId, isActive: true },
    select: {
      id: true, label: true, address: true, city: true, region: true,
      country: true, latitude: true, longitude: true, phoneNumber: true,
      operatingHours: true, galleryUrls: true, isPrimary: true,
      tables: { where: { isActive: true }, select: { id: true, label: true } },
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
};

// ── Update Location ──────────────────────────────────────────────────────────
const UPDATABLE_LOCATION_FIELDS = new Set([
  'label','address','city','region','country','phoneNumber',
  'operatingHours','galleryUrls','isPrimary','isActive'
]);

const updateLocation = async (prisma, { businessProfileId, locationId, updates }) => {
  const location = await prisma.businessLocation.findFirst({
    where: { id: locationId, businessProfileId },
  });
  if (!location) throw new Error('Location not found or not owned by this business.');

  const data = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if (!UPDATABLE_LOCATION_FIELDS.has(key)) continue;
    if (key === 'galleryUrls') {
      data.galleryUrls = Array.isArray(value)
        ? value.slice(0, MAX_GALLERY_URLS).map(u => String(u).trim()).filter(Boolean)
        : null;
      continue;
    }
    data[key] = value;
  }
  if (Object.keys(data).length === 0) throw new Error("No valid fields to update.");

  return prisma.$transaction(async (tx) => {
    if (data.isPrimary === true) {
      await tx.businessLocation.updateMany({
        where: { businessProfileId, isPrimary: true, NOT: { id: locationId } },
        data: { isPrimary: false },
      });
    }
    return tx.businessLocation.update({ where: { id: locationId }, data });
  });
};

// ── Delete Location ──────────────────────────────────────────────────────────
const deleteLocation = async (prisma, { businessProfileId, locationId }) => {
  const loc = await prisma.businessLocation.findFirst({ where: { id: locationId, businessProfileId } });
  if (!loc) throw new Error('Location not found.');
  // Soft-delete: set isActive=false rather than destroying data
  return prisma.businessLocation.update({
    where: { id: locationId },
    data: { isActive: false },
  });
};

// ── Create Table ─────────────────────────────────────────────────────────────
const createTable = async (prisma, { businessProfileId, locationId, label }) => {
  const loc = await prisma.businessLocation.findFirst({
    where: { id: locationId, businessProfileId },
  });
  if (!loc) throw new Error('Location not found or not owned by this business.');
  const cleanLabel = String(label || "").trim().slice(0, 50);
  if (!cleanLabel) throw new Error("Table label is required.");
  // @@unique([locationId, label]) enforces no duplicates at DB level.
  // Catch P2002 in the controller and return a clear 409 message.
  return prisma.businessTable.create({ data: { locationId, label: cleanLabel } });
};

// ── List Tables ──────────────────────────────────────────────────────────────
const listTables = async (prisma, { businessProfileId, locationId }) => {
  const loc = await prisma.businessLocation.findFirst({ where: { id: locationId, businessProfileId } });
  if (!loc) throw new Error('Location not found.');
  return prisma.businessTable.findMany({
    where: { locationId, isActive: true },
    orderBy: { label: 'asc' },
  });
};

// ── Delete Table ─────────────────────────────────────────────────────────────
const deleteTable = async (prisma, { businessProfileId, tableId }) => {
  const table = await prisma.businessTable.findUnique({
    where: { id: tableId },
    include: { location: { select: { businessProfileId: true } } },
  });
  if (!table || table.location.businessProfileId !== businessProfileId) throw new Error('Table not found.');
  return prisma.businessTable.update({ where: { id: tableId }, data: { isActive: false } });
};

// ── Nearby Search ─────────────────────────────────────────────────────────────
// Bounding-box approximation: 1° lat ≈ 111km, 1° lng ≈ 111km × cos(lat).
// Returns locations within radiusKm, ordered by haversine distance asc.
const searchNearby = async (prisma, { lat, lng, radiusKm = 10, category, q, verified, limit, cursor }) => {
  const R = Math.min(parseFloat(radiusKm) || 10, 50);
  const latDelta = R / 111.0;
  const lngDelta = R / (111.0 * Math.cos((lat * Math.PI) / 180));
  const minLat = lat - latDelta; const maxLat = lat + latDelta;
  const minLng = lng - lngDelta; const maxLng = lng + lngDelta;
  const take = Math.min(parseInt(limit, 10) || 20, 50);

  const locationWhere = {
    isActive: true,
    latitude:  { gte: minLat, lte: maxLat },
    longitude: { gte: minLng, lte: maxLng },
    businessProfile: {
      isSuspended: false,
      ...(category ? { category } : {}),
      ...(verified ? { isVerified: true } : {}),
      ...(q ? { OR: [
        { businessName: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ]} : {}),
    },
  };

  const locations = await prisma.businessLocation.findMany({
    where: locationWhere,
    take: take + 1,
    include: {
      businessProfile: {
        select: { id: true, bizId: true, businessName: true, category: true,
          logoUrl: true, isVerified: true, averageRating: true, totalEscrows: true },
      },
    },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = locations.length > take;
  const items = locations.slice(0, take);

  // Compute actual haversine distance and sort ascending
  const withDist = items.map(loc => {
    const dLat = (Number(loc.latitude) - lat) * (Math.PI/180);
    const dLng = (Number(loc.longitude) - lng) * (Math.PI/180);
    const a = Math.sin(dLat/2)**2 + Math.cos(lat*Math.PI/180)*Math.cos(Number(loc.latitude)*Math.PI/180)*Math.sin(dLng/2)**2;
    const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return { ...loc, distanceKm: Math.round(dist * 10) / 10 };
  });
  withDist.sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    locations: withDist,
    hasMore,
    nextCursor: hasMore ? items[items.length - 1].id : null,
  };
};

module.exports = { createLocation, listMyLocations, getPublicLocations, updateLocation,
  deleteLocation, createTable, listTables, deleteTable, searchNearby };
