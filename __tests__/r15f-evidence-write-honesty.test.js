// __tests__/r15f-evidence-write-honesty.test.js
// =============================================================================
// r15 R15-F — the evidence write must never silently fail.
//
// THE DEFECT: recordReconciliationException call sites in failing financial
// paths swallowed their OWN write failures with .catch(() => null). When the
// evidence write failed, the anomaly it was flagging left NO durable record
// and NO log — the recon team's entire queue went dark exactly when needed.
//
// THE FIX (pinned here): recordReconciliationExceptionLoud never throws (the
// user-facing response stays honest and calm), but a failed evidence write is
// (1) logged with the stable RECONCILIATION_EVIDENCE_WRITE_FAILED marker and
// (2) escalated through the caller's admin channel.
// =============================================================================

jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));

const logger = require('../src/config/logger');
const { recordReconciliationExceptionLoud } = require('../services/reconciliationExceptionService');

const ARGS = {
    entityType: 'TRANSACTION',
    entityId: 'ref-r15f',
    reference: 'ref-r15f',
    reason: 'DISPATCH_OUTCOME_UNKNOWN_NO_REFUND',
    details: { provider: 'MOOLRE' },
};

afterEach(() => jest.clearAllMocks());

test('success passes straight through to the durable write', async () => {
    const wrote = { id: 1 };
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([wrote]) };
    const escalate = jest.fn();

    const out = await recordReconciliationExceptionLoud(prisma, ARGS, { escalate });

    expect(out).toBe(wrote);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(escalate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
});

test('a FAILED evidence write resolves null, logs the marker, escalates, and NEVER throws', async () => {
    const prisma = {
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('db connection lost mid-incident')),
    };
    const escalate = jest.fn();

    const out = await recordReconciliationExceptionLoud(prisma, ARGS, { escalate });

    expect(out).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.error.mock.calls[0];
    expect(payload.marker).toBe('RECONCILIATION_EVIDENCE_WRITE_FAILED');
    expect(payload.entityId).toBe('ref-r15f');
    expect(payload.reason).toBe('DISPATCH_OUTCOME_UNKNOWN_NO_REFUND');
    expect(String(msg)).toMatch(/NO durable record/i);
    expect(escalate).toHaveBeenCalledTimes(1);
});

test('a failing escalate hook never breaks the (already failing) path', async () => {
    const prisma = {
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('write failed')),
    };
    const escalate = jest.fn().mockRejectedValue(new Error('socket dead'));

    await expect(recordReconciliationExceptionLoud(prisma, ARGS, { escalate })).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
});

test('without an escalate hook the error log remains the floor', async () => {
    const prisma = {
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('write failed')),
    };
    await expect(recordReconciliationExceptionLoud(prisma, ARGS)).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
});

test('the write never throws into an already-failing caller (swallow-by-design, but loud)', async () => {
    const prisma = {
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('boom')),
    };
    // A caller in a catch block must be able to await this bare.
    await expect(recordReconciliationExceptionLoud(prisma, ARGS, {})).resolves.not.toThrow();
});
