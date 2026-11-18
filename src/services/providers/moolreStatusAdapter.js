'use strict';

/**
 * WP-I — Moolre status adapter.
 *
 * Official contract (docs.moolre.com, Payment Status API):
 *   POST https://api.moolre.com/open/transact/status
 *   headers  X-API-USER, X-API-PUBKEY
 *   body     { type: 1, idtype: 1, id: <our external reference>, accountnumber }
 *   response { status, code, message, data: { txstatus, txtype, amount, value,
 *              transactionid, externalref, thirdpartyref, accountnumber, ts } }
 *
 * `data.txstatus` is the transaction status: 1 successful, 0 pending, 2 failed.
 * The top-level `status: 1` only means the API call itself succeeded. A 200 with
 * a top-level success is therefore NOT evidence that money moved, and this
 * adapter never treats it as such.
 *
 * Two adapter rules exist on purpose:
 *   moolre-status-v1              the documented shape above (authoritative).
 *   moolre-status-legacy-observed-v0
 *                                 `state` / `txstatus_label` keys, which appear
 *                                 in no public Moolre document I could find.
 *                                 Retained only so historical fixtures still
 *                                 parse; every witness records which rule ran,
 *                                 and a witness produced by the legacy rule is
 *                                 labelled as undocumented evidence.
 */

const ADAPTER_DOCUMENTED = 'moolre-status-v1';
const ADAPTER_LEGACY = 'moolre-status-legacy-observed-v0';

const SETTLED = 'SETTLED';
const PENDING = 'PENDING';
const FAILED = 'FAILED';
const UNKNOWN = 'UNKNOWN';

/** Documented numeric transaction statuses. Anything outside this map is UNKNOWN. */
const TXSTATUS_MAP = Object.freeze({ 1: SETTLED, 0: PENDING, 2: FAILED });

class MoolreContractError extends Error {
    constructor(code, message, detail = null) {
        super(`[wp-i moolre] ${message}`);
        this.name = 'MoolreContractError';
        this.code = code;
        this.detail = detail;
    }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Transaction-level state from an explicitly documented numeric status. */
function settlementFromTxstatus(txstatus) {
    if (typeof txstatus === 'number' && Object.prototype.hasOwnProperty.call(TXSTATUS_MAP, txstatus)) {
        return TXSTATUS_MAP[txstatus];
    }
    // A numeric status encoded as a string is still the documented field, but an
    // unexpected value is UNKNOWN rather than optimistically settled.
    if (typeof txstatus === 'string' && /^\d+$/.test(txstatus.trim())) {
        const n = Number(txstatus.trim());
        if (Object.prototype.hasOwnProperty.call(TXSTATUS_MAP, n)) return TXSTATUS_MAP[n];
    }
    return UNKNOWN;
}

function legacyStateToSettlement(label) {
    const s = String(label ?? '').trim().toUpperCase();
    if (!s) return UNKNOWN;
    if (['SUCCESS', 'SUCCESSFUL', 'SETTLED', 'COMPLETED', 'PAID', 'FUNDED'].includes(s)) return SETTLED;
    if (['PENDING', 'PROCESSING', 'INITIATED'].includes(s)) return PENDING;
    if (['FAILED', 'DECLINED', 'CANCELLED', 'REVERSED'].includes(s)) return FAILED;
    return UNKNOWN;
}

/**
 * Parse a Moolre status response.
 *
 * @param {object} input
 * @param {number|string} input.httpStatus  HTTP status of the call
 * @param {string} input.rawBody            exact response bytes, retained verbatim
 * @returns {{
 *   adapter: string, transportOk: boolean, settlement: string,
 *   txstatus: number|string|null, data: object|null, digest: string,
 *   reason: string|null
 * }}
 */
function parseMoolreStatusResponse({ httpStatus, rawBody } = {}) {
    const crypto = require('crypto');
    const raw = typeof rawBody === 'string' ? rawBody : '';
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    const base = { adapter: ADAPTER_DOCUMENTED, transportOk: false, settlement: UNKNOWN, txstatus: null, data: null, digest, reason: null };

    const status = Number(httpStatus);
    if (status !== 200) return { ...base, reason: `HTTP_${httpStatus}` };

    let body;
    try {
        body = JSON.parse(raw);
    } catch (_) {
        return { ...base, reason: 'BODY_NOT_JSON' };
    }
    if (!isPlainObject(body)) return { ...base, reason: 'BODY_NOT_OBJECT' };

    // Transport success is the wrapper's own status. It says nothing about money.
    const wrapperOk = Number(body.status) === 1;
    if (!wrapperOk) return { ...base, reason: 'API_STATUS_NOT_SUCCESS' };

    const data = body.data;
    if (!isPlainObject(data)) return { ...base, transportOk: true, reason: 'DATA_MISSING' };

    // Documented shape: numeric txstatus is authoritative.
    if (Object.prototype.hasOwnProperty.call(data, 'txstatus')) {
        const settlement = settlementFromTxstatus(data.txstatus);
        return {
            ...base,
            transportOk: true,
            settlement,
            txstatus: data.txstatus,
            data,
            reason: settlement === SETTLED ? null : `TXSTATUS_${String(data.txstatus)}`,
        };
    }

    // Undocumented historical shape, explicitly labelled.
    const legacyLabel = data.state ?? data.txstatus_label;
    if (legacyLabel !== undefined && legacyLabel !== null) {
        const settlement = legacyStateToSettlement(legacyLabel);
        return {
            adapter: ADAPTER_LEGACY,
            transportOk: true,
            settlement,
            txstatus: null,
            data,
            digest,
            reason: settlement === SETTLED ? 'LEGACY_STATE_SETTLED_UNDOCUMENTED' : `LEGACY_STATE_${String(legacyLabel)}`,
        };
    }

    return { ...base, transportOk: true, data, reason: 'TXSTATUS_MISSING' };
}

/** Fields a witness needs, extracted only from the documented `data` object. */
function extractObservation(data) {
    if (!isPlainObject(data)) throw new MoolreContractError('DATA_MISSING', 'provider response carries no data object');
    const missing = ['externalref', 'accountnumber'].filter((k) => data[k] === undefined || data[k] === null || String(data[k]).trim() === '');
    if (missing.length) {
        throw new MoolreContractError('DATA_INCOMPLETE', `provider response is missing ${missing.join(', ')}`, { missing });
    }
    return {
        externalRef: String(data.externalref).trim(),
        accountNumber: String(data.accountnumber).trim(),
        transactionId: data.transactionid == null ? null : String(data.transactionid).trim(),
        thirdPartyRef: data.thirdpartyref == null ? null : String(data.thirdpartyref).trim(),
        amount: data.amount,
        value: data.value,
        providerTimestamp: data.ts ?? null,
    };
}

module.exports = {
    ADAPTER_DOCUMENTED,
    ADAPTER_LEGACY,
    SETTLED,
    PENDING,
    FAILED,
    UNKNOWN,
    TXSTATUS_MAP,
    MoolreContractError,
    parseMoolreStatusResponse,
    settlementFromTxstatus,
    legacyStateToSettlement,
    extractObservation,
};
