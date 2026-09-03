'use strict';

const jwt = require('jsonwebtoken');

const KIOSK_SCOPE = 'kiosk_clock_only';
const KIOSK_TOKEN_TTL = '5m';

function requireJwtSecret() {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured.');
    return process.env.JWT_SECRET;
}

function signCapability({ employeeId, userId, businessProfileId, locationId }) {
    return jwt.sign(
        {
            scope: KIOSK_SCOPE,
            employeeId,
            userId,
            businessProfileId,
            locationId: locationId || null,
        },
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

function assertShiftBinding(shift, capability) {
    if (!shift || String(shift.employeeId) !== String(capability.employeeId)) {
        throw new Error('Kiosk shift employee mismatch.');
    }
    if (String(shift.businessProfileId) !== String(capability.businessProfileId)) {
        throw new Error('Kiosk shift business mismatch.');
    }
    if (String(shift.userId) !== String(capability.userId)) {
        throw new Error('Kiosk shift employee user mismatch.');
    }
    if (capability.locationId != null && String(shift.locationId) !== String(capability.locationId)) {
        throw new Error('Kiosk location mismatch.');
    }
}

module.exports = {
    KIOSK_SCOPE,
    KIOSK_TOKEN_TTL,
    signCapability,
    verifyCapability,
    assertShiftBinding,
};
