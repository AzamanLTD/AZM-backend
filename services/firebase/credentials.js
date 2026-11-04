// services/firebase/credentials.js
// =============================================================================
// Credential resolution for the FCM replacement, at parity with the production
// Firebase service (utils/firebaseService.js) so a swap cannot change how the
// deployment supplies its credential.
//
// PROOF OF CONCEPT - isolated branch. Not wired into any production route.
//
// Parity is deliberate on four points that are easy to lose in a rewrite:
//   1. Priority order: FIREBASE_SERVICE_ACCOUNT, then
//      FIREBASE_SERVICE_ACCOUNT_BASE64, then a local credential file.
//   2. The first variable accepts raw JSON *or* base64, detected by content,
//      and base64 is decoded tolerantly (URL-safe alphabet, missing padding):
//      Buffer.from ignores the pad characters and callers cannot be expected
//      to emit them.
//   3. A malformed credential throws a GENERIC error. JSON.parse echoes a
//      fragment of its input in the message, and that input is a private key.
//   4. Nothing here throws during boot unless the caller asks for it: the
//      fail-safe wrapper below logs and disables messaging instead, so a
//      missing credential can never stop the financial backend from starting.
// =============================================================================

const path = require('path');

const DEFAULT_CLICK_ACTION = 'FLUTTER_NOTIFICATION_CLICK';
// Production resolves this from the module location (utils/..), not from the
// process working directory, so a different CWD cannot change which file is
// read. This file lives in services/firebase/, hence two levels up.
const LOCAL_CREDENTIAL_FILE = path.join(__dirname, '..', '..', 'service-account.json');

const CREDENTIAL_PARSE_ERROR = 'FIREBASE_CREDENTIAL_PARSE_ERROR: credential value is neither valid JSON nor valid base64-encoded JSON';
const CREDENTIAL_MISSING = 'FIREBASE_CREDENTIAL_MISSING: no Firebase credential was supplied';

/**
 * Accept raw JSON or base64-encoded JSON and return the parsed object.
 * The thrown message is intentionally constant: it never includes the input,
 * a prefix of it, or the parser's own message.
 */
function parseServiceAccount(raw) {
    const trimmed = String(raw == null ? '' : raw).trim();
    if (trimmed.length === 0) throw new Error(CREDENTIAL_PARSE_ERROR);
    try {
        if (trimmed.startsWith('{')) return JSON.parse(trimmed);
        const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    } catch (err) {
        throw new Error(CREDENTIAL_PARSE_ERROR);
    }
}

function assertUsable(serviceAccount) {
    // A parsed object is not necessarily a usable credential. The FCM client
    // needs these three, and failing here keeps the error well away from a
    // network call.
    const missing = ['client_email', 'private_key', 'project_id']
        .filter((field) => !serviceAccount || typeof serviceAccount[field] !== 'string' || serviceAccount[field].length === 0);
    if (missing.length > 0) {
        throw new Error('FIREBASE_CREDENTIAL_INCOMPLETE: missing ' + missing.join(', '));
    }
    return serviceAccount;
}

/**
 * Resolve a credential using the production priority order.
 * `readFile` and `env` are injected so tests never touch the filesystem or the
 * real environment, and so no credential has to exist on disk for a test run.
 */
function defaultReadFile(filePath) {
    try {
        return require('fs').readFileSync(filePath, 'utf8');
    } catch (err) {
        // Absent file is the normal "no local credential" case, exactly like
        // production's require() throwing MODULE_NOT_FOUND into its catch.
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
        throw err;
    }
}

function resolveServiceAccount({
    env = process.env,
    readFile = defaultReadFile,
    localPath = LOCAL_CREDENTIAL_FILE,
} = {}) {
    const primary = env.FIREBASE_SERVICE_ACCOUNT;
    if (primary && String(primary).trim().length > 0) {
        return { serviceAccount: assertUsable(parseServiceAccount(primary)), source: 'FIREBASE_SERVICE_ACCOUNT' };
    }
    const secondary = env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (secondary && String(secondary).trim().length > 0) {
        return { serviceAccount: assertUsable(parseServiceAccount(secondary)), source: 'FIREBASE_SERVICE_ACCOUNT_BASE64' };
    }
    if (typeof readFile === 'function') {
        const text = readFile(localPath);
        if (text != null) {
            return { serviceAccount: assertUsable(parseServiceAccount(text)), source: 'file:' + localPath };
        }
    }
    throw new Error(CREDENTIAL_MISSING);
}

/**
 * Fail-safe messaging facade, mirroring the production service: when no
 * credential resolves, `configured` is false, the failure is logged once as a
 * warning, and send() resolves to null instead of throwing. The production
 * helper behaves this way and financial routes depend on it not exploding.
 */
function createFailSafeMessaging({ env = process.env, logger = console, resolve = resolveServiceAccount, createClient } = {}) {
    let client = null;
    let reason = null;
    try {
        const { serviceAccount, source } = resolve({ env });
        client = createClient({ serviceAccount });
    } catch (err) {
        reason = err && err.code ? err.code : 'FIREBASE_UNAVAILABLE';
        const log = logger && typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {};
        log({
            err: err && err.message ? err.message : String(err),
        }, 'FIREBASE INIT WARNING: Could not load Firebase credentials. Push notifications will be disabled.');
    }
    return {
        configured: client !== null,
        reason,
        async sendPush(token, title, body, data) {
            if (!client || !token) return null;
            return client.send({ token, title, body, data });
        },
    };
}

module.exports = {
    DEFAULT_CLICK_ACTION,
    LOCAL_CREDENTIAL_FILE,
    CREDENTIAL_PARSE_ERROR,
    CREDENTIAL_MISSING,
    parseServiceAccount,
    resolveServiceAccount,
    createFailSafeMessaging,
};
