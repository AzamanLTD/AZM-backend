'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { ShiftService } = require('../services/businessOS/shiftService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

const KIOSK_SCOPE = 'kiosk_clock_only';
const KIOSK_TOKEN_TTL = '5m';

function getPrisma(req) { return req.app.get('prisma'); }

function requireJwtSecret() {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured.');
    return process.env.JWT_SECRET;
}

function signCapability({ employeeId, userId, businessProfileId, locationId }) {
    return jwt.sign(
        { scope: KIOSK_SCOPE, employeeId, userId, businessProfileId, locationId: locationId || null },
        requireJwtSecret(),
        { expiresIn: KIOSK_TOKEN_TTL, subject: `kiosk:${employeeId}` },
    );
}

function verifyCapability(token) {
    if (!token) throw new Error('Kiosk authorization required.');
    let decoded;
    try {
        decoded = jwt.verify(token, requireJwtSecret());
    } catch (err) {
        throw new Error(err.name === 'TokenExpiredError' ? 'Kiosk authorization expired.' : 'Invalid kiosk authorization.');
    }
    if (decoded.scope !== KIOSK_SCOPE || !decoded.employeeId || !decoded.userId || !decoded.businessProfileId) {
        throw new Error('Invalid kiosk authorization scope.');
    }
    return decoded;
}

function wrap(handler) {
    return async (req, res) => {
        try { await handler(req, res); }
        catch (err) { res.status(err.statusCode || 400).json({ success: false, message: err.message }); }
    };
}

router.post('/kiosk/pin-auth', wrap(async (req, res) => {
    const prisma = getPrisma(req);
    const { pinCode, businessProfileId, locationId } = req.body;
    if (!pinCode || !businessProfileId) return res.status(400).json({ success: false, message: 'PIN and business ID required' });
    if (!/^\d{4,8}$/.test(String(pinCode))) return res.status(400).json({ success: false, message: 'PIN must be 4-8 digits' });

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

router.post('/kiosk/clock-in', wrap(async (req, res) => {
    const capability = verifyCapability(req.headers['x-kiosk-token']);
    const employeeId = req.body.employeeId ? String(req.body.employeeId) : capability.employeeId;
    if (employeeId !== String(capability.employeeId)) return res.status(403).json({ success: false, message: 'Kiosk employee mismatch.' });

    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { id: capability.employeeId, businessProfileId: capability.businessProfileId, userId: capability.userId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!employee) return res.status(403).json({ success: false, message: 'Kiosk authorization is no longer valid.' });

    req.user = { id: capability.userId };
    const result = await runWithBusinessRequestContext({
        businessProfileId: capability.businessProfileId,
        userId: capability.userId,
        isAdmin: false,
        isBusinessOwner: false,
    }, () => new ShiftService(prisma).clockIn(req.body.shiftId));
    res.json({ success: true, ...result });
}));

router.post('/kiosk/clock-out', wrap(async (req, res) => {
    const capability = verifyCapability(req.headers['x-kiosk-token']);
    const employeeId = req.body.employeeId ? String(req.body.employeeId) : capability.employeeId;
    if (employeeId !== String(capability.employeeId)) return res.status(403).json({ success: false, message: 'Kiosk employee mismatch.' });

    const prisma = getPrisma(req);
    const employee = await prisma.businessEmployee.findFirst({
        where: { id: capability.employeeId, businessProfileId: capability.businessProfileId, userId: capability.userId, status: 'ACTIVE' },
        select: { id: true },
    });
    if (!employee) return res.status(403).json({ success: false, message: 'Kiosk authorization is no longer valid.' });

    req.user = { id: capability.userId };
    const result = await runWithBusinessRequestContext({
        businessProfileId: capability.businessProfileId,
        userId: capability.userId,
        isAdmin: false,
        isBusinessOwner: false,
    }, () => new ShiftService(prisma).clockOut(req.body.shiftId));
    res.json({ success: true, ...result });
}));

module.exports = router;
