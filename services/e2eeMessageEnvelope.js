'use strict';

// services/e2eeMessageEnvelope.js
// =============================================================================
// Shared E2EE ciphertext-envelope authority for BOTH message send paths
// (REST POST /:conversationId/messages and the WebSocket message:send bridge).
// One authority means the two paths can never disagree about what an encrypted
// message is, what is persisted, and when plaintext must be refused.
//
// Envelope wire format (PROTOCOL.md §6):
//   { version: 2, header: {v, dh, pn, n}, cipherText: <b64>, envelopeId: <uuid> }
// =============================================================================

const e2ee = require('./e2eeService');

const MAX_CIPHERTEXT_B64 = 8000; // base64 of ciphertext||tag; far above any chat message

function _envelopeError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

/**
 * Strict envelope validation. Returns the normalized envelope object or throws
 * a status/code-tagged error. Never coerces, never defaults.
 */
async function validateEnvelope(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee envelope must be an object.');
    }
    if (payload.version !== e2ee.PROTOCOL_VERSION) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', `Unsupported e2ee envelope version (expected ${e2ee.PROTOCOL_VERSION}).`);
    }
    const header = payload.header;
    if (!header || typeof header !== 'object' || header.v !== e2ee.PROTOCOL_VERSION
        || typeof header.dh !== 'string' || !Number.isSafeInteger(header.pn) || header.pn < 0
        || !Number.isSafeInteger(header.n) || header.n < 0) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'Malformed e2ee ratchet header.');
    }
    if (Buffer.from(header.dh, 'base64').length !== 32) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee header dh must be a base64 X25519 public key.');
    }
    if (typeof payload.cipherText !== 'string' || !payload.cipherText) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee cipherText is required.');
    }
    const raw = Buffer.from(payload.cipherText, 'base64');
    if (raw.length < 17 || raw.length > 4000) { // 16B Poly1305 tag minimum + ciphertext
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee cipherText has an invalid length.');
    }
    if (payload.cipherText.length > MAX_CIPHERTEXT_B64) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee cipherText too large.');
    }
    const envelopeId = payload.envelopeId;
    if (typeof envelopeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envelopeId)) {
        throw _envelopeError(400, 'E2EE_BAD_ENVELOPE', 'e2ee envelopeId must be a client-generated UUID.');
    }
    return { version: payload.version, header, cipherText: payload.cipherText, envelopeId };
}

/**
 * True when EVERY participant of a PERSONAL conversation has a registered
 * E2EE bundle. In that state plaintext TEXT messages are refused (fail-closed
 * policy, PROTOCOL.md §7): the client MUST send the ciphertext envelope.
 */
async function personalConversationIsEncrypted(prisma, conv) {
    if (!conv || conv.type !== 'PERSONAL') return false;
    const participantIds = conv.participants.map(p => p.id);
    if (participantIds.length !== 2) return false;
    const bundles = await prisma.e2EEPreKeyBundle.findMany({
        where: { userId: { in: participantIds } },
        select: { userId: true },
    });
    return bundles.length === 2;
}

/**
 * The Prisma data object for an encrypted message. content is the EMPTY
 * STRING — the plaintext never reaches the server, and an auditor of the
 * database sees no message text (PROTOCOL.md §6).
 */
function buildEncryptedMessageData({ conversationId, senderId, envelope, extras = {} }) {
    return {
        conversationId,
        senderId,
        messageType: 'TEXT',
        content: '', // never plaintext (r40 envelope contract)
        isEncrypted: true,
        e2eeVersion: envelope.version,
        e2eeHeader: envelope.header,
        e2eeCipherText: envelope.cipherText,
        e2eeEnvelopeId: envelope.envelopeId,
        ...extras,
    };
}

/**
 * Replay anchor: a retry of the same send (timeout, reconnect, reload) reuses
 * the same envelopeId and receives the ORIGINAL message row back — it can
 * never create a duplicate delivery (unique index on e2eeEnvelopeId).
 */
async function findExistingByEnvelopeId(prisma, envelopeId) {
    const existing = await prisma.message.findUnique({
        where: { e2eeEnvelopeId: envelopeId },
        include: { sender: { select: { id: true, username: true } } },
    });
    return existing || null;
}

/**
 * Response serialization for encrypted messages: NEVER emits content (which
 * is empty anyway) and always carries the envelope so the recipient's client
 * can decrypt with its device-held ratchet state.
 */
function envelopeToWire(message) {
    return {
        isEncrypted: true,
        e2ee: {
            version: message.e2eeVersion,
            header: message.e2eeHeader,
            cipherText: message.e2eeCipherText,
            envelopeId: message.e2eeEnvelopeId,
        },
    };
}

module.exports = {
    validateEnvelope,
    personalConversationIsEncrypted,
    buildEncryptedMessageData,
    findExistingByEnvelopeId,
    envelopeToWire,
    MAX_CIPHERTEXT_B64,
};
