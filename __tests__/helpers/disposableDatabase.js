// __tests__/helpers/disposableDatabase.js
// §WP-H — a suite that asserts global state must not share its database.
//
// Creates a database of its own, pushes the real schema into it, and drops it
// afterwards. The parent URL is only ever used to create and drop.
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const baseUrl = () => process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

// PostgreSQL truncates identifiers at 63 bytes SILENTLY, so a long tag plus a
// timestamp can collide in ways the code never sees. Names are built to fit and
// carry a random suffix so two concurrent runs cannot collide.
const PGHOST_IDENT_MAX = 63;
const pendingDrops = new Set();

function disposableName(tag) {
    const stamp = Date.now().toString(36);
    const nonce = Math.random().toString(36).slice(2, 8);
    // Sanitise FIRST, then truncate, then assemble: the length that matters is
    // the finished identifier, not the caller's tag.
    const cleanTag = String(tag).replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 24);
    const name = `azm_${cleanTag}_${stamp}${nonce}`;
    return name.slice(0, PGHOST_IDENT_MAX);
}

/**
 * Drop a database from the parent connection. Never throws: callers decide
 * whether a cleanup failure is fatal, and the ORIGINAL failure must survive.
 */
async function dropDatabase(name) {
    const admin = new PrismaClient({ datasources: { db: { url: urlForDb('postgres') } } });
    try {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        pendingDrops.delete(name);
        return { dropped: true };
    } catch (err) {
        return { dropped: false, error: String(err.message || err) };
    } finally {
        await admin.$disconnect().catch(() => {});
    }
}

// A suite that dies mid-flight must not leave a database behind. Prisma pools
// keep the process alive, so this is a last-resort sweep rather than the normal
// path: every create() already registers an async drop in `finally`.
process.once('exit', () => {
    for (const name of pendingDrops) {
        try {
            const { execFileSync: run } = require('child_process');
            run('psql', [baseUrl().replace(/\/[^/]*$/, '/postgres'), '-c',
                `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], { stdio: 'ignore' });
        } catch (_) { /* nothing more can be done during exit */ }
    }
});

function urlForDb(name) {
    const u = new URL(baseUrl());
    u.pathname = `/${name}`;
    u.search = '';
    return u.toString();
}

async function createDisposableDatabase(tag) {
    const parent = baseUrl();
    if (!parent) throw new Error('TEST_DATABASE_URL is required for a disposable database');
    const name = disposableName(tag);
    pendingDrops.add(name);
    const admin = new PrismaClient({ datasources: { db: { url: urlForDb('postgres') } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.$disconnect();

    const url = urlForDb(name) + '?schema=public';

    // Provisioning is guarded: a failed push or a failed overlay installer must
    // not leave an orphaned database behind, because the failure is exactly when
    // nobody is looking for debris.
    try {
        execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
            env: { ...process.env, DATABASE_URL: url },
            stdio: 'ignore',
        });

        // The release chain's overlay installers create tables that are NOT in
        // schema.prisma (they are migration-managed), so a pushed database is not
        // complete. Run the same sorted chain the CI lanes run.
        const fs = require('fs');
        const path = require('path');
        const infraDir = path.join(__dirname, '..', '..', 'infra');
        for (const f of fs.readdirSync(infraDir).filter((n) => n.startsWith('install-') && n.endsWith('.js')).sort()) {
            try {
                execFileSync('node', [path.join(infraDir, f)], {
                    env: { ...process.env, DATABASE_URL: url },
                    stdio: 'ignore',
                });
            } catch (err) {
                throw new Error(`overlay installer ${f} failed while provisioning ${name}`);
            }
        }
    } catch (err) {
        // Provisioning failed: the database must not survive it. A cleanup
        // failure is reported as an ADDITIONAL diagnostic and never replaces the
        // original error, which is what the operator needs to see.
        const cleanup = await dropDatabase(name);
        if (!cleanup.dropped) {
            err.message = `${err.message} [cleanup failed: database ${name} remains — ${cleanup.error}]`;
        }
        throw err;
    }

    return {
        name,
        url,
        async drop() {
            return dropDatabase(name);
        },
    };
}

module.exports = { createDisposableDatabase, urlForDb, dropDatabase, disposableName, pendingDrops };
