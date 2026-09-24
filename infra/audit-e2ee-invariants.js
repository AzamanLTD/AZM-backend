// §r40.1 P1-L — CI audit gate for the E2EE server-blind architecture.
// The proof suites (__tests__/e2ee-*.test.js) verify BEHAVIOR against real
// PostgreSQL; this script verifies STRUCTURE that the suites cannot: that the
// wire format the production schema defines can never carry private key
// material, and that the feature is fail-closed out of the box. Run in CI
// after the overlay installers, before the test suites. It is static —
// no database, no secrets, fast.
const fs = require('fs');
const path = require('path');

const failures = [];
const fail = (msg) => failures.push(msg);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 1. The E2EE Prisma models must have NO columns whose name can carry private
//    key material. Server-blind is a data-model property, not just a runtime
//    one: a migration that adds a "*secret*" / "*private*" column to the E2EE
//    surface re-introduces a breach surface that no behavioral test notices
//    (the server simply never writes it yet). Fail the build instead.
const schema = read('prisma/schema.prisma');
const e2eeBlockRe = /^model (E2EE\w+) \{([^}]*)\}/gm;
let m;
while ((m = e2eeBlockRe.exec(schema)) !== null) {
    const [, model, body] = m;
    if (/private|secret|signature_key|signing_key/i.test(body)) {
        fail(`prisma model ${model} mentions private/secret column material — the server-blind architecture stores PUBLIC keys only (see docs/e2ee-protocol.md §server-blind)`);
    }
}

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
console.log('E2EE invariant audit passed: server-blind schema, default-off gate, exact fingerprints, pairwise-only conversation surface.');
