// __tests__/r15j-payout-provider-ownership.test.js
// =============================================================================
// r15 follow-up (audit P0) — payout provider OWNERSHIP and the status contract
//
// THE DEFECT: disbursement runs through PaymentFailoverService (moolre → mtn),
// but the ACTUAL provider that accepted a dispatch was never durably recorded,
// and the reconciliation status contract could not distinguish
// "authoritative absence" (reference not found on this rail) from "unresolved".
// The old contract answered BOTH as PENDING: with Moolre primary, a payout
// that had failed over to MTN could NEVER be resolved, because Moolre's
// "reference not found" → PENDING meant MTN was never asked.
//
// This suite proves the ownership contract end-to-end at the unit level:
//   • the failover-tag ↔ canonical-identity mapping and ownership read/write
//   • PaymentFailoverService.getTransferStatus: a KNOWN owner is queried ONLY
//     — its transport failure is UNRESOLVED, never permission to ask another
//     rail; its NOT_FOUND is returned as authoritative absence
//   • the no-hint path (genuinely-unknown ownership) continues the search on
//     NOT_FOUND and aggregates all-rails-absent to NOT_FOUND
//   • the recovery probe only re-admits a rail on an AUTHORITATIVE answer
//     (a bare non-throw is no longer proof of recovery)
//
// The real-PostgreSQL end-to-end (worker + finance settlement) lives in
// r15k-reconciliation-provider-ownership.test.js.
// =============================================================================

const {
    canonicalProviderName,
    failoverTagFromCanonical,
    readPayoutOwner,
    persistPayoutOwnership,
    resolvePayoutOwner,
    TAG_TO_CANONICAL,
    CANONICAL_TO_TAG,
} = require('../services/payoutProviderOwnership');
const { PaymentFailoverService } = require('../src/services/paymentFailoverService');

// A provider whose status answer is fully controllable per call.
function makeStatusProvider(name) {
    return {
        name,
        _calls: [],
        _answers: [],   // popped per call: { status } | Error
        newReferenceId: () => `ref-${name}`,
        async initiateTransfer(payload) {
            this._calls.push({ method: 'initiateTransfer', payload });
            return { referenceId: payload.referenceId, status: 'PENDING', amount: payload.amountGhs };
        },
        async getTransferStatus(referenceId) {
            this._calls.push({ method: 'getTransferStatus', referenceId });
            const next = this._answers.shift();
            if (next instanceof Error) throw next;
            return { status: next?.status ?? 'PENDING', referenceId, ...(next?.extra || {}) };
        },
    };
}

describe('r15 follow-up P0: payout provider ownership — identity mapping and canonical read/write', () => {
    test('failover tag ↔ canonical identity mapping is exact and frozen', () => {
        expect(TAG_TO_CANONICAL.moolre).toBe('MOOLRE_DISBURSEMENT');
        expect(TAG_TO_CANONICAL.mtn).toBe('MTN_MOMO_DISBURSEMENT');
        expect(canonicalProviderName('moolre')).toBe('MOOLRE_DISBURSEMENT');
        expect(canonicalProviderName('mtn')).toBe('MTN_MOMO_DISBURSEMENT');
        expect(canonicalProviderName('bogus')).toBeNull();
        expect(canonicalProviderName(null)).toBeNull();

        expect(failoverTagFromCanonical('MOOLRE_DISBURSEMENT')).toBe('moolre');
        expect(failoverTagFromCanonical('MOOLRE')).toBe('moolre'); // legacy alias
        expect(failoverTagFromCanonical('MTN_MOMO_DISBURSEMENT')).toBe('mtn');
        expect(failoverTagFromCanonical('MTN_MOMO')).toBe('mtn'); // legacy alias
        expect(failoverTagFromCanonical('nope')).toBeNull();
        expect(Object.isFrozen(CANONICAL_TO_TAG)).toBe(true);
        expect(Object.isFrozen(TAG_TO_CANONICAL)).toBe(true);
    });

    test('readPayoutOwner: persisted owner read off the canonical row; legacy rows read as unknown ownership', () => {
        expect(readPayoutOwner({ metadata: { payoutProvider: 'mtn' } }))
            .toEqual({ tag: 'mtn', canonicalName: 'MTN_MOMO_DISBURSEMENT' });
        expect(readPayoutOwner({ metadata: { payoutProvider: 'moolre' } }))
            .toEqual({ tag: 'moolre', canonicalName: 'MOOLRE_DISBURSEMENT' });
        // Legacy row: no payoutProvider — genuinely-unknown ownership.
        expect(readPayoutOwner({ metadata: { provider: 'MOOLRE', outcome: 'UNKNOWN_OUTCOME' } })).toBeNull();
        expect(readPayoutOwner({ metadata: null })).toBeNull();
        expect(readPayoutOwner(null)).toBeNull();
        // A recorded owner that cannot be mapped is STILL an owner — never
        // silently falls back to cross-provider polling.
        const unmapped = readPayoutOwner({ metadata: { payoutProvider: 'telecel' } });
        expect(unmapped.unmapped).toBe(true);
        expect(unmapped.tag).toBe('telecel');
        expect(unmapped.canonicalName).toBeNull();
    });

    test('persistPayoutOwnership: single guarded jsonb merge on the canonical row, ownership patch well-formed', async () => {
        const statements = [];
        const prisma = {
            $executeRawUnsafe: async (sql, ...args) => {
                statements.push({ sql, args });
                return 1;
            },
        };

        const before = Date.now();
        const res = await persistPayoutOwnership(prisma, {
            reference: 'OWN-REF-1',
            failoverTag: 'mtn',
            intendedProvider: 'MOOLRE_DISBURSEMENT',
            providerRef: '31830714',
        });
        expect(res.rowsUpdated).toBe(1);
        expect(statements).toHaveLength(1);
        // Only PENDING/PROCESSING rows are touched — terminal rows keep their
        // settled history.
        expect(statements[0].sql).toContain(`"status" IN ('PENDING', 'FROZEN_DISPUTE')`);
        expect(statements[0].sql).toContain(`'{}'::jsonb`);
        expect(statements[0].args[1]).toBe('OWN-REF-1');

        const patch = JSON.parse(statements[0].args[0]);
        expect(patch.payoutProvider).toBe('mtn');
        expect(patch.payoutProviderName).toBe('MTN_MOMO_DISBURSEMENT');
        expect(patch.intendedProvider).toBe('MOOLRE_DISBURSEMENT');
        expect(patch.ownershipProviderRef).toBe('31830714');
        expect(new Date(patch.ownershipRecordedAt).getTime()).toBeGreaterThanOrEqual(before);
    });

    test('persistPayoutOwnership: fails closed on unknown tag / missing reference (never writes a bogus owner)', async () => {
        const prisma = { $executeRawUnsafe: async () => 1 };
        await expect(persistPayoutOwnership(prisma, { reference: 'r', failoverTag: 'bogus' }))
            .rejects.toThrow(/unknown failover tag/);
        await expect(persistPayoutOwnership(prisma, { reference: '', failoverTag: 'mtn' }))
            .rejects.toThrow(/reference is required/);
        await expect(persistPayoutOwnership(prisma, { reference: 'r' }))
            .rejects.toThrow(/failoverTag is required/);
    });

    // r15 hardening (audit P0 2026-09-20): on an ACCEPTED dispatch, zero rows
    // updated is NEVER a harmless warn — every zero-row case fails closed or
    // resolves as a provable idempotent replay.
    test('persistPayoutOwnership: FAILS CLOSED when no canonical row carries the reference (never a warn)', async () => {
        const prisma = {
            $executeRawUnsafe: async () => 0,
            $queryRawUnsafe: async () => [],
        };
        await expect(persistPayoutOwnership(prisma, { reference: 'GONE-REF', failoverTag: 'moolre' }))
            .rejects.toMatchObject({ code: 'OWNERSHIP_PERSIST_FAILED' });
    });

    test('persistPayoutOwnership: FAILS CLOSED when the canonical row is terminal without recorded ownership', async () => {
        const prisma = {
            $executeRawUnsafe: async () => 0,
            $queryRawUnsafe: async () => [{ id: 'tx-1', status: 'COMPLETED', owner: null }],
        };
        await expect(persistPayoutOwnership(prisma, { reference: 'DONE-REF', failoverTag: 'mtn' }))
            .rejects.toMatchObject({ code: 'OWNERSHIP_PERSIST_FAILED' });
    });

    test('persistPayoutOwnership: same-owner replay is an idempotent success (settlement raced the bookkeeping)', async () => {
        const prisma = {
            $executeRawUnsafe: async () => 0,
            $queryRawUnsafe: async () => [{ id: 'tx-1', status: 'COMPLETED', owner: 'mtn' }],
        };
        const res = await persistPayoutOwnership(prisma, { reference: 'REPLAY-REF', failoverTag: 'mtn' });
        expect(res.rowsUpdated).toBe(0);
        expect(res.idempotent).toBe(true);
        expect(res.owner).toEqual({ tag: 'mtn', canonicalName: 'MTN_MOMO_DISBURSEMENT' });
    });

    test('persistPayoutOwnership: a DIFFERENT durable owner FAILS CLOSED first-writer-wins — the first owner survives, a conflict record is appended, and OwnershipConflictError is thrown', async () => {
        const statements = [];
        const prisma = {
            $executeRawUnsafe: async (sql, ...args) => {
                statements.push({ sql, args });
                return 0; // guarded write refused: a different owner is present
            },
            $queryRawUnsafe: async () => [{ id: 'tx-1', status: 'PENDING', owner: 'moolre' }],
        };
        const promise = persistPayoutOwnership(prisma, {
            reference: 'CLASH-REF',
            failoverTag: 'mtn',
            providerRef: '77',
        });
        await expect(promise).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });

        // The ONLY write attempt after the refusal is the conflict-record
        // append — the ownership keys were never overwritten.
        expect(statements).toHaveLength(2);
        expect(statements[0].sql).toContain(`'payoutProvider' = $3`);
        expect(statements[1].sql).toContain('payoutProviderConflicts');
        const conflictEntries = JSON.parse(statements[1].args[0]);
        expect(conflictEntries[0]).toMatchObject({
            requestedTag: 'mtn',
            requestedProvider: 'MTN_MOMO_DISBURSEMENT',
            recordedOwner: 'moolre',
        });
    });

    test('persistPayoutOwnership: the guarded first write is single-statement and conflict-safe (unowned or same-owner only)', async () => {
        const statements = [];
        const prisma = {
            $executeRawUnsafe: async (sql, ...args) => {
                statements.push({ sql, args });
                return 1;
            },
        };
        await persistPayoutOwnership(prisma, { reference: 'FIRST-REF', failoverTag: 'moolre' });
        expect(statements).toHaveLength(1);
        // The ownership patch may ONLY land on an unowned row or a row owned
        // by the SAME provider — never last-writer-wins.
        expect(statements[0].sql).toContain(`->>'payoutProvider' IS NULL`);
        expect(statements[0].sql).toContain(`->>'payoutProvider' = $3`);
        expect(statements[0].args[2]).toBe('moolre');
    });

    // ── resolvePayoutOwner: ownership resolution with evidence recovery ────
    test('resolvePayoutOwner: canonical metadata wins (OWNED); no evidence query needed', async () => {
        const prisma = { fiatProviderEvent: { findMany: jest.fn() } };
        const res = await resolvePayoutOwner(prisma, { txHash: 'R1', metadata: { payoutProvider: 'mtn' } });
        expect(res).toEqual({ status: 'OWNED', owner: { tag: 'mtn', canonicalName: 'MTN_MOMO_DISBURSEMENT' } });
        expect(prisma.fiatProviderEvent.findMany).not.toHaveBeenCalled();
    });

    test('resolvePayoutOwner: RECOVERED from a single unique durable dispatch observation (canonical write failed)', async () => {
        const prisma = {
            fiatProviderEvent: {
                findMany: async () => [
                    { provider: 'MTN_MOMO_DISBURSEMENT', dedupKey: 'event:payout-dispatch:MTN_MOMO_DISBURSEMENT:R2' },
                ],
            },
        };
        const res = await resolvePayoutOwner(prisma, { txHash: 'R2', metadata: {} });
        expect(res).toEqual({ status: 'RECOVERED', owner: { tag: 'mtn', canonicalName: 'MTN_MOMO_DISBURSEMENT' } });
    });

    test('resolvePayoutOwner: CONFLICT — two different providers hold dispatch evidence for one reference; NEVER guess', async () => {
        const prisma = {
            fiatProviderEvent: {
                findMany: async () => [
                    { provider: 'MOOLRE_DISBURSEMENT', dedupKey: 'event:payout-dispatch:MOOLRE_DISBURSEMENT:R3' },
                    { provider: 'MTN_MOMO_DISBURSEMENT', dedupKey: 'event:payout-dispatch:MTN_MOMO_DISBURSEMENT:R3' },
                ],
            },
        };
        const res = await resolvePayoutOwner(prisma, { txHash: 'R3', metadata: null });
        expect(res.status).toBe('CONFLICT');
        expect(res.owners.map(o => o.canonicalName).sort()).toEqual(['MOOLRE_DISBURSEMENT', 'MTN_MOMO_DISBURSEMENT']);
    });

    test('resolvePayoutOwner: UNKNOWN when neither metadata nor admissible evidence exists (legacy cross-rail search)', async () => {
        const queries = [];
        const prisma = {
            fiatProviderEvent: {
                // The DB filter is what excludes non-dispatch observations
                // (status polls, treasury events) and non-canonical provider
                // names; this mock records the filter and models its result.
                findMany: async (args) => {
                    queries.push(args);
                    return [];
                },
            },
        };
        const res = await resolvePayoutOwner(prisma, { txHash: 'R4' });
        expect(res).toEqual({ status: 'UNKNOWN' });
        expect(queries).toHaveLength(1);
        expect(queries[0].where.dedupKey.startsWith).toBe('event:payout-dispatch:');
        expect(queries[0].where.direction).toBe('OUTBOUND');
        expect([...queries[0].where.provider.in]).toEqual(['MOOLRE_DISBURSEMENT', 'MTN_MOMO_DISBURSEMENT']);
    });

    test('resolvePayoutOwner: no reference — UNKNOWN', async () => {
        const prisma = { fiatProviderEvent: { findMany: jest.fn() } };
        expect(await resolvePayoutOwner(prisma, {})).toEqual({ status: 'UNKNOWN' });
    });
});

describe('r15 follow-up P0: PaymentFailoverService.getTransferStatus — the ownership contract', () => {
    test('KNOWN OWNER answers: the owner is queried ONLY and its concrete answer returns with its identity', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        mtn._answers.push({ status: 'SUCCESSFUL' });
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('FAIL-OVER-REF', 'mtn');
        expect(res.status).toBe('SUCCESSFUL');
        expect(res._provider).toBe('mtn');
        expect(mtn._calls.filter(c => c.method === 'getTransferStatus')).toHaveLength(1);
        expect(moolre._calls).toHaveLength(0); // the non-owner rail is NEVER asked
    });

    test('KNOWN OWNER transport failure → UNRESOLVED, NEVER a fall-through to the other rail', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        mtn._answers.push(Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' }));
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('FAIL-OVER-REF-DOWN', 'mtn');
        expect(res.status).toBe('UNKNOWN');
        expect(res.unresolved).toBe(true);
        expect(res.unresolvedReason).toBe('PROVIDER_STATUS_ERROR');
        expect(res._provider).toBe('mtn');
        expect(moolre._calls).toHaveLength(0); // THE cross-provider mis-settlement guard
        expect(mtn._calls.filter(c => c.method === 'getTransferStatus')).toHaveLength(1);
    });

    test('KNOWN OWNER answers UNKNOWN (application-level uncertainty) → UNRESOLVED, NEVER a fall-through', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        mtn._answers.push({ status: 'UNKNOWN' });
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('FAIL-OVER-REF-AMBIG', 'mtn');
        expect(res.status).toBe('UNKNOWN');
        expect(res.unresolved).toBe(true);
        expect(res.unresolvedReason).toBe('PROVIDER_RETURNED_UNKNOWN');
        expect(moolre._calls).toHaveLength(0);
    });

    test('KNOWN OWNER answers NOT_FOUND → authoritative absence is RETURNED (the caller parks it as an ownership conflict), never a fall-through', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        mtn._answers.push({ status: 'NOT_FOUND' });
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('FAIL-OVER-REF-ABSENT', 'mtn');
        expect(res.status).toBe('NOT_FOUND');
        expect(res._provider).toBe('mtn');
        expect(moolre._calls).toHaveLength(0);
    });

    test('unmapped owner hint → fail-closed UNRESOLVED (a recorded owner is never ignored in favor of cross-provider polling)', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('FAIL-OVER-REF-UNMAPPED', 'telecel');
        expect(res.status).toBe('UNKNOWN');
        expect(res.unresolved).toBe(true);
        expect(res.unresolvedReason).toBe('UNKNOWN_PROVIDER_HINT');
        expect(moolre._calls).toHaveLength(0);
        expect(mtn._calls).toHaveLength(0);
    });

    test('NO HINT (legacy/unknown ownership): absence on the primary rail CONTINUES the search and the secondary rail resolves it', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        moolre._answers.push({ status: 'NOT_FOUND' });   // Moolre: never saw this reference
        mtn._answers.push({ status: 'SUCCESSFUL' });      // MTN owns it
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('LEGACY-REF');
        expect(res.status).toBe('SUCCESSFUL');
        expect(res._provider).toBe('mtn');
        expect(moolre._calls.filter(c => c.method === 'getTransferStatus')).toHaveLength(1);
        expect(mtn._calls.filter(c => c.method === 'getTransferStatus')).toHaveLength(1);
    });

    test('NO HINT: unresolved on one rail also continues (unknown ownership means every rail is a candidate)', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        moolre._answers.push(Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }));
        mtn._answers.push({ status: 'PENDING' });
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('LEGACY-REF-2');
        expect(res.status).toBe('PENDING');
        expect(res._provider).toBe('mtn');
    });

    test('NO HINT: EVERY rail authoritatively answers absence → aggregate NOT_FOUND (durable evidence, not a vague UNKNOWN)', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        moolre._answers.push({ status: 'NOT_FOUND' });
        mtn._answers.push({ status: 'NOT_FOUND' });
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('LEGACY-REF-3');
        expect(res.status).toBe('NOT_FOUND');
        expect(res.allProvidersPolled).toBe(true);
    });

    test('NO HINT: one rail absent, the other unresolved → UNKNOWN (honest "cannot answer", absence must be unanimous to be the aggregate)', async () => {
        const moolre = makeStatusProvider('moolre');
        const mtn = makeStatusProvider('mtn');
        moolre._answers.push({ status: 'NOT_FOUND' });
        mtn._answers.push(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        const svc = new PaymentFailoverService({ primary: moolre, secondary: mtn });

        const res = await svc.getTransferStatus('LEGACY-REF-4');
        expect(res.status).toBe('UNKNOWN');
    });
});

describe('r15 follow-up P1: the recovery probe re-admits a rail ONLY on an authoritative answer', () => {
    function makeProbeService({ probeAnswer }) {
        const provider = makeStatusProvider('moolre');
        provider._answers.push(probeAnswer);
        const secondary = makeStatusProvider('mtn');
        const svc = new PaymentFailoverService({ primary: provider, secondary, probeMinIntervalMs: 0 });
        // _attemptRecoveryProbe receives the routed provider ENTRY
        // ({ name, instance, priority }), not the raw adapter.
        const entry = svc.providers.find(p => p.name === 'moolre');
        const failPrimary = () => {
            provider.initiateTransfer = async () => {
                const err = new Error('moolre down');
                err.providerOutcome = 'NOT_DISPATCHED';
                throw err;
            };
        };
        const healPrimary = () => {
            provider.initiateTransfer = async (payload) =>
                ({ referenceId: payload.referenceId, status: 'PENDING', amount: payload.amountGhs });
        };
        // 3 provider failures inside the health window push the primary past
        // FAILURE_THRESHOLD (3) so it is skipped in routing.
        const degradePrimary = async () => {
            failPrimary();
            for (let i = 0; i < 3; i += 1) {
                const r = await svc.initiateTransfer({ referenceId: `warm-${i}`, amountGhs: 5, recipientPhone: '024' });
                expect(r._provider).toBe('mtn');
            }
        };
        return { provider, secondary, svc, entry, failPrimary, healPrimary, degradePrimary };
    }

    test('probe answered by a bare UNKNOWN response → NOT proof of recovery: the rail stays out of routing', async () => {
        const { secondary, svc, entry, degradePrimary } = makeProbeService({ probeAnswer: { status: 'UNKNOWN' } });
        await degradePrimary();

        // The status contract probe answers UNKNOWN — not authoritative.
        const ok = await svc._attemptRecoveryProbe(entry);
        expect(ok).toBe(false);

        // The primary remains skipped: the next payout routes to the
        // secondary ONLY.
        const p = await svc.initiateTransfer({ referenceId: 'p2', amountGhs: 5, recipientPhone: '024' });
        expect(p._provider).toBe('mtn');
        expect(secondary._calls.filter(c => c.method === 'initiateTransfer')).toHaveLength(4); // 3 warmups + p2
    });

    test('probe answered by a concrete status (even NOT_FOUND for the synthetic reference) → authoritative: rail re-admitted', async () => {
        const { provider, svc, entry, degradePrimary, healPrimary } = makeProbeService({ probeAnswer: { status: 'NOT_FOUND' } });
        await degradePrimary();

        const ok = await svc._attemptRecoveryProbe(entry);
        expect(ok).toBe(true);

        // Primary is healthy again — it receives the next payout.
        healPrimary();
        const res = await svc.initiateTransfer({ referenceId: 'p2', amountGhs: 5, recipientPhone: '024' });
        expect(res._provider).toBe('moolre');
    });
});
