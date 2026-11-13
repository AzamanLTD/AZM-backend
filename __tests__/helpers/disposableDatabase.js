// __tests__/helpers/disposableDatabase.js
// §WP-H — a suite that asserts global state must not share its database.
//
// Creates a database of its own, pushes the real schema into it, and drops it
// afterwards. The parent URL is only ever used to create and drop.
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const baseUrl = () => process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

function urlForDb(name) {
    const u = new URL(baseUrl());
    u.pathname = `/${name}`;
    u.search = '';
    return u.toString();
}

async function createDisposableDatabase(tag) {
    const parent = baseUrl();
    if (!parent) throw new Error('TEST_DATABASE_URL is required for a disposable database');
    const name = `azm_${tag}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.toLowerCase();
    const admin = new PrismaClient({ datasources: { db: { url: urlForDb('postgres') } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await admin.$disconnect();

    const url = urlForDb(name) + '?schema=public';
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

    return {
        name,
        url,
        async drop() {
            const a = new PrismaClient({ datasources: { db: { url: urlForDb('postgres') } } });
            try {
                await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            } finally {
                await a.$disconnect();
            }
        },
    };
}

module.exports = { createDisposableDatabase, urlForDb };
