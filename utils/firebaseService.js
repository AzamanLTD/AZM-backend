const admin = require('firebase-admin');
const path = require('path');

// Locate the "service-account.json" file in the project root.
// __dirname is `utils/`, so '..' goes up one level.
//
// NOTE: this file is gitignored and provided per-environment. See
// `.env.example` for the setup steps. If it's missing the server will
// boot fine; sendPushNotification just becomes a no-op.
//
// RENDER DEPLOYMENT: Since service-account.json is gitignored, Render
// won't have the file. Set the FIREBASE_SERVICE_ACCOUNT_BASE64 env var
// with the base64-encoded contents of the JSON file. The code below
// decodes it at runtime.
const serviceAccountPath = path.join(__dirname, '../service-account.json');

// Initialize Firebase (wrap in try/catch so a missing key file
// doesn't crash the server — push notifications just silently disable).
try {
    if (!admin.apps.length) {
        let serviceAccount;

        // Priority 1: Base64-encoded env var (for Render / cloud deploys)
        if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
            const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
            serviceAccount = JSON.parse(decoded);
        } else {
            // Priority 2: Local file (for dev)
            serviceAccount = require(serviceAccountPath);
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Admin SDK Initialized Successfully");
    }
} catch (error) {
    console.error("⚠️ FIREBASE INIT WARNING: Could not load Firebase credentials.");
    console.error("   Push notifications will be disabled until credentials are provided.");
    console.error("   Options: set FIREBASE_SERVICE_ACCOUNT_BASE64 env var, or place service-account.json in project root.");
    console.error("   Error details:", error.message);
}

/**
 * Send a Push Notification to a specific device
 * @param {string} fcmToken - The user's device token from Flutter
 * @param {string} title - The notification title (e.g. "New Order")
 * @param {string} body - The notification message (e.g. "Buyer wants to trade $50")
 * @param {object} data - Optional custom data (e.g. { tradeId: "123" })
 */
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
    // Safety check: If no token or Firebase failed to load, stop.
    if (!fcmToken || !admin.apps.length) {
        console.warn("⚠️ Cannot send notification: Missing Token or Firebase not init.");
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
        const response = await admin.messaging().send(message);
        console.log(`🚀 Notification sent! Message ID: ${response}`);
        return response;
    } catch (error) {
        console.error("❌ Error sending notification:", error.message);
        // Tip: If error is 'registration-token-not-registered', the user uninstalled the app.
        // You could add logic here to delete the bad token from your DB.
    }
};

module.exports = { sendPushNotification };