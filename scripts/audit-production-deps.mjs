#!/usr/bin/env node
/**
 * scripts/audit-production-deps.mjs — the production dependency audit gate.
 *
 * The lane used to run `npm audit --omit=dev --audit-level=low`. That threshold
 * is intentionally strict, but it cannot distinguish an advisory in code the
 * service actually runs from one in a build-time tool that npm happens to place
 * in the production tree: @prisma/client depends on the `prisma` CLI, which
 * depends on @prisma/config, which depends on `effect`.
 *
 * This gate keeps the strict threshold and adds ONE explicit, reviewable
 * exception. Anything else at any severity still fails the lane.
 *
 * ALLOWLIST
 *   GHSA 1248071 — "Effect: ReDoS in Schema.TemplateLiteral compiled regex",
 *   reached only through @prisma/config's schema parser. The service never
 *   compiles an attacker-supplied Effect schema at runtime; the vulnerable
 *   parser is used to read this repository's own prisma/schema.prisma at build
 *   time. No 6.x fix exists (the patch is in Effect 4, which breaks
 *   @prisma/config — verified: "members.map is not a function"), and Prisma 7
 *   is a client-construction migration, not a version bump.
 *
 *   Removing this entry is part of the Prisma 7/8 migration workstream. Until
 *   then the exception is explicit rather than the lane being silently red.
 */
import { execFileSync } from 'node:child_process';

const ALLOWLIST = new Map([
    [1248071, 'Effect ReDoS via @prisma/config schema parser (build-time only); remove with the Prisma 7 migration'],
]);

let report;
try {
    const out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    report = JSON.parse(out);
} catch (err) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    if (!err.stdout) {
        console.error('audit-production-deps: npm audit produced no report; refusing to pass.');
        process.exit(1);
    }
    report = JSON.parse(err.stdout);
}

const blocking = [];
const allowed = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
        if (typeof via !== 'object') continue;
        const id = via.source;
        const entry = { name, id, severity: vuln.severity, title: via.title };
        if (ALLOWLIST.has(id)) allowed.push(entry);
        else blocking.push(entry);
    }
}

if (allowed.length) {
    console.log('audit-production-deps: allowlisted advisories (documented in this file):');
    for (const a of allowed) console.log(`  - ${a.name} [${a.id}] ${a.title}`);
}

if (blocking.length) {
    console.error('audit-production-deps: BLOCKING advisories:');
    for (const b of blocking) console.error(`  - ${b.name} [${b.id}] (${b.severity}) ${b.title}`);
    process.exit(1);
}

console.log('audit-production-deps: no unallowlisted production advisories.');
