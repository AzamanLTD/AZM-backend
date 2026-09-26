'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const { ShiftService } = require('../services/businessOS/shiftService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');
const {
    KIOSK_SCOPE,
    signCapability,
    verifyCapability,
    assertShiftBinding,
} = require('../services/businessOS/kioskCapability');

function getPrisma(req) { return req.app.get('prisma'); }

function wrap(handler) {
    return async (req, res) => {
        try { await handler(req, res); }
        catch (err) { res.status(err.statusCode || 400).json({ success: false, message: err.message }); }
    };
}

// PIN authentication is an intentionally strict public challenge endpoint.
// The platform-wide limiter still applies at the route registry, while this
// local limiter adds a second, narrower guard against credential brute force.
// Successful PIN authentications are not counted so legitimate kiosk refreshes
// do not consume the failure budget.
const kioskPinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many kiosk PIN attempts. Please try again later.' },
});

async function assertCapabilityShiftBinding(prisma, capability, shiftId) {
    if (!shiftId) throw new Error('Shift ID required.');
    const shift = await prisma.shift.findFirst({
        where: {
            id: shiftId,
            businessProfileId: capability.businessProfileId,
        },
        select: {
            id: true,
            employeeId: true,
            userId: true,
            businessProfileId: true,
            locationId: true,
        },
    });
    assertShiftBinding(shift, capability);
    return shift;
}

router.post('/kiosk/pin-auth', kioskPinLimiter, wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { pinCode, businessProfileId, locationId } = req.body;
    if (!pinCode || !businessProfileId) return res.status(400).json({ success: false, message: 'PIN and business ID required' });
    if (!/^\d{4,8}$/.test(String(pinCode))) return res.status(400).json({ success: false, message: 'PIN must be 4-8 digits' });

    if (locationId) {
        const location = await prisma.businessLocation.findFirst({
            where: { id: String(locationId), businessProfileId },
            select: { id: true },
        });
        if (!location) return res.status(400).json({ success: false, message: 'Invalid kiosk location.' });
    }

    const employees = await prisma.businessEmployee.findMany({
        where: { businessProfileId, status: 'ACTIVE', pinCode: { not: null } },
        select: { id: true, pinCode: true, userId: true, role: true, title: true, department: true },
    });

    for (const employee of employees) {
        if (await bcrypt.compare(String(pinCode), employee.pinCode)) {
            const token = signCapability({ employeeId: employee.id, userId: employee.userId, businessProfileId, locationId });
            return res.json({
                success: true,
                token,
                expiresInSeconds: 300,
                employee: { id: employee.id, userId: employee.userId, role: employee.role, title: employee.title, department: employee.department },
                scope: KIOSK_SCOPE,
                businessProfileId,
                locationId: locationId || null,
            });
        }
    }

    return res.status(401).json({ success: false, message: 'Invalid PIN' });
}));

async function handleClock(req, res, method) {
    const capability = verifyCapability(req.headers['x-kiosk-token']);
    const employeeId = req.body.employeeId ? String(req.body.employeeId) : capability.employeeId;
    if (employeeId !== String(capability.employeeId)) return res.status(403).json({ success: false, message: 'Kiosk employee mismatch.' });

    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { id: capability.employeeId, businessProfileId: capability.businessProfileId, userId: capability.userId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!employee) return res.status(403).json({ success: false, message: 'Kiosk authorization is no longer valid.' });

    await assertCapabilityShiftBinding(prisma, capability, req.body.shiftId);

    req.user = { id: capability.userId };
    const result = await runWithBusinessRequestContext({
        businessProfileId: capability.businessProfileId,
        userId: capability.userId,
        isAdmin: false,
        isBusinessOwner: false,
    }, () => new ShiftService(prisma)[method](req.body.shiftId));
    res.json({ success: true, ...result });
}

router.post('/kiosk/clock-in', wrap((req, res) => handleClock(req, res, 'clockIn')));
router.post('/kiosk/clock-out', wrap((req, res) => handleClock(req, res, 'clockOut')));

module.exports = router;
