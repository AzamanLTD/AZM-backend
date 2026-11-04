// __tests__/helpers/testDatabaseGuard.js
// =============================================================================
// TEST-ONLY: refuse to mutate a database that is not provably disposable.
//
// A few suites contain maintenance statements that change rows across a whole
// table (the native-GHS review orphan sweep resolves stale OPEN exception rows).
// Those statements are correct inside a disposable test database and must never
// be reachable anywhere else. Gating the `describe` on TEST_DATABASE_URL is NOT
// enough on its own: it proves that a test URL exists, not that the client is
// connected to a disposable one.
//
// A database NAME is not an identity. If TEST_DATABASE_URL were accidentally
// pointed at a remote server whose database happens to share the name, name
// equality would still hold and the sweep would run against it. So the guard
// also proves WHERE it is connected:
//
//   1. TEST_DATABASE_URL must be set              (the explicit disposable target)
//   2. NODE_ENV must be 'test'                    (not a runtime process)
//   3. DATABASE_URL must equal TEST_DATABASE_URL  (the client was bound to it)
//   4. the URL must parse, with a host and a database name
//   5. the HOST must be loopback                  (localhost / 127.0.0.0-8 / ::1)
//   6. the CONNECTED database name must equal the one in the URL
//   7. the server-reported address must not be globally routable
//
// SUPPORTED TARGETS, deliberately limited to what this repository actually uses:
// the GitHub Actions Postgres service container and local development databases
// (azm_test, azm_iso, azm_h1) all connect over loopback on localhost:5432.
//
// ON CHECK 7 — why it is not simply "loopback": GitHub Actions runs Postgres as a
// service container, reached through the published port on localhost, but the
// server reports ITS OWN address, which is the container's docker bridge address
// (observed: 172.18.0.2). Requiring a loopback report there would refuse the very
// environment this lane runs in — it did, on run 41879844824, which is how the
// allowance below was established rather than guessed. So check 7 refuses only
// GLOBALLY ROUTABLE reports (and the 10/8 and 192.168/16 ranges), while accepting
// loopback, NULL (local unix socket) and 172.16.0.0/12 (the docker bridge a
// service container reports). The loopback URL check (5) remains the primary
// identity; check 7 is a second line that catches a server answering from a
// publicly reachable address.
//
// There is NO allowlist for other hosts. A remote or private-network disposable
// database is not supported by this guard, and must not be made to pass by
// loosening it: supporting one requires an explicit identity mechanism stronger
// than a hostname (for example a per-run signed token issued by the environment
// and verified out of band). Until such a mechanism exists, the maintenance
// statement stays local-only.
//
// Every error message reports redacted diagnostics ONLY (host:port/database).
// Usernames, passwords, query-string credentials and full URLs never appear.
// =============================================================================

/** Redacted, human-readable target: host:port/database. Never credentials. */
function describeTarget(raw) {
    if (!raw) return 'an empty value';
    try {
        const parsed = new URL(String(raw).trim());
        const host = normalizeHost(parsed.hostname);
        const port = parsed.port ? `:${parsed.port}` : '';
        const database = decodeURIComponent(parsed.pathname || '').replace(/^\//, '');
        if (!host && !database) return 'an unparseable value';
        return `${host || 'unknown-host'}${port}/${database || 'no-database'}`;
    } catch (_) {
        // Unparseable: say nothing about its contents.
        return 'an unparseable value';
    }
}

function normalizeHost(hostname) {
    const raw = String(hostname || '').trim().toLowerCase();
    if (!raw) return '';
    // URL parsing keeps IPv6 literals in brackets.
    return raw.replace(/^\[/, '').replace(/\]$/, '');
}

/** True only for genuine loopback addresses. */
function isLoopbackHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    if (host === 'localhost') return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    // 127.0.0.0/8 is entirely loopback.
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    // IPv4-mapped loopback, e.g. ::ffff:127.0.0.1
    const mapped = host.match(/^::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return true;
    return false;
}

/** Parse a postgres URL into the fields the guard reasons about. */
function parseTarget(raw) {
    if (!raw) return null;
    try {
        const parsed = new URL(String(raw).trim());
        const host = normalizeHost(parsed.hostname);
        const database = decodeURIComponent(parsed.pathname || '').replace(/^\//, '');
        if (!host || !database) return null;
        return { host, port: parsed.port || '', database };
    } catch (_) {
        return null;
    }
}

/** The docker bridge range a service container reports as its own address. */
function isDockerBridgeAddress(host) {
    const h = normalizeHost(host);
    const m = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (!m) return false;
    const second = Number(m[1]);
    return second >= 16 && second <= 31; // 172.16.0.0/12
}

/** inet_server_addr() reports a CIDR such as '127.0.0.1/32' (or NULL locally). */
function serverAddressHost(reported) {
    if (reported === null || reported === undefined) return null;
    const text = String(reported).trim();
    if (!text) return null;
    return text.replace(/\/\d{1,3}$/, '');
}

/**
 * Assert that `prisma` is connected to the disposable test database.
 *
 * @param {object} prisma      client exposing $queryRawUnsafe
 * @param {object} [overrides] test seams: { testUrl, databaseUrl, nodeEnv }
 * @returns {Promise<{database: string, host: string}>}
 * @throws when any condition is not met — callers must not run the statement
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
        // Redacted on purpose: both URLs may carry credentials.
        throw new Error(
            `[test-db-guard] refusing to run: DATABASE_URL targets ${describeTarget(databaseUrl)}, which is not the explicit test database ${describeTarget(testUrl)}.`
        );
    }

    const target = parseTarget(testUrl);
    if (!target) {
        throw new Error(
            `[test-db-guard] refusing to run: TEST_DATABASE_URL (${describeTarget(testUrl)}) does not parse into a host and a database name.`
        );
    }

    if (!isLoopbackHost(target.host)) {
        throw new Error(
            `[test-db-guard] refusing to run: the test database host "${target.host}" (${describeTarget(testUrl)}) is not a loopback address. This maintenance statement is local-only; a remote or private-network database is not a supported disposable target.`
        );
    }

    const rows = await prisma.$queryRawUnsafe(
        'SELECT current_database() AS database, inet_server_addr()::text AS server_address'
    );
    const row = rows && rows[0] ? rows[0] : null;
    const connected = row ? row.database : null;
    if (!connected) {
        throw new Error(
            '[test-db-guard] refusing to run: the connection did not report its database identity.'
        );
    }
    if (String(connected) !== target.database) {
        throw new Error(
            `[test-db-guard] refusing to run: connected to database "${connected}", but the disposable test database is "${target.database}" on ${target.host}.`
        );
    }

    // The server's own report, not ours. NULL means a local unix socket (this
    // machine). A service container reports its docker bridge address, which is
    // still this machine's docker network — the CI topology. Anything else is a
    // server answering from somewhere we cannot account for, so refuse.
    const reportedHost = serverAddressHost(row ? row.server_address : null);
    const reportedOk = reportedHost === null
        || isLoopbackHost(reportedHost)
        || isDockerBridgeAddress(reportedHost);
    if (!reportedOk) {
        throw new Error(
            `[test-db-guard] refusing to run: the server reports the address "${reportedHost}", which is neither loopback nor this machine's docker bridge. The configured host said "${target.host}".`
        );
    }

    return { database: target.database, host: target.host };
}

module.exports = {
    assertDisposableTestDatabase,
    databaseNameFromUrl: (raw) => {
        const parsed = parseTarget(raw);
        return parsed ? parsed.database : null;
    },
    describeTarget,
    isDockerBridgeAddress,
    isLoopbackHost,
    parseTarget,
};
