// =============================================================================
// §r42.2 — EVERY RELEASING IDEMPOTENCY DECLARATION MUST CARRY RECOVERY EVIDENCE
//
// `failurePolicy: 'RELEASE'` and `releaseOn4xx: true` are permission to delete an
// idempotency claim. That is safe only if the economy and the claim commit in the
// SAME transaction, or if the operation moves no money. Until now that argument
// lived in route comments, so a new route could opt into releasing a claim with
// nothing proving it is safe.
//
// This suite fails the build unless, for EVERY releasing declaration:
//   1. a registry entry exists for that exact file + key,
//   2. its policy matches the declaration,
//   3. an ATOMIC_CLAIM_COMMIT entry's commit expression really sits after its
//      transaction anchor in the named file (searched from the anchor, so a
//      second identical statement elsewhere cannot satisfy it),
//   4. that expression is conditional on the claim still being IN_PROGRESS, or
//      goes through commitOperation(), whose guard is re-checked in the helper,
//   5. the cited test exists by name in the cited file,
//      and no entry is stale (an entry with no declaration fails too).
//
// The negative tests below drive the same checker with synthetic inputs to prove
// that an unregistered RELEASE route, a commit site outside its transaction, a
// commit site that is not conditional, and a missing cited test all FAIL. The
// guard is the checker, not an allowlist.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { parseDeclarations, checkReleaseEvidence } = require('../src/idempotency/releaseEvidenceChecker');
const { RELEASE_EVIDENCE } = require('../src/idempotency/releaseEvidence');

const ROOT = path.resolve(__dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const routeFiles = () =>
    fs.readdirSync(path.join(ROOT, 'routes'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => `routes/${f}`)
        .sort();

const declarations = () => routeFiles().flatMap((f) => parseDeclarations(readFile(f), f));

describe('release-declaration recovery evidence', () => {
    test('the sweep finds every releasing declaration in the route tree', () => {
        const decls = declarations();
        // Sanity floor: this many declarations exist today. If the parser silently
        // stops matching (someone renames the middleware options), this fails
        // instead of the invariant passing vacuously.
        expect(decls.length).toBeGreaterThanOrEqual(27);
        expect(decls.every((d) => !d.key.includes('?'))).toBe(true);
        const releasing = decls.filter((d) => d.policy === 'RELEASE_5XX');
        const on4xxOnly = decls.filter((d) => d.policy === 'RELEASE_4XX_ONLY');
        expect(releasing.length).toBe(19);
        expect(on4xxOnly.length).toBe(8);
    });

    test('every releasing declaration has matching, source-proven evidence', () => {
        const { ok, problems, matrix } = checkReleaseEvidence({
            declarations: declarations(),
            evidence: RELEASE_EVIDENCE,
            readFile,
        });
        if (!ok) {
            // Print the whole set: a partial report hides the second regression.
            // eslint-disable-next-line no-console
            console.error(JSON.stringify(problems, null, 2));
        }
        expect(problems).toEqual([]);
        expect(ok).toBe(true);
        expect(matrix).toHaveLength(declarations().length);
        expect(matrix.every((row) => row.test)).toBe(true);
    });

    test('an unregistered RELEASE route fails the invariant', () => {
        const synthetic = parseDeclarations(
            `router.post('/brand-new-payout', protect, idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true }), ctrl.pay);`,
            'routes/syntheticRoutes.js'
        );
        expect(synthetic).toHaveLength(1);
        expect(synthetic[0].key).toBe('POST /brand-new-payout');

        const { ok, problems } = checkReleaseEvidence({
            declarations: synthetic,
            evidence: RELEASE_EVIDENCE,
            readFile,
        });
        expect(ok).toBe(false);
        expect(problems.map((p) => p.code)).toContain('UNREGISTERED_RELEASE_DECLARATION');
    });

    test('a commit site that sits before its transaction anchor cannot satisfy the proof', () => {
        const synthetic = parseDeclarations(
            `router.post('/probe', protect, idempotency({ failurePolicy: 'RELEASE' }), ctrl.probe);`,
            'routes/withdrawalRoutes.js'
        ).filter((d) => d.key === 'POST /probe');
        const files = {
            'routes/withdrawalRoutes.js': readFile('routes/withdrawalRoutes.js'),
        };
        const evidence = [{
            file: 'routes/withdrawalRoutes.js',
            key: 'POST /probe',
            policy: 'RELEASE_5XX',
            kind: 'ATOMIC_CLAIM_COMMIT',
            commitSite: {
                file: 'services/fakeService.js',
                // Anchor appears AFTER the commit in this fixture: the positional
                // proof must reject it rather than accept "the string exists".
                anchor: 'AFTER_THE_COMMIT',
                pattern: "await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
            },
            test: { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R5.' },
        }];
        const localRead = (rel) => {
            if (rel === 'services/fakeService.js') {
                return [
                    "await tx.financialOperation.updateMany({ where: { id: operation.id, status: 'IN_PROGRESS' },",
                    'AFTER_THE_COMMIT',
                ].join('\n');
            }
            return files[rel] != null ? files[rel] : readFile(rel);
        };
        const { ok, problems } = checkReleaseEvidence({
            declarations: synthetic, evidence, readFile: localRead,
        });
        expect(ok).toBe(false);
        // The search runs FROM the anchor, so a statement that only exists before
        // the transaction opens is not found at all. Either code is a refusal; the
        // point of the case is that "the string exists somewhere in the file" is
        // not accepted as proof.
        expect(problems.map((p) => p.code)).toEqual(
            expect.arrayContaining([expect.stringMatching(/COMMIT_SITE_(PATTERN_MISSING|OUTSIDE_TRANSACTION)/)])
        );
    });

    test('a commit that is not conditional on IN_PROGRESS fails', () => {
        const synthetic = parseDeclarations(
            `router.post('/probe2', protect, idempotency({ failurePolicy: 'RELEASE' }), ctrl.probe);`,
            'routes/probeRoutes.js'
        );
        const evidence = [{
            file: 'routes/probeRoutes.js',
            key: 'POST /probe2',
            policy: 'RELEASE_5XX',
            kind: 'ATOMIC_CLAIM_COMMIT',
            commitSite: {
                file: 'services/unconditionalService.js',
                anchor: 'BEGIN_TX',
                pattern: 'await tx.financialOperation.update({ where: { id: operation.id },',
            },
            test: { file: '__tests__/r42-shared-idempotency-authority.pg.test.js', name: 'R5.' },
        }];
        const localRead = (rel) => {
            if (rel === 'routes/probeRoutes.js') return `router.post('/probe2', protect, idempotency({ failurePolicy: 'RELEASE' }), ctrl.probe);`;
            if (rel === 'services/unconditionalService.js') {
                return ['BEGIN_TX', 'await tx.financialOperation.update({ where: { id: operation.id },'].join('\n');
            }
            return readFile(rel);
        };
        const { ok, problems } = checkReleaseEvidence({ declarations: synthetic, evidence, readFile: localRead });
        expect(ok).toBe(false);
        expect(problems.map((p) => p.code)).toContain('COMMIT_SITE_NOT_CONDITIONAL');
    });

    test('a cited test that no longer exists fails', () => {
        const synthetic = parseDeclarations(
            `router.post('/probe3', protect, idempotency({ failurePolicy: 'RELEASE' }), ctrl.probe);`,
            'routes/probe3Routes.js'
        );
        const realEntry = RELEASE_EVIDENCE.find((e) => e.file === 'routes/marketplaceRoutes.js');
        const evidence = [{
            ...realEntry,
            file: 'routes/probe3Routes.js',
            key: 'POST /probe3',
            test: { file: '__tests__/transit-booking-identity.pg.test.js', name: 'T3. this test name does not exist' },
        }];
        const localRead = (rel) =>
            (rel === 'routes/probe3Routes.js'
                ? `router.post('/probe3', protect, idempotency({ failurePolicy: 'RELEASE' }), ctrl.probe);`
                : readFile(rel));
        const { ok, problems } = checkReleaseEvidence({ declarations: synthetic, evidence, readFile: localRead });
        expect(ok).toBe(false);
        expect(problems.map((p) => p.code)).toContain('CITED_TEST_MISSING');
    });

    test('stale evidence with no declaration fails too', () => {
        const { ok, problems } = checkReleaseEvidence({
            declarations: [],
            evidence: RELEASE_EVIDENCE,
            readFile,
        });
        expect(ok).toBe(false);
        expect(problems.every((p) => p.code === 'STALE_EVIDENCE')).toBe(true);
    });
});
