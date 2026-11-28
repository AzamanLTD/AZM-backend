// =============================================================================
// §r42.2 — RELEASE-DECLARATION RECOVERY EVIDENCE CHECKER
//
// `failurePolicy: 'RELEASE'` and `releaseOn4xx: true` both let the middleware
// delete an idempotency claim. That is only safe when the economy and the claim
// commit in the SAME database transaction (so a released claim means nothing was
// committed), or when the operation is genuinely convergent (nothing durable and
// money-relevant survives a retry). The middleware cannot know which route it is
// guarding, so the safety argument has to be carried by evidence attached to
// EACH declaration.
//
// This module mechanises that argument instead of trusting a route-name list:
//
//   • it finds every idempotency declaration in the route sources and derives a
//     stable key (the declaration's `identity`, else "<METHOD> <path>");
//   • every releasing declaration must have an evidence entry for that exact
//     key, or the check fails (a new RELEASE route cannot land silently);
//   • an ATOMIC_CLAIM_COMMIT entry must point at a commit site whose code is
//     conditional on the claim still being IN_PROGRESS, and that site must sit
//     AFTER the transaction anchor in the same file (positional proof that the
//     commit happens inside the transaction, not beside it);
//   • every entry must cite a test that actually exists by name, so the
//     behavioural half of the proof cannot rot into a comment;
//   • an evidence entry with no matching declaration is STALE and fails, so the
//     registry cannot accumulate unverified claims.
//
// Any problem is returned, never thrown, so the invariant test can report the
// whole matrix at once.
// =============================================================================

const RELEASING_POLICIES = Object.freeze(['RELEASE_5XX', 'RELEASE_4XX_ONLY']);

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

const ROUTE_MOUNT_RE = /router\.(get|post|put|patch|delete)\s*\(/g;

/**
 * Nearest `router.<verb>('<path>'` for a declaration. Routes put the mount and
 * the idempotency call on one line, on adjacent lines, or with the path pushed
 * to the following line, so the window runs from well before the declaration to
 * the end of its own line and the LAST mount in it wins.
 */
function _mountFor(source, declStart, declLineEnd) {
    const from = Math.max(0, declStart - 1500);
    const window = source.slice(from, declLineEnd);
    let best = null;
    let m;
    ROUTE_MOUNT_RE.lastIndex = 0;
    while ((m = ROUTE_MOUNT_RE.exec(window)) !== null) {
        best = { verb: m[1].toUpperCase(), at: m.index + m[0].length };
    }
    if (!best) return null;
    const tail = source.slice(from + best.at, from + best.at + 400);
    const pathMatch = tail.match(/^\s*(['"])((?:\\.|(?!\1).)*)\1/);
    return pathMatch ? { method: best.verb, path: pathMatch[2] } : null;
}

/** Policy flags carried by one declaration object literal. */
function _policyOf(objectText) {
    const failure = /failurePolicy\s*:\s*['"]RELEASE['"]/.test(objectText);
    const on4xx = /releaseOn4xx\s*:\s*true/.test(objectText);
    if (failure && on4xx) return 'RELEASE_5XX';
    if (failure) return 'RELEASE_5XX';
    if (on4xx) return 'RELEASE_4XX_ONLY';
    return null;
}

/**
 * Every idempotency declaration in one route source file.
 * @returns {Array<{file,key,method,path,policy,line,identity}>}
 */
function parseDeclarations(source, file) {
    const out = [];
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes('idempotency({')) continue;
        // Declaration object text: from this line to the line that closes `})`.
        let objectText = '';
        let j = i;
        while (j < lines.length && j < i + 12) {
            objectText += `${lines[j]}\n`;
            if (/}\)/.test(lines[j]) && j >= i) break;
            j += 1;
        }
        const policy = _policyOf(objectText);
        if (!policy) continue;

        const offset = lines.slice(0, i).join('\n').length;
        const lineEnd = offset + lines[i].length;
        const mount = _mountFor(source, offset, lineEnd) || { method: '?', path: '?' };
        const identityMatch = objectText.match(/identity\s*:\s*['"]([^'"]+)['"]/);
        const identity = identityMatch ? identityMatch[1] : null;
        out.push({
            file,
            method: mount.method,
            path: mount.path,
            line: i + 1,
            policy,
            identity,
            key: identity || `${mount.method} ${mount.path}`,
        });
    }
    return out;
}

function _readOrNull(readFile, file) {
    try {
        return collapse(readFile(file));
    } catch (_) {
        return null;
    }
}

function _testExists(readFile, citation) {
    const src = _readOrNull(readFile, citation.file);
    if (src == null) return false;
    return src.includes(collapse(citation.name));
}

/**
 * @param {object} args
 * @param {Array} args.declarations parsed declarations (all files)
 * @param {Array} args.evidence registry entries
 * @param {Function} args.readFile (relative path) => file contents
 * @param {number} [args.maxAnchorDistance] positional window for the commit proof
 */
function checkReleaseEvidence({ declarations, evidence, readFile, maxAnchorDistance = 6000 }) {
    const problems = [];
    const matrix = [];
    const used = new Set();

    for (const decl of declarations) {
        const matches = evidence.filter((e) => e.file === decl.file && e.key === decl.key);
        if (matches.length === 0) {
            problems.push({
                code: 'UNREGISTERED_RELEASE_DECLARATION',
                file: decl.file,
                line: decl.line,
                key: decl.key,
                policy: decl.policy,
                message: `${decl.policy} declaration "${decl.key}" in ${decl.file}:${decl.line} has no recovery evidence.`,
            });
            continue;
        }
        if (matches.length > 1) {
            problems.push({
                code: 'DUPLICATE_EVIDENCE',
                file: decl.file,
                key: decl.key,
                message: `${decl.file} has ${matches.length} evidence entries for "${decl.key}".`,
            });
        }
        const entry = matches[0];
        used.add(entry);

        if (!RELEASING_POLICIES.includes(entry.policy)) {
            problems.push({ code: 'EVIDENCE_POLICY_INVALID', file: entry.file, key: entry.key, message: `Unknown policy "${entry.policy}".` });
        }
        if (entry.policy !== decl.policy) {
            problems.push({
                code: 'EVIDENCE_POLICY_MISMATCH',
                file: entry.file,
                key: entry.key,
                message: `Registry says ${entry.policy} but the declaration is ${decl.policy}.`,
            });
        }

        if (entry.kind === 'ATOMIC_CLAIM_COMMIT') {
            const cite = entry.commitSite || {};
            const src = _readOrNull(readFile, cite.file);
            if (src == null) {
                problems.push({ code: 'COMMIT_SITE_FILE_MISSING', file: entry.file, key: entry.key, message: `commitSite file not readable: ${cite.file}` });
            } else {
                const anchor = collapse(cite.anchor);
                const pattern = collapse(cite.pattern);
                const iAnchor = anchor ? src.indexOf(anchor) : -1;
                const iPattern = pattern ? src.indexOf(pattern, iAnchor >= 0 ? iAnchor : 0) : -1;
                if (!pattern || iPattern === -1) {
                    problems.push({
                        code: 'COMMIT_SITE_PATTERN_MISSING', file: entry.file, key: entry.key,
                        message: `No commit site matching "${pattern}" in ${cite.file}.`,
                    });
                } else if (!anchor || iAnchor === -1) {
                    problems.push({
                        code: 'COMMIT_SITE_ANCHOR_MISSING', file: entry.file, key: entry.key,
                        message: `Transaction anchor not found in ${cite.file}: "${anchor}".`,
                    });
                } else if (iPattern < iAnchor) {
                    problems.push({
                        code: 'COMMIT_SITE_OUTSIDE_TRANSACTION', file: entry.file, key: entry.key,
                        message: `Commit site precedes its transaction anchor in ${cite.file}: the claim is not committed by the transaction.`,
                    });
                } else if (iPattern - iAnchor > maxAnchorDistance) {
                    problems.push({
                        code: 'COMMIT_SITE_TOO_FAR_FROM_ANCHOR', file: entry.file, key: entry.key,
                        message: `Commit site is more than ${maxAnchorDistance} characters after the anchor in ${cite.file}; the positional proof is not credible.`,
                    });
                } else if (/commitOperation\(tx/.test(pattern)) {
                    // Helper form: the IN_PROGRESS conditional and the count!==1 abort
                    // live in the helper, so the proof is that the helper still has them.
                    const helper = _readOrNull(readFile, 'middleware/idempotency.js');
                    if (helper == null
                        || !helper.includes(collapse("where: { id: operation.id, status: OPERATION_IN_PROGRESS }"))
                        || !helper.includes(collapse('if (committed.count !== 1)'))) {
                        problems.push({
                            code: 'COMMIT_HELPER_GUARD_MISSING', file: entry.file, key: entry.key,
                            message: 'commitOperation() no longer commits conditionally on IN_PROGRESS.',
                        });
                    }
                } else if (!/status:\s*'IN_PROGRESS'/.test(pattern)) {
                    problems.push({
                        code: 'COMMIT_SITE_NOT_CONDITIONAL', file: entry.file, key: entry.key,
                        message: 'Commit site is not conditional on the claim still being IN_PROGRESS.',
                    });
                }
            }
        } else if (entry.kind !== 'STATE_CONVERGENT') {
            problems.push({
                code: 'EVIDENCE_KIND_INVALID', file: entry.file, key: entry.key,
                message: `Unknown evidence kind "${entry.kind}".`,
            });
        }

        if (!entry.test || !_testExists(readFile, entry.test)) {
            problems.push({
                code: 'CITED_TEST_MISSING', file: entry.file, key: entry.key,
                message: `Cited test not found: ${entry.test && entry.test.file} :: ${entry.test && entry.test.name}`,
            });
        }

        matrix.push({
            key: entry.key,
            file: entry.file,
            policy: decl.policy,
            kind: entry.kind,
            commitSite: entry.commitSite ? `${entry.commitSite.file}` : null,
            test: entry.test ? `${entry.test.file} :: ${entry.test.name}` : null,
            note: entry.note || null,
        });
    }

    for (const entry of evidence) {
        if (!used.has(entry)) {
            problems.push({
                code: 'STALE_EVIDENCE', file: entry.file, key: entry.key,
                message: `Evidence for "${entry.key}" has no matching declaration in ${entry.file}.`,
            });
        }
    }

    return { ok: problems.length === 0, problems, matrix };
}

module.exports = { parseDeclarations, checkReleaseEvidence, RELEASING_POLICIES, collapse };
