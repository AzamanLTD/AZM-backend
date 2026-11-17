#!/usr/bin/env node
'use strict';

// =============================================================================
// §WP-I — install + backfill the provider-observation claim.
//
// The claim table is new, so observations consumed BEFORE this release have no
// row. Backfilling them is not "insert every event": a FiatProviderEvent can be
// recorded before any money moves, and treating one as an economic use would
// wrongly block a deposit that never settled.
//
// What is treated as evidence of an economic use:
//   * CUSTOMER_DEPOSIT — a TransactionHistory DEPOSIT row with status COMPLETED
//     and metadata.settlementExternalRef, which is the exact provider reference
//     the settlement committed with. Nothing else about the deposit is inferred.
//   * TREASURY_WITNESS — an existing ProviderSettlementWitness, whose reference
//     comes from its own requestParams, then its stored provider response.
// A reference claimed by BOTH is a historical cross-path collision: it is NOT
// given to a winner. It is reported for operator review and left unclaimed.
//
// Idempotent: ON CONFLICT DO NOTHING, and re-running reports zero new claims.
// Never run this against production from here; it is wired into `npm run release`
// and executed by the operator's release process.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const SQL_FILE = path.join(__dirname, 'sql', 'provider-observation-claim.sql');

function referenceFromWitness(row) {
    const params = row.requestParams && typeof row.requestParams === 'object' ? row.requestParams : {};
    for (const candidate of [params.id, params.reference, params.externalref]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const raw = row.rawResponse;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            for (const candidate of [parsed.externalref, parsed.reference, parsed.transactionid, parsed?.data?.transactionid]) {
                if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
            }
        } catch (_) { /* not JSON: no reference to derive */ }
    }
    return null;
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const prisma = new PrismaClient();
    const report = { installed: false, deposits: 0, witnesses: 0, quarantined: 0, collisions: [], skipped: { deposits: 0, witnesses: 0, nonMoolreProvider: 0 } };
    try {
        if (!dryRun) {
            const sql = fs.readFileSync(SQL_FILE, 'utf8');
            // Prisma's raw executor is one statement per call; the overlay is a
            // small DDL script, so split on the statement terminator and run each.
            const statements = sql
                .split(';')
                .map((q) => q.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
                .filter(Boolean);
            for (const statement of statements) await prisma.$executeRawUnsafe(statement);
            report.installed = true;
        }

        // ── settled customer deposits ───────────────────────────────────────
        const deposits = await prisma.$queryRawUnsafe(`
            SELECT "id", "metadata"->>'settlementExternalRef' AS ref, COALESCE("metadata"->>'provider', '') AS provider
            FROM "TransactionHistory"
            WHERE "type" IN ('DEPOSIT_FIAT', 'DEPOSIT_CRYPTO')
              AND "status" = 'COMPLETED'
              AND COALESCE("metadata"->>'settlementExternalRef', '') <> ''
        `);
        const depositByKey = new Map();
        for (const d of deposits) {
            const ref = String(d.ref || '').trim();
            if (!ref) { report.skipped.deposits += 1; continue; }
            // GENUINE MOOLRE ONLY. A settlement reference on an unrelated
            // provider's deposit (or one with no provider marker at all) is not
            // a Moolre collection observation, so it must not be pre-claimed
            // under the Moolre canonical identity. Skipped rows are counted and
            // named in the report, never silently dropped.
            if (String(d.provider || '').trim().toLowerCase() !== 'moolre') {
                report.skipped.nonMoolreProvider += 1;
                continue;
            }
            depositByKey.set(`moolre|collection|${ref}`, d.id);
        }

        // ── existing treasury witnesses ─────────────────────────────────────
        const witnesses = await prisma.providerSettlementWitness.findMany({
            select: { openingDedupKey: true, requestParams: true, rawResponse: true, provider: true },
        });
        const witnessByKey = new Map();
        for (const w of witnesses) {
            if (String(w.provider || '').trim().toLowerCase() !== 'moolre') {
                report.skipped.nonMoolreProvider += 1;
                continue;
            }
            const ref = referenceFromWitness(w);
            if (!ref) { report.skipped.witnesses += 1; continue; }
            witnessByKey.set(`moolre|collection|${ref}`, w.openingDedupKey);
        }

        // ── collisions: same reference used economically in BOTH ways ────────
        for (const [key, depositId] of depositByKey) {
            if (witnessByKey.has(key)) {
                report.collisions.push({
                    observationKey: key,
                    depositId,
                    openingDedupKey: witnessByKey.get(key),
                    action: 'QUARANTINED: neither path may consume it; operator review required',
                });
                depositByKey.delete(key);
                witnessByKey.delete(key);
            }
        }

        // A collision that is merely REPORTED is still consumable: with no row
        // for the key, whichever path runs next would happily claim it and the
        // second economic use would proceed. So the collision is quarantined —
        // a claim row with no legitimate owner (claimedByRef NULL) — which makes
        // BOTH paths fail closed until an operator resolves the history.
        for (const collision of report.collisions) {
            if (dryRun) continue;
            const n = await prisma.$executeRawUnsafe(
                `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                 VALUES (gen_random_uuid()::text,$1,'QUARANTINE',NULL,'moolre',NULL, now(), now())
                 ON CONFLICT ("observationKey") DO NOTHING`, collision.observationKey,
            );
            report.quarantined += n;
        }

        if (!dryRun) {
            for (const [key, depositId] of depositByKey) {
                const n = await prisma.$executeRawUnsafe(
                    `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                     VALUES (gen_random_uuid()::text,$1,'CUSTOMER_DEPOSIT',$2,'moolre',NULL, now(), now())
                     ON CONFLICT ("observationKey") DO NOTHING`, key, depositId,
                );
                report.deposits += n;
            }
            for (const [key, openingKey] of witnessByKey) {
                const n = await prisma.$executeRawUnsafe(
                    `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                     VALUES (gen_random_uuid()::text,$1,'TREASURY_WITNESS',$2,'moolre',NULL, now(), now())
                     ON CONFLICT ("observationKey") DO NOTHING`, key, openingKey,
                );
                report.witnesses += n;
            }
        }

        console.log(`[provider-observation-claim] installed=${report.installed} dryRun=${dryRun} quarantined=${report.quarantined} `
            + `depositClaims=${report.deposits} witnessClaims=${report.witnesses} `
            + `skipped(deposits=${report.skipped.deposits},witnesses=${report.skipped.witnesses},nonMoolreProvider=${report.skipped.nonMoolreProvider})`);
        if (report.collisions.length) {
            console.error(`[provider-observation-claim] ${report.collisions.length} HISTORICAL CROSS-PATH COLLISION(S) — `
                + 'left unclaimed for operator review:');
            for (const c of report.collisions) console.error('  ', JSON.stringify(c));
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => { console.error('[provider-observation-claim] FAILED:', e.message); process.exit(1); });
}

module.exports = { referenceFromWitness };
