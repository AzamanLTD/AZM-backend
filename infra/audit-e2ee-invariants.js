// §r40.1 P1-L — CI audit gate for the E2EE server-blind architecture.
// The proof suites (__tests__/e2ee-*.test.js) verify BEHAVIOR against real
// PostgreSQL; this script verifies STRUCTURE that the suites cannot: that the
// wire format the production schema defines can never carry private key
// material, and that the feature is fail-closed out of the box. Run in CI
// after the overlay installers, before the test suites. It is static —
// no database, no secrets, fast.
//
// §r40.2 (audit finding 1): the original matcher `/^model (E2EE\w+) \{/` was
// case-sensitive and never matched the real models (E2eeDevice /
// E2eeOneTimePreKey), so check #1 was VACUOUS — it passed without inspecting
// anything. The schema inspection is now a pure exported function so the
// jest suite __tests__/e2ee-invariant-audit.test.js proves BOTH directions:
// the real schema is inspected, and failure fixtures containing private /
// secret columns are rejected. It is also guarded against a future vacuous
// pass: if no E2EE model blocks are found, the audit FAILS instead of
// silently proving nothing.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A Prisma model block: `model <Name> { ... }` with the closing brace on its
// own line (standard formatting). Body capture is lazy so nested braces in
// attributes cannot swallow the next model.
const PRISMA_MODEL_RE = /^model\s+([\w$]+)\s*\{([\s\S]*?)^\}/gm;

// E2EE models are recognized case-insensitively on the model NAME only, so a
// capitalization refactor (E2eeDevice <-> E2EEDevice <-> E2ee_device) can
// never silently opt a model out of this audit.
const E2EE_MODEL_NAME_RE = /^e2ee/i;

// Column names that can carry private/secret material. Scanned against field
// declarations only — comments are stripped first, so an explanatory
// "// private key never uploaded" note is not a false positive.
const PRIVATE_COLUMN_RE = /\b(?:[\w$]*)?(?:private|secret)([\w$]*)\b|signature_key|signing_key/i;

// Strip // line comments and /* block comments */ from a Prisma body.
const stripComments = (body) =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// Inspect a prisma/schema.prisma source for the E2EE server-blind invariants.
// Pure function: returns { models, failures }.
function auditPrismaE2eeModels(schemaText) {
    const failures = [];
    const models = [];
    let m;
    PRISMA_MODEL_RE.lastIndex = 0;
    while ((m = PRISMA_MODEL_RE.exec(schemaText)) !== null) {
        const [, model, rawBody] = m;
        if (!E2EE_MODEL_NAME_RE.test(model)) continue;
        const body = stripComments(rawBody);
        models.push(model);
        if (PRIVATE_COLUMN_RE.test(body)) {
            failures.push(`prisma model ${model} mentions private/secret column material — the server-blind architecture stores PUBLIC keys only (see docs/e2ee-protocol.md §server-blind)`);
        }
        // The E2EE surface is base64 strings / ints / bools / dates. A Bytes
        // column is how a raw private key would most plausibly sneak in.
        if (/^\s*[\w$]+\s+Bytes\b/m.test(body)) {
            failures.push(`prisma model ${model} declares a Bytes column — the E2EE surface is base64-string public material only, binary columns are not part of the wire format`);
        }
    }
    // Guard against the original vacuous pass: zero matched models means the
    // matcher and the schema have drifted apart again — that is a FAILED
    // audit, not a green one.
    if (models.length === 0) {
        failures.push('prisma/schema.prisma: no E2EE model blocks were found to inspect — the audit must observe at least one E2EE model or it proves nothing (naming drift?)');
    }
    return { models, failures };
}

module.exports = { auditPrismaE2eeModels };

// ---------------------------------------------------------------------------
// CI gate entry point (node infra/audit-e2ee-invariants.js)
// ---------------------------------------------------------------------------
if (require.main === module) {
    const failures = [];
    const fail = (msg) => failures.push(msg);

    // 1. The E2EE Prisma models must have NO columns whose name can carry
    //    private key material. Server-blind is a data-model property, not just
    //    a runtime one: a migration that adds a "*secret*" / "*private*"
    //    column to the E2EE surface re-introduces a breach surface that no
    //    behavioral test notices (the server simply never writes it yet).
    //    Fail the build instead.
    const schemaResult = auditPrismaE2eeModels(read('prisma/schema.prisma'));
    for (const f of schemaResult.failures) fail(f);

    // 2. The E2EE surface must stay DISABLED unless AZM_E2EE_ENABLED=true
    //    (P0-A). The gate lives in routes/e2eeRoutes.js; a refactor that drops
    //    the env check would silently advertise the surface in every deployment.
    const routes = read('routes/e2eeRoutes.js');
    if (!/AZM_E2EE_ENABLED/.test(routes)) {
        fail('routes/e2eeRoutes.js no longer reads AZM_E2EE_ENABLED — the E2EE surface must be disabled by default (P0-A)');
    }
    if (!/String\(process\.env\.AZM_E2EE_ENABLED[^)]*\)\.toLowerCase\(\) === 'true'/.test(routes)) {
        fail("routes/e2eeRoutes.js must gate on the EXACT string 'true' of AZM_E2EE_ENABLED (case-insensitive, no truthy coercion) — a truthy check would enable it for values like 'false'");
    }

    // 3. The restock fingerprint must remain an EXACT-decimal digest (v2) with
    //    the version column that keeps pre-r40 rows replayable. Dropping either
    //    strands legacy operations behind 409s or re-introduces float collisions.
    const restock = read('services/businessOS/inventoryRestockService.js');
    if (!/fingerprintVersion/.test(restock)) {
        fail('inventoryRestockService.js lost fingerprintVersion — v1 (float-normalized) rows must stay replayable against the digest they were committed under (see docs/audit/r40-exact-restock.md)');
    }
    if (!/hasExplicitCost \? suppliedCost\.toString\(\)/.test(restock)) {
        fail('inventoryRestockService.js must fingerprint the EXACT decimal strings (qty.toString()/suppliedCost.toString()), never Number(...) — see docs/audit/r39-exact-money-businessos-boot-hardening.md');
    }

    // 4. The E2EE conversation path must stay pairwise-only (P1-E).
    const convo = read('routes/conversationRoutes.js');
    if (!/E2EE_NOT_PAIRWISE/.test(convo)) {
        fail("routes/conversationRoutes.js must reject E2EE envelopes for non-PERSONAL conversations with code E2EE_NOT_PAIRWISE — the r40 protocol has no group/group-key mechanism (P1-E)");
    }

    if (failures.length) {
        console.error('E2EE invariant audit FAILED:');
        for (const f of failures) console.error('  ✕ ' + f);
        process.exit(1);
    }
    console.log(`E2EE invariant audit passed: server-blind schema (${schemaResult.models.length} models inspected: ${schemaResult.models.join(', ')}), default-off gate, exact fingerprints, pairwise-only conversation surface.`);
}
