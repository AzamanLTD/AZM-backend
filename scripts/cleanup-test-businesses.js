#!/usr/bin/env node
// =============================================================================
// scripts/cleanup-test-businesses.js
// AZM Business Portal Cleanup Script
//
// Uses the backend REST API (NOT direct DB) with admin authentication to:
//
//   1. Find and delete test businesses:
//        - 'AZ QA Transit test co'
//        - 'test chop bar'
//        - 'Azaman'          (the TEST business, not the platform)
//        - 'test portal biz'
//
//   2. Transfer transit fleet (vehicles) from 'AZ QA Transit test co'
//      into 'CityLink Transit'.
//
//   3. Seed hotel rooms for 'Grand Ridge hotel'
//      (Standard, Deluxe, Suite room types).
//
//   4. Find 'Golden Pot Restaurant' and delete ad posts that have no picture
//      (mediaUrl is null or empty).
//
// -----------------------------------------------------------------------------
// IMPORTANT — API GAP FINDINGS (read before running):
//
//   A) NO hard-delete endpoint for businesses exists in the API.
//      Admin routes only offer:
//        GET    /api/admin/businesses              (list/search)
//        POST   /api/admin/businesses/:bizId/suspend
//        POST   /api/admin/businesses/:bizId/unsuspend
//      There is no DELETE /api/admin/businesses/:bizId.
//      -> This script SUSPENDS test businesses as a soft-delete. For a true
//         hard delete, add a new admin endpoint or use a direct Prisma script.
//
//   B) Admin CANNOT delete BusinessAdPosts via the existing API.
//      DELETE /api/ad-posts/:id looks up the caller's BusinessProfile via
//      req.user.id (where: { userId }). An admin user has no business profile,
//      so the call throws "Business profile not found."
//      -> This script LISTS pictureless ads (via the public active-ads endpoint)
//         and ATTEMPTS deletion, but expects it to fail for admin. To actually
//         remove them, either:
//           (a) log in as the business owner and delete, or
//           (b) add an admin ad-deletion endpoint (DELETE /api/admin/ad-posts/:id).
//
//   C) Admin CAN impersonate businesses for Business OS endpoints via the
//      x-admin-business-id header (value = the business's internal UUID id,
//      NOT the public bizId like "BIZ-123456789"). This is handled by the
//      adminBusinessScope middleware (applied globally in server.js).
//      -> Hotel room seeding and transit fleet transfer use this mechanism.
//
//   D) Transit "functions" = transit fleet vehicles (TransitVehicle model).
//      The transfer is: list source fleet -> create equivalent vehicles in
//      target business. Trips/bookings/cargo are NOT transferred (they have
//      historical/financial dependencies and no copy endpoint exists).
//
// -----------------------------------------------------------------------------
// USAGE:
//
//   AZM_API_URL=http://localhost:3000/api \
//   AZM_ADMIN_EMAIL=admin@azaman.com \
//   AZM_ADMIN_PASSWORD='YourPassword' \
//   node scripts/cleanup-test-businesses.js
//
//   Optional (dry-run mode, no mutations):
//   AZM_DRY_RUN=1 node scripts/cleanup-test-businesses.js
//
// =============================================================================

'use strict';

const axios = require('axios');

// -- Configuration ------------------------------------------------------------

const BASE_URL = (
    process.env.AZM_API_URL || 'http://localhost:3000/api'
).replace(/\/+$/, ''); // strip trailing slash

const ADMIN_EMAIL = process.env.AZM_ADMIN_EMAIL || 'admin@azaman.com';
const ADMIN_PASSWORD = process.env.AZM_ADMIN_PASSWORD || '';
const DRY_RUN = process.env.AZM_DRY_RUN === '1' || process.env.AZM_DRY_RUN === 'true';

// -- Target business names (case-insensitive matching) -------------------------

const TEST_BUSINESSES_TO_DELETE = [
    'AZ QA Transit test co',
    'test chop bar',
    'Azaman',          // the TEST business, not the platform
    'test portal biz',
];

const SOURCE_TRANSIT_BIZ = 'AZ QA Transit test co';
const TARGET_TRANSIT_BIZ = 'CityLink Transit';

const HOTEL_BIZ_NAME = 'Grand Ridge hotel';
const RESTAURANT_BIZ_NAME = 'Golden Pot Restaurant';

// -- Hotel room seed data (standard types) -------------------------------------
// roomType values must match the HotelRoom schema comment:
//   "STANDARD", "DELUXE", "SUITE", "EXECUTIVE"
// basePrice is per-night in USDC.

const HOTEL_ROOM_SEEDS = [
    // Standard rooms
    { roomNumber: '101', floor: 1, roomType: 'STANDARD', basePrice: 75,  capacity: 2, bedConfig: '1 QUEEN',            amenities: ['AC', 'WIFI', 'TV'],                                    description: 'Standard Queen Room' },
    { roomNumber: '102', floor: 1, roomType: 'STANDARD', basePrice: 75,  capacity: 2, bedConfig: '2 SINGLE',           amenities: ['AC', 'WIFI', 'TV'],                                    description: 'Standard Twin Room' },
    { roomNumber: '103', floor: 1, roomType: 'STANDARD', basePrice: 75,  capacity: 2, bedConfig: '1 QUEEN',            amenities: ['AC', 'WIFI', 'TV'],                                    description: 'Standard Queen Room' },
    { roomNumber: '201', floor: 2, roomType: 'STANDARD', basePrice: 80,  capacity: 2, bedConfig: '1 KING',             amenities: ['AC', 'WIFI', 'TV'],                                    description: 'Standard King Room' },
    // Deluxe rooms
    { roomNumber: '202', floor: 2, roomType: 'DELUXE',   basePrice: 120, capacity: 2, bedConfig: '1 KING',             amenities: ['AC', 'WIFI', 'TV', 'MINIBAR'],                         description: 'Deluxe King Room' },
    { roomNumber: '203', floor: 2, roomType: 'DELUXE',   basePrice: 120, capacity: 3, bedConfig: '1 KING + 1 SINGLE',  amenities: ['AC', 'WIFI', 'TV', 'MINIBAR'],                         description: 'Deluxe Family Room' },
    { roomNumber: '301', floor: 3, roomType: 'DELUXE',   basePrice: 130, capacity: 2, bedConfig: '1 KING',             amenities: ['AC', 'WIFI', 'TV', 'MINIBAR', 'BALCONY'],              description: 'Deluxe King with Balcony' },
    // Suites
    { roomNumber: '401', floor: 4, roomType: 'SUITE',    basePrice: 250, capacity: 4, bedConfig: '1 KING + 1 SOFA BED', amenities: ['AC', 'WIFI', 'TV', 'MINIBAR', 'BALCONY', 'OCEAN_VIEW'], description: 'Executive Suite' },
    { roomNumber: '402', floor: 4, roomType: 'SUITE',    basePrice: 300, capacity: 4, bedConfig: '1 KING + 2 SINGLE',   amenities: ['AC', 'WIFI', 'TV', 'MINIBAR', 'BALCONY', 'OCEAN_VIEW'], description: 'Presidential Suite' },
];

// -- HTTP client (set after login) --------------------------------------------

let http = null; // axios instance with auth header

// -- Helpers -------------------------------------------------------------------

function log(...args)    { console.log('[cleanup]', ...args); }
function warn(...args)   { console.warn('[cleanup] WARN:', ...args); }
function error(...args)  { console.error('[cleanup] ERROR:', ...args); }
function ok(...args)     { console.log('[cleanup] OK:', ...args); }
function dryRun(...args) { console.log('[cleanup] DRY-RUN:', ...args); }

function nameMatches(businessName, target) {
    return businessName && businessName.toLowerCase().trim() === target.toLowerCase().trim();
}

function nameContains(businessName, target) {
    return businessName && businessName.toLowerCase().includes(target.toLowerCase());
}

// -- Step 0: Login as admin ----------------------------------------------------

async function loginAdmin() {
    if (!ADMIN_PASSWORD) {
        error('AZM_ADMIN_PASSWORD env var is required. Set it before running.');
        error('Example: AZM_ADMIN_PASSWORD=YourPass node scripts/cleanup-test-businesses.js');
        process.exit(1);
    }

    log('Logging in as admin: ' + ADMIN_EMAIL + '  ->  ' + BASE_URL + '/auth/login');
    const resp = await axios.post(BASE_URL + '/auth/login', {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
    });

    if (!resp.data || !resp.data.success) {
        error('Login failed:', resp.data && resp.data.message);
        process.exit(1);
    }

    const token = resp.data.accessToken || resp.data.token;
    if (!token) {
        error('Login succeeded but no access token in response.');
        process.exit(1);
    }

    const user = resp.data.user;
    if (user && user.role !== 'ADMIN') {
        warn('Logged-in user role is "' + user.role + '", expected "ADMIN". Admin endpoints will be rejected.');
    }

    ok('Logged in as ' + (user ? user.username : ADMIN_EMAIL) + ' (role: ' + (user ? user.role : '?') + ')');

    // Create an axios instance with the Bearer token pre-set
    http = axios.create({
        baseURL: BASE_URL,
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
        },
        validateStatus: function () { return true; }, // don't throw on 4xx
    });

    return token;
}

// -- Step 1: Find businesses by name (paginated search) ------------------------

async function findBusinessByName(name) {
    // GET /api/admin/businesses?q=<name>&limit=100
    // Returns { businesses: [...], total, page, pagination }
    const resp = await http.get('/admin/businesses', { params: { q: name, limit: 100 } });
    if (resp.status !== 200) {
        error('admin/businesses search failed (' + resp.status + '):', resp.data);
        return null;
    }

    const businesses = resp.data.businesses || [];
    // Try exact match first, then contains
    let match = businesses.find(function (b) { return nameMatches(b.businessName, name); });
    if (!match) {
        match = businesses.find(function (b) { return nameContains(b.businessName, name); });
    }

    return match || null;
}

async function findAllTargetBusinesses() {
    var allNames = TEST_BUSINESSES_TO_DELETE.concat([
        SOURCE_TRANSIT_BIZ,
        TARGET_TRANSIT_BIZ,
        HOTEL_BIZ_NAME,
        RESTAURANT_BIZ_NAME,
    ]);
    // Deduplicate
    var uniqueNames = [];
    allNames.forEach(function (n) { if (uniqueNames.indexOf(n) === -1) uniqueNames.push(n); });
    var results = {};

    for (var i = 0; i < uniqueNames.length; i++) {
        var name = uniqueNames[i];
        var biz = await findBusinessByName(name);
        if (biz) {
            ok('Found "' + biz.businessName + '" -- id: ' + biz.id + ', bizId: ' + biz.bizId + ', category: ' + (biz.category || 'n/a'));
            results[name] = biz;
        } else {
            warn('Business "' + name + '" not found via admin search.');
            results[name] = null;
        }
    }

    return results;
}

// -- Step 2: Delete (suspend) test businesses ----------------------------------

async function deleteTestBusinesses(bizMap) {
    log('');
    log('=== STEP 1: Delete test businesses ===');
    log('NOTE: No hard-delete API endpoint exists. Using suspend as soft-delete.');
    log('      For true deletion, add DELETE /api/admin/businesses/:bizId or use direct Prisma.');

    for (var i = 0; i < TEST_BUSINESSES_TO_DELETE.length; i++) {
        var name = TEST_BUSINESSES_TO_DELETE[i];
        var biz = bizMap[name];
        if (!biz) {
            warn('"' + name + '" -- not found, skipping.');
            continue;
        }

        // Extra guard: "Azaman" is ambiguous -- it could be the platform name.
        // Only suspend if the business name EXACTLY matches "Azaman".
        if (name === 'Azaman') {
            if (biz.businessName !== 'Azaman') {
                warn('"Azaman" -- found "' + biz.businessName + '" which is not an exact match. Skipping to avoid deleting the platform.');
                continue;
            }
        }

        if (DRY_RUN) {
            dryRun('Would suspend "' + biz.businessName + '" (bizId: ' + biz.bizId + ').');
            continue;
        }

        // POST /api/admin/businesses/:bizId/suspend  body: { reason }
        var resp = await http.post('/admin/businesses/' + biz.bizId + '/suspend', {
            reason: 'Cleanup: test business removed during portal cleanup.',
        });

        if (resp.status === 200) {
            ok('Suspended (soft-deleted) "' + biz.businessName + '" (bizId: ' + biz.bizId + ').');
        } else if (resp.status === 409) {
            warn('"' + biz.businessName + '" is already suspended.');
        } else {
            error('Failed to suspend "' + biz.businessName + '" (' + resp.status + '):', resp.data);
        }
    }
}

// -- Step 3: Transfer transit fleet from source to target ----------------------

async function transferTransitFleet(bizMap) {
    log('');
    log('=== STEP 2: Transfer transit fleet ===');
    log('Source: "' + SOURCE_TRANSIT_BIZ + '" -> Target: "' + TARGET_TRANSIT_BIZ + '"');

    var source = bizMap[SOURCE_TRANSIT_BIZ];
    var target = bizMap[TARGET_TRANSIT_BIZ];

    if (!source) {
        warn('Source business "' + SOURCE_TRANSIT_BIZ + '" not found. Skipping fleet transfer.');
        return;
    }
    if (!target) {
        warn('Target business "' + TARGET_TRANSIT_BIZ + '" not found. Skipping fleet transfer.');
        return;
    }

    // List source fleet via Business OS with admin impersonation
    // GET /api/business-os/transit/fleet  with x-admin-business-id: <source.id>
    log('Fetching fleet from "' + source.businessName + '" (id: ' + source.id + ')...');
    var listResp = await http.get('/business-os/transit/fleet', {
        headers: { 'x-admin-business-id': source.id },
    });

    if (listResp.status !== 200) {
        error('Failed to list source fleet (' + listResp.status + '):', listResp.data);
        return;
    }

    var fleet = listResp.data.fleet || [];
    if (fleet.length === 0) {
        warn('Source business has no vehicles to transfer.');
        return;
    }

    log('Found ' + fleet.length + ' vehicle(s) in source fleet:');
    fleet.forEach(function (v, idx) {
        log('  [' + (idx + 1) + '] ' + v.type + ' ' + (v.make || '') + ' ' + (v.model || '') + ' -- plate: ' + (v.licensePlate || 'n/a') + ' -- capacity: ' + v.capacity);
    });

    // Check existing target fleet to avoid duplicates
    log('Checking existing fleet in target "' + target.businessName + '" (id: ' + target.id + ')...');
    var targetResp = await http.get('/business-os/transit/fleet', {
        headers: { 'x-admin-business-id': target.id },
    });
    var targetFleet = targetResp.status === 200 ? (targetResp.data.fleet || []) : [];
    var targetPlates = {};
    targetFleet.forEach(function (v) {
        if (v.licensePlate) targetPlates[v.licensePlate.toUpperCase()] = true;
    });

    var created = 0;
    var skipped = 0;

    for (var i = 0; i < fleet.length; i++) {
        var v = fleet[i];

        // Skip if a vehicle with the same plate already exists in target
        if (v.licensePlate && targetPlates[v.licensePlate.toUpperCase()]) {
            warn('Vehicle with plate "' + v.licensePlate + '" already exists in target. Skipping.');
            skipped++;
            continue;
        }

        if (DRY_RUN) {
            dryRun('Would create vehicle: ' + v.type + ' ' + (v.make || '') + ' ' + (v.model || '') + ' (plate: ' + (v.licensePlate || 'n/a') + ') in target.');
            continue;
        }

        // POST /api/business-os/transit/fleet  with x-admin-business-id: <target.id>
        var createResp = await http.post('/business-os/transit/fleet', {
            type: v.type,
            make: v.make || null,
            model: v.model || null,
            year: v.year || null,
            color: v.color || null,
            licensePlate: v.licensePlate || null,
            capacity: v.capacity || 4,
            imageUrl: v.imageUrl || null,
            driverName: v.driverName || null,
            driverPhone: v.driverPhone || null,
            driverPhotoUrl: v.driverPhotoUrl || null,
        }, {
            headers: { 'x-admin-business-id': target.id },
        });

        if (createResp.status === 201) {
            ok('Created vehicle: ' + v.type + ' ' + (v.make || '') + ' ' + (v.model || '') + ' (plate: ' + (v.licensePlate || 'n/a') + ') in target.');
            created++;
        } else {
            error('Failed to create vehicle (' + createResp.status + '):', createResp.data);
        }
    }

    log('Fleet transfer complete: ' + created + ' created, ' + skipped + ' skipped (duplicates).');
    log('NOTE: Trips, bookings, cargo parcels, and maintenance records are NOT transferred.');
    log('      They remain on the source business for historical/financial records.');
}

// -- Step 4: Seed hotel rooms for Grand Ridge hotel ----------------------------

async function seedHotelRooms(bizMap) {
    log('');
    log('=== STEP 3: Seed hotel rooms ===');
    log('Target: "' + HOTEL_BIZ_NAME + '"');

    var hotel = bizMap[HOTEL_BIZ_NAME];
    if (!hotel) {
        warn('Hotel "' + HOTEL_BIZ_NAME + '" not found. Skipping room seeding.');
        return;
    }

    // Check existing rooms first
    log('Checking existing rooms (id: ' + hotel.id + ')...');
    var listResp = await http.get('/business-os/hotel/rooms', {
        headers: { 'x-admin-business-id': hotel.id },
    });

    var existingRooms = listResp.status === 200 ? (listResp.data.rooms || []) : [];
    var existingNumbers = {};
    existingRooms.forEach(function (r) { existingNumbers[r.roomNumber] = true; });

    if (existingRooms.length > 0) {
        log('Hotel already has ' + existingRooms.length + ' room(s): ' + existingRooms.map(function (r) { return r.roomNumber; }).join(', '));
    }

    var created = 0;
    var skipped = 0;

    for (var i = 0; i < HOTEL_ROOM_SEEDS.length; i++) {
        var seed = HOTEL_ROOM_SEEDS[i];

        if (existingNumbers[seed.roomNumber]) {
            warn('Room ' + seed.roomNumber + ' already exists. Skipping.');
            skipped++;
            continue;
        }

        if (DRY_RUN) {
            dryRun('Would create room ' + seed.roomNumber + ' (' + seed.roomType + ', $' + seed.basePrice + '/night).');
            continue;
        }

        // POST /api/business-os/hotel/rooms  with x-admin-business-id: <hotel.id>
        var createResp = await http.post('/business-os/hotel/rooms', {
            roomNumber: seed.roomNumber,
            floor: seed.floor,
            roomType: seed.roomType,
            basePrice: seed.basePrice,
            capacity: seed.capacity,
            bedConfig: seed.bedConfig,
            amenities: seed.amenities,
            description: seed.description,
        }, {
            headers: { 'x-admin-business-id': hotel.id },
        });

        if (createResp.status === 201) {
            ok('Created room ' + seed.roomNumber + ' (' + seed.roomType + ', $' + seed.basePrice + '/night, capacity: ' + seed.capacity + ').');
            created++;
        } else {
            error('Failed to create room ' + seed.roomNumber + ' (' + createResp.status + '):', createResp.data);
        }
    }

    log('Hotel room seeding complete: ' + created + ' created, ' + skipped + ' skipped (already exist).');
}

// -- Step 5: Remove pictureless ads from Golden Pot Restaurant -----------------

async function removePicturelessAds(bizMap) {
    log('');
    log('=== STEP 4: Remove pictureless ads ===');
    log('Target: "' + RESTAURANT_BIZ_NAME + '"');

    var restaurant = bizMap[RESTAURANT_BIZ_NAME];
    if (!restaurant) {
        warn('Restaurant "' + RESTAURANT_BIZ_NAME + '" not found. Skipping ad cleanup.');
        return;
    }

    // GET /api/ad-posts/active/:businessProfileId  (public endpoint)
    // Uses the internal business profile id (UUID), not the bizId.
    log('Fetching active ad posts (businessProfileId: ' + restaurant.id + ')...');
    var listResp = await http.get('/ad-posts/active/' + restaurant.id);

    if (listResp.status !== 200) {
        error('Failed to list ad posts (' + listResp.status + '):', listResp.data);
        return;
    }

    var ads = listResp.data.ads || [];
    if (ads.length === 0) {
        warn('No active ad posts found for "' + restaurant.businessName + '".');
        return;
    }

    log('Found ' + ads.length + ' active ad post(s).');

    // Filter ads without a picture (mediaUrl is null or empty string)
    var pictureless = ads.filter(function (ad) {
        return !ad.mediaUrl || ad.mediaUrl.trim() === '';
    });

    if (pictureless.length === 0) {
        ok('All ' + ads.length + ' ad post(s) have pictures. Nothing to remove.');
        return;
    }

    log('Found ' + pictureless.length + ' ad post(s) WITHOUT pictures:');
    pictureless.forEach(function (ad, idx) {
        log('  [' + (idx + 1) + '] id: ' + ad.id + ' -- title: "' + ad.title + '" -- mediaUrl: ' + (ad.mediaUrl || '(none)'));
    });

    // API GAP: DELETE /api/ad-posts/:id uses req.user.id to find the caller's
    // business profile. Admin has no business profile, so this will fail with
    // "Business profile not found." There is no admin-specific ad deletion
    // endpoint. The script attempts deletion anyway (in case the API is later
    // patched) and logs the result.
    warn('API GAP: Admin cannot delete ad posts -- DELETE /api/ad-posts/:id');
    warn('uses req.user.id to look up the business profile. Admin has none.');
    warn('To actually remove these ads, either:');
    warn('  (a) log in as the business owner, or');
    warn('  (b) add an admin endpoint: DELETE /api/admin/ad-posts/:id');

    var deleted = 0;
    var failed = 0;

    for (var i = 0; i < pictureless.length; i++) {
        var ad = pictureless[i];

        if (DRY_RUN) {
            dryRun('Would delete ad post "' + ad.title + '" (id: ' + ad.id + ').');
            continue;
        }

        // Attempt deletion -- will likely fail for admin (see warning above)
        var delResp = await http.delete('/ad-posts/' + ad.id, {
            headers: { 'x-admin-business-id': restaurant.id },
        });

        if (delResp.status === 200 && delResp.data && delResp.data.success) {
            ok('Deleted ad post "' + ad.title + '" (id: ' + ad.id + ').');
            deleted++;
        } else {
            error('Could not delete ad post "' + ad.title + '" (id: ' + ad.id + ', status: ' + delResp.status + '): ' + (delResp.data && delResp.data.message || 'failed'));
            failed++;
        }
    }

    if (failed > 0 && deleted === 0) {
        warn('All ' + failed + ' deletion(s) failed -- expected for admin (no business profile).');
        warn('The pictureless ad IDs listed above need manual removal or an admin endpoint.');
    } else {
        log('Ad cleanup: ' + deleted + ' deleted, ' + failed + ' failed.');
    }
}

// -- Main ----------------------------------------------------------------------

async function main() {
    console.log('');
    console.log('======================================================================');
    console.log('  AZM Business Portal Cleanup Script');
    console.log('  Uses backend API with admin auth (no direct DB access)');
    console.log('======================================================================');
    console.log('');

    if (DRY_RUN) {
        dryRun('Running in DRY-RUN mode -- no mutations will be performed.');
        console.log('');
    }

    log('API URL: ' + BASE_URL);
    log('Admin email: ' + ADMIN_EMAIL);
    console.log('');

    // Step 0: Login
    await loginAdmin();

    // Step 1: Find all target businesses
    log('');
    log('=== Finding target businesses ===');
    var bizMap = await findAllTargetBusinesses();

    // Step 2: Delete (suspend) test businesses
    await deleteTestBusinesses(bizMap);

    // Step 3: Transfer transit fleet
    await transferTransitFleet(bizMap);

    // Step 4: Seed hotel rooms
    await seedHotelRooms(bizMap);

    // Step 5: Remove pictureless ads
    await removePicturelessAds(bizMap);

    // Summary
    log('');
    log('=== Cleanup complete ===');
    log('Review the output above for any warnings or errors.');
    if (!DRY_RUN) {
        log('Remember: test businesses were SUSPENDED (soft-deleted), not hard-deleted.');
        log('To permanently remove them, add a DELETE admin endpoint or run a Prisma script.');
    }
    console.log('');
}

main().catch(function (err) {
    error('Unhandled error:', err.message);
    if (err.response) {
        error('Response status:', err.response.status);
        error('Response data:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
});
