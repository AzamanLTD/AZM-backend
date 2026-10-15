// utils/firebaseService.js
// =============================================================================
// Firebase Admin SDK — MODULAR API (v14).
//
// firebase-admin v14 REMOVED the legacy namespaced API: the default export
// no longer exposes `apps`, `credential` or `messaging()` (the previous
// `admin.apps.length` guard crashed on the live service with "Cannot read
// properties of undefined (reading 'length')"). Everything now goes through
// the supported modular entry points:
//   - firebase-admin/app      → initializeApp, getApps, cert
//   - firebase-admin/messaging → getMessaging
//   (controllers/ssoController.js uses firebase-admin/auth → getAuth)
//
// CREDENTIAL HANDLING (unchanged priority order, tolerant encoding):
//   1. FIREBASE_SERVICE_ACCOUNT (preferred deployment credential —
//      accepted as base64-encoded JSON OR raw JSON)
//   2. FIREBASE_SERVICE_ACCOUNT_BASE64 (base64-encoded JSON, the previous
//      deployment shape — kept for compatibility)
//   3. Local service-account.json in the project root (gitignored, dev)
//
// Missing, malformed or invalid credentials fail SAFE: the server boots
// normally and push notifications are simply disabled. Credential VALUES
// are never logged — only the error message.
// =============================================================================

const logger = require('../src/config/logger');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// Locate the "service-account.json" file in the project root.
// __dirname is `utils/`, so '..' goes up one level.
//
// NOTE: this file is gitignored and provided per-environment. See
// `.env.example` for the setup steps. If it's missing the server will
// boot fine; sendPushNotification just becomes a no-op.
const serviceAccountPath = path.join(__dirname, '../service-account.json');

/**
 * Parse a service-account credential from a raw env value. Accepts either
 * a base64-encoded JSON document (the deployment shape, including the
 * URL-safe alphabet) or a raw JSON document (defensive: some secret stores
 * save the JSON unencoded). Never logs the value.
 *
 * @param {string} raw - The raw env var contents.
 * @returns {object} The parsed service account object.
 * @throws {Error} If the value is neither valid base64 nor valid JSON.
 */
function _parseServiceAccount(raw) {
    const trimmed = String(raw || '').trim();
    try {
        if (trimmed.startsWith('{')) {
            return JSON.parse(trimmed);
        }
        // base64 (tolerate URL-safe variants and missing padding)
        const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(normalized, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (error) {
        // SECURITY: JSON.parse SyntaxError messages ECHO A SNIPPET of the
        // input ("Unexpected token '…', "…" is not valid JSON"), so a
        // malformed credential could leak fragments into logs. Surface a
        // generic error instead — the raw value is never thrown upward.
        throw new Error('FIREBASE_CREDENTIAL_PARSE_ERROR: credential value is neither valid JSON nor valid base64-encoded JSON');
    }
}

// Initialization state mirror — getApps().length is the authoritative
// readiness check (used by sendPushNotification); this flag only avoids
// re-attempting init on every require in the same process.
let initialized = false;

/**
 * Initialize the Firebase Admin SDK. Idempotent: a no-op when any app is
 * already initialized (getApps().length > 0). Fail-safe: returns false and
 * logs a warning instead of throwing, so a bad/missing credential can
 * never crash backend startup.
 *
 * @returns {boolean} true when the SDK is initialized and ready.
 */
function initializeFirebase() {
    if (getApps().length > 0) {
        initialized = true;
        return true;
    }

    try {
        let serviceAccount;

        // Priority 1: FIREBASE_SERVICE_ACCOUNT (preferred deployment
        // credential; base64-encoded JSON or raw JSON both accepted).
        // Priority 2: FIREBASE_SERVICE_ACCOUNT_BASE64 (previous deployment
        // shape, kept so existing environments keep working unchanged).
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = _parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
        } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
            serviceAccount = _parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64);
        } else {
            // Priority 3: Local file (for dev). require() throws
            // MODULE_NOT_FOUND when absent — caught below.
            serviceAccount = require(serviceAccountPath);
        }

        initializeApp({ credential: cert(serviceAccount) });
        initialized = true;
        logger.info('🔥 Firebase Admin SDK Initialized Successfully');
        return true;
    } catch (error) {
        initialized = false;
        // Under test, a missing service-account is expected — log at warn
        // level so CI output isn't polluted with error-level noise.
        // Elsewhere keep it loud. Only the error MESSAGE is logged — never
        // the credential value or the parsed credential object.
        const logFn = process.env.NODE_ENV === 'test' ? logger.warn.bind(logger) : logger.error.bind(logger);
        logFn(
            { err: error && error.message ? error.message : String(error) },
            'FIREBASE INIT WARNING: Could not load Firebase credentials. Push notifications will be disabled. Set FIREBASE_SERVICE_ACCOUNT (base64 or JSON) or place service-account.json in the project root.'
        );
        return false;
    }
}

// Boot behavior preserved: initialize once at module load, fail-safe.
initializeFirebase();

/**
 * Send a Push Notification to a specific device
 * @param {string} fcmToken - The user's device token from Flutter
 * @param {string} title - The notification title (e.g. "New Order")
 * @param {string} body - The notification message (e.g. "Buyer wants to trade $50")
 * @param {object} data - Optional custom data (e.g. { tradeId: "123" })
 */
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
    // Safety check: If no token or Firebase failed to load, stop.
    // getApps().length is the v14 modular readiness check.
    if (!fcmToken || getApps().length === 0) {
        logger.warn('⚠️ Cannot send notification: Missing Token or Firebase not init.');
        return;
    }

    const message = {
        token: fcmToken,
        notification: {
            title: title,
            body: body,
        },
        // 'data' must only contain strings. We ensure everything is a string here.
        data: Object.keys(data).reduce((acc, key) => {
            acc[key] = String(data[key]);
            return acc;
        }, { click_action: 'FLUTTER_NOTIFICATION_CLICK' })
    };

    try {
        const response = await getMessaging().send(message);
        logger.info(`🚀 Notification sent! Message ID: ${response}`);
        return response;
    } catch (error) {
        logger.error({ err: error }, '❌ Error sending notification');
        // Tip: If error is 'registration-token-not-registered', the user uninstalled the app.
        // You could add logic here to delete the bad token from your DB.
    }
};

module.exports = {
    sendPushNotification,
    initializeFirebase,
    _parseServiceAccount,
};
