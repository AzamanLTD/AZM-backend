/**
 * WP-D packaging invariant: the durable TOTP claim table must be installed by
 * the ACTUAL release path, not only by a Prisma migration.
 *
 * Why this exists: `npm run release` (the Render preDeployCommand) runs overlay
 * installers and never `prisma migrate deploy`. WP-D first shipped the claim
 * table as a migration only, which left the table uncreated in every deployed
 * environment and would have made app-unlock TOTP fail closed (503) there. A
 * static, database-free contract test keeps that from regressing silently: the
 * release chain, the CI installer sequence and the DDL itself are all asserted.
 *
 * This suite needs no database and no environment variable; it reads the
 * repository's own configuration and SQL. It never skips.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = 'infra/install-app-unlock-totp-claim.js';
const MIGRATION = 'prisma/migrations/20261110200000_app_unlock_totp_claim/migration.sql';
const CI_WORKFLOW = '.github/workflows/test.yml';

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Installer script names, in execution order, from the `release` npm script. */
function releaseChain() {
    const scripts = JSON.parse(read('package.json')).scripts || {};
    const release = scripts.release || '';
    return [...release.matchAll(/node\s+(infra\/install-[A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
}

/** Installer script names, in file order, from the CI workflow YAML. */
function ciChain() {
    return [...read(CI_WORKFLOW).matchAll(/node\s+(infra\/install-[A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
}

/** Normalise a DDL statement for comparison: collapse whitespace, trim. */
function normalise(sql) {
    // Collapse runs of whitespace only: parentheses and commas keep their
    // surrounding spaces so the DDL shape stays readable in failures.
    return sql.replace(/\s+/g, ' ').trim();
}

/** CREATE statements from a SQL file, comments stripped. */
function createStatements(sql) {
    const body = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    return body
        .split(';')
        .map((s) => s.trim())
        .filter((s) => /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)/i.test(s));
}

/** The installer's own STATEMENTS array, evaluated from source. */
function installerStatements() {
    const src = read(INSTALLER);
    const match = src.match(/const STATEMENTS = \[([\s\S]*?)\n\];/);
    if (!match) throw new Error('installer STATEMENTS array not found');
    // eslint-disable-next-line no-new-func
    return new Function(`return [${match[1]}\n];`)();
}

describe('WP-D packaging — the claim table is installed by the real release path', () => {
    test('the installer exists and is a runnable node script', () => {
        const src = read(INSTALLER);
        expect(src).toMatch(/new PrismaClient\(\)/);
        expect(src).toMatch(/\$executeRawUnsafe/);
        // A silent success on failure would defeat the point of the installer.
        expect(src).toMatch(/process\.exitCode = 1/);
    });

    test('npm run release runs the installer before application startup', () => {
        const chain = releaseChain();
        expect(chain).toContain(INSTALLER);
        const scripts = JSON.parse(read('package.json')).scripts;
        // The release chain is the Render preDeployCommand: before `npm start`.
        expect(scripts.release).toBeTruthy();
        expect(scripts.start).toBe('node server.js');
        // Nothing in the release script may start the server itself.
        expect(scripts.release).not.toMatch(/node\s+server\.js/);
    });

    test('the release chain keeps its existing order and appends only the new installer', () => {
        const chain = releaseChain();
        // Every previously wired installer is still present, in the same order.
        const expectedExact = [
            'infra/install-prod-drift-remediation.js',
            'infra/install-susu-overlay.js',
            'infra/install-transaction-quote-overlay.js',
            'infra/install-business-os-overlay.js',
            'infra/install-inventory-restock-overlay.js',
            'infra/install-reservation-capacity-overlay.js',
            'infra/install-saved-service-accounts-overlay.js',
            'infra/install-e2ee-server-blind-overlay.js',
            'infra/install-phase3-overlay.js',
            'infra/install-payout-reconciliation-infra.js',
            'infra/install-fiat-liquidity-overlay.js',
            'infra/install-model-b-settlement-overlay.js',
            'infra/install-ghs-wallet-overlay.js',
            'infra/install-native-ghs-settlement-overlay.js',
            'infra/install-native-ghs-withdrawal-overlay.js',
            'infra/install-r16-execution-identity-overlay.js',
            'infra/install-r19-smartroute-execution-snapshot-overlay.js',
            'infra/install-r42-idempotency-overlay.js',
            'infra/install-payment-requests-overlay.js',
            'infra/install-business-price-overlay.js',
            'infra/install-marketplace-discovery-overlay.js',
            'infra/install-business-offered-categories-overlay.js',
        ];
        expect(chain.slice(0, expectedExact.length)).toEqual(expectedExact);
        // The addition is appended; the auth installer runs last, after every
        // financial overlay has run.
        expect(chain).toEqual([...expectedExact, INSTALLER]);
        expect(chain.filter((s) => s === INSTALLER)).toHaveLength(1);
    });

    test('the CI installer sequence runs the installer too', () => {
        const chain = ciChain();
        expect(chain).toContain(INSTALLER);
        // CI applies the claim table before the first jest invocation.
        const src = read(CI_WORKFLOW);
        const installerAt = src.indexOf(`node ${INSTALLER}`);
        const firstJestAt = src.indexOf('npx jest');
        const fullSuiteAt = src.indexOf('- name: Run tests');
        expect(installerAt).toBeGreaterThan(0);
        expect(firstJestAt).toBeGreaterThan(installerAt);
        expect(fullSuiteAt).toBeGreaterThan(installerAt);
    });

    test('WP-E role provisioning is NOT in the ordinary release or CI sequence', () => {
        // Deliberate: the authority owner/operator roles are created by a
        // separately controlled DBA process. The application release credential
        // must never gain CREATEROLE or authority-table ownership.
        const authorityInstaller = 'infra/install-authority-activation-roles.js';
        expect(releaseChain()).not.toContain(authorityInstaller);
        expect(ciChain()).not.toContain(authorityInstaller);
    });

    test('installer DDL and migration DDL agree exactly', () => {
        const fromMigration = createStatements(read(MIGRATION)).map(normalise).sort();
        const fromInstaller = createStatements(installerStatements().join(';\n')).map(normalise).sort();
        expect(fromMigration.length).toBe(3);
        expect(fromInstaller).toEqual(fromMigration);
    });

    test('the migration and the installer both assert the unique claim index', () => {
        const migration = normalise(read(MIGRATION));
        const installer = normalise(installerStatements().join(';\n'));
        for (const sql of [migration, installer]) {
            expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_step_key" ON "AppUnlockTotpClaim"\s*\(\s*"userId",\s*"step"\s*\)/);
            expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "AppUnlockTotpClaim_userId_createdAt_idx" ON "AppUnlockTotpClaim"\s*\(\s*"userId",\s*"createdAt"\s*\)/);
            expect(sql).toMatch(/CONSTRAINT "AppUnlockTotpClaim_pkey" PRIMARY KEY\s*\(\s*"id"\s*\)/);
        }
    });

    test('the installer cannot reset replay state', () => {
        // CREATE ... IF NOT EXISTS only. A DELETE/TRUNCATE/DROP would re-open an
        // already-accepted time-step after a deploy or a restart.
        const sql = installerStatements().join('\n');
        expect(sql).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|INDEX))\b/i);
        expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
        // Every statement is guarded, so a second run is a no-op.
        for (const statement of installerStatements()) {
            expect(statement).toMatch(/IF NOT EXISTS/i);
        }
    });

    test('the Prisma model matches the installed shape', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.match(/model AppUnlockTotpClaim \{([\s\S]*?)\n\}/);
        expect(model).toBeTruthy();
        const body = model[1];
        expect(body).toMatch(/\bid\s+String\s+@id\b/);
        expect(body).toMatch(/\buserId\s+Int\b/);
        expect(body).toMatch(/\bstep\s+Int\b/);
        expect(body).toMatch(/\bcreatedAt\s+DateTime\b/);
        expect(body).toMatch(/@@unique\(\[userId, step\]\)/);
        expect(body).toMatch(/@@index\(\[userId, createdAt\]\)/);
    });
});
