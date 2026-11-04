// __tests__/helpers/testDatabaseGuard.js
// =============================================================================
// TEST-ONLY: refuse to mutate a database that is not provably disposable.
//
// A few suites contain maintenance statements that change rows across a whole
// table (the native-GHS review orphan sweep resolves stale OPEN exception rows).
// Those statements are correct inside a disposable test database and must never
// be reachable anywhere else. Gating the `describe` on TEST_DATABASE_URL is NOT
// enough on its own: it proves that a test URL EXISTS, not that the client is
// connected to it.
//
// This guard answers exactly that question, and fails CLOSED:
//   1. TEST_DATABASE_URL must be set             (the explicit disposable target)
//   2. NODE_ENV must be 'test'                   (this is not a runtime process)
//   3. DATABASE_URL must equal TEST_DATABASE_URL (the client was bound to it)
//   4. the CONNECTED database name must equal the database name in that URL
// If any check fails it throws, and the caller must not execute the statement.
// =============================================================================

/** The database name in a postgres URL, or null when it cannot be read. */
function databaseNameFromUrl(raw) {
    if (!raw) return null;
    try {
        const parsed = new URL(String(raw).trim());
        const name = decodeURIComponent(parsed.pathname || '').replace(/^\//, '');
        return name || null;
    } catch (_) {
        return null;
    }
}

/**
 * Assert that `prisma` is connected to the disposable test database.
 *
 * @param {object} prisma      client exposing $queryRawUnsafe
 * @param {object} [overrides] test seams: { testUrl, databaseUrl, nodeEnv }
 * @returns {Promise<{database: string}>} the verified database name
 * @throws when any of the four conditions is not met
 */
async function assertDisposableTestDatabase(prisma, overrides = {}) {
    const env = process.env;
    const testUrl = String(
        overrides.testUrl !== undefined ? overrides.testUrl : (env.TEST_DATABASE_URL || '')
    ).trim();
    const databaseUrl = String(
        overrides.databaseUrl !== undefined ? overrides.databaseUrl : (env.DATABASE_URL || '')
    ).trim();
    const nodeEnv = overrides.nodeEnv !== undefined ? overrides.nodeEnv : env.NODE_ENV;

    if (!testUrl) {
        throw new Error(
            '[test-db-guard] refusing to run: TEST_DATABASE_URL is not set, so this process cannot prove which database it is connected to.'
        );
    }
    if (nodeEnv !== 'test') {
        throw new Error(
            `[test-db-guard] refusing to run: NODE_ENV is "${nodeEnv}", not "test". A disposable-database maintenance statement may only run inside the test environment.`
        );
    }
    if (!databaseUrl) {
        throw new Error(
            '[test-db-guard] refusing to run: DATABASE_URL is not bound. Bind it to TEST_DATABASE_URL before constructing the client.'
        );
    }
    if (databaseUrl !== testUrl) {
        throw new Error(
            `[test-db-guard] refusing to run: DATABASE_URL (${databaseUrl}) is not the explicit test database (${testUrl}).`
        );
    }

    const expected = databaseNameFromUrl(testUrl);
    if (!expected) {
        throw new Error(
            `[test-db-guard] refusing to run: cannot read a database name from TEST_DATABASE_URL (${testUrl}).`
        );
    }

    const rows = await prisma.$queryRawUnsafe('SELECT current_database() AS database');
    const connected = rows && rows[0] ? rows[0].database : null;
    if (!connected) {
        throw new Error(
            '[test-db-guard] refusing to run: the connection did not report its database identity.'
        );
    }
    if (String(connected) !== expected) {
        throw new Error(
            `[test-db-guard] refusing to run: connected to database "${connected}", but the disposable test database is "${expected}".`
        );
    }

    return { database: expected };
}

module.exports = { assertDisposableTestDatabase, databaseNameFromUrl };
