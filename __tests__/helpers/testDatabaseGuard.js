// __tests__/helpers/testDatabaseGuard.js
// =============================================================================
// TEST-ONLY: refuse to mutate a database that is not provably disposable.
//
// Some suites contain maintenance statements that change rows across a whole
// table (the native-GHS review orphan sweep resolves stale OPEN exception rows).
// Those statements are correct inside a disposable test database and must never
// be reachable anywhere else.
//
// A database NAME is not a server identity, and a URL hostname is only a claim.
// The guard therefore proves, in this order, and refuses BEFORE the caller's
// statement can run:
//
//   1. TEST_DATABASE_URL is set                  (the explicit disposable target)
//   2. NODE_ENV is 'test'                        (not a runtime process)
//   3. DATABASE_URL is bound and equals it        (the client was bound to it)
//   4. the URL parses, with a host and a database name
//   5. the URL host is loopback                   (a claim, necessary, not enough)
//   6. the server's own CURRENT_DATABASE matches the URL's database name
//   7. the server's own reported ADDRESS matches an independent expectation:
//        CI   — AZM_EXPECTED_TEST_DB_ADDRESS, the exact IP of the PostgreSQL
//               service container, discovered by the workflow with docker
//               inspect and exported through $GITHUB_ENV;
//        local — loopback (or a unix socket, where the server reports SQL NULL).
//
// WHY AN EXACT ADDRESS AND NOT A SUBNET. An earlier version accepted the whole
// 172.16.0.0/12 range because the Actions service container reports its docker
// bridge address (observed 172.18.0.2). A range is a private-network allowlist,
// not proof: a remote server reached through a loopback port-forward, SSH tunnel
// or proxy sits inside it too. The expectation is now ONE exact address obtained
// from the container itself, so 172.18.0.2 passes because it IS that container,
// while 172.18.0.3, 172.20.5.9 and 172.31.9.9 do not.
//
// FAIL-CLOSED EDGES:
//   - running under GitHub Actions with no expectation exported is a refusal,
//     not a silent downgrade to "loopback is probably fine";
//   - a missing, unparseable or ambiguous expectation is a refusal;
//   - SQL NULL from inet_server_addr() is the ONLY unix-socket exception. An
//     empty string, a missing column or any malformed value is refused, because
//     a falsy value must never be read as "local".
//
// DOCUMENTED LIMITATIONS (stated, not papered over):
//   - a local TCP connection is proven local by the SERVER's own report; a
//     port-forward to a remote host reports the remote address and is refused
//     locally, but locally there is no independently-supplied expectation to
//     compare against, so the proof is "loopback or nothing", not "this exact
//     server";
//   - a unix socket cannot cross machines, but its identity beyond that is not
//     independently established;
//   - IPv4-mapped IPv6 forms are REJECTED rather than interpreted. Node
//     normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1, so a dotted-form matcher
//     would be fiction; the only IPv6 form accepted is ::1.
//
// Every error reports redacted diagnostics only — host:port/database, or the
// offending address. Usernames, passwords, query-string credentials and full
// URLs never appear.
// =============================================================================

const net = require('net');

const EXPECTED_ADDRESS_ENV = 'AZM_EXPECTED_TEST_DB_ADDRESS';

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
        return 'an unparseable value';
    }
}

function normalizeHost(hostname) {
    const raw = String(hostname || '').trim().toLowerCase();
    if (!raw) return '';
    // URL parsing keeps IPv6 literals in brackets.
    return raw.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * Strict IP classification. Returns 'ipv4' | 'ipv6' | null.
 * Node's own parser rejects 127.999.1.1, 127.1, 127.0.0.01 and hex octets,
 * which a hand-written regex gets wrong.
 */
function classifyAddress(value) {
    if (typeof value !== 'string') return null;
    const address = normalizeHost(value);
    if (!address) return null;
    if (net.isIPv4(address)) return 'ipv4';
    if (net.isIPv6(address)) return 'ipv6';
    return null;
}

/** True only for a valid IPv4 address inside 127.0.0.0/8. */
function isLoopbackAddress(value) {
    if (classifyAddress(value) !== 'ipv4') return false;
    const first = Number(normalizeHost(value).split('.')[0]);
    return first === 127;
}

/**
 * The guard's single notion of "local": strict IPv4 loopback, or exactly ::1.
 * IPv4-mapped IPv6 (::ffff:...) is refused — Node normalizes it, so accepting
 * the dotted form would only look like it works.
 */
function isLocalAddress(value) {
    const kind = classifyAddress(value);
    if (kind === 'ipv4') return isLoopbackAddress(value);
    if (kind === 'ipv6') return normalizeHost(value) === '::1';
    return false;
}

function isMappedIPv6(value) {
    const kind = classifyAddress(value);
    if (kind !== 'ipv6') return false;
    return normalizeHost(value).startsWith('::ffff:');
}

/** A postgres URL host is loopback when it is a strict loopback address. */
function isLoopbackHost(hostname) {
    const host = normalizeHost(hostname);
    if (host === 'localhost') return true;
    return isLocalAddress(host);
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

/**
 * Interpret inet_server_addr()::text.
 *
 * Returns { reported: false } when the server reported SQL NULL (unix socket),
 * and { address } when it reported a strict address. Anything else — undefined
 * column, empty string, whitespace, a non-string, a malformed value — is
 * refused here rather than being mistaken for "local".
 */
function interpretServerAddress(reported) {
    if (reported === null) return { reported: false };
    if (typeof reported !== 'string') {
        throw new Error(
            '[test-db-guard] refusing to run: the server-reported address was not a string (or SQL NULL), so it cannot be interpreted.'
        );
    }
    const text = reported.trim();
    if (!text) {
        throw new Error(
            '[test-db-guard] refusing to run: the server reported an EMPTY address. Only SQL NULL means a unix socket; an empty value is treated as malformed.'
        );
    }
    // inet values arrive as CIDR, e.g. '127.0.0.1/32'.
    const address = text.replace(/\/\d{1,3}$/, '');
    if (classifyAddress(address) === null) {
        throw new Error(
            `[test-db-guard] refusing to run: the server-reported address "${address}" is not a valid IPv4 or IPv6 address.`
        );
    }
    if (isMappedIPv6(address)) {
        throw new Error(
            `[test-db-guard] refusing to run: the server-reported address "${address}" is an IPv4-mapped IPv6 form, which this guard does not interpret.`
        );
    }
    return { address: normalizeHost(address) };
}

/** Interpret the independently-supplied expectation (CI container identity). */
function interpretExpectedAddress(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) return null;
    const address = text.replace(/\/\d{1,3}$/, '');
    const kind = classifyAddress(address);
    if (kind === null) {
        throw new Error(
            `[test-db-guard] refusing to run: ${EXPECTED_ADDRESS_ENV} is set to "${address}", which is not a valid IPv4 or IPv6 address. An unreadable expectation is not a licence to skip the check.`
        );
    }
    if (isMappedIPv6(address)) {
        throw new Error(
            `[test-db-guard] refusing to run: ${EXPECTED_ADDRESS_ENV} is an IPv4-mapped IPv6 form ("${address}"), which this guard does not interpret.`
        );
    }
    return normalizeHost(address);
}

/**
 * Assert that `prisma` is connected to the disposable test database.
 *
 * @param {object} prisma      client exposing $queryRawUnsafe
 * @param {object} [overrides] test seams: { testUrl, databaseUrl, nodeEnv, expectedAddress, githubActions }
 * @returns {Promise<{database: string, host: string, serverAddress: string|null, identity: string}>}
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
    const githubActions = overrides.githubActions !== undefined
        ? overrides.githubActions
        : env.GITHUB_ACTIONS === 'true';
    const expectedRaw = overrides.expectedAddress !== undefined
        ? overrides.expectedAddress
        : env[EXPECTED_ADDRESS_ENV];

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

    // The expectation is resolved BEFORE any query: a lane that cannot say which
    // server it expects must fail, not fall through to "loopback is enough".
    let expectedAddress = interpretExpectedAddress(expectedRaw);
    if (!expectedAddress && githubActions) {
        throw new Error(
            `[test-db-guard] refusing to run: ${EXPECTED_ADDRESS_ENV} is not set, but this is a GitHub Actions run. The workflow must export the exact PostgreSQL service-container address; a missing expectation may not silently disable the identity check.`
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

    const { reported, address } = interpretServerAddress(row ? row.server_address : undefined);

    if (expectedAddress) {
        if (reported === false) {
            throw new Error(
                `[test-db-guard] refusing to run: the expected database address is "${expectedAddress}", but the server reported SQL NULL (a unix socket). An expectation that cannot be checked is not satisfied.`
            );
        }
        if (address !== expectedAddress) {
            throw new Error(
                `[test-db-guard] refusing to run: the server reports address "${address}", but the expected disposable database address is "${expectedAddress}". Identity mismatch.`
            );
        }
        return { database: target.database, host: target.host, serverAddress: address, identity: 'exact-expected-address' };
    }

    // Local run: no independently-supplied expectation exists, so the server's own
    // report must be local. SQL NULL is the only unix-socket signal.
    if (reported === false) {
        return { database: target.database, host: target.host, serverAddress: null, identity: 'unix-socket' };
    }
    if (!isLocalAddress(address)) {
        throw new Error(
            `[test-db-guard] refusing to run: the server reports address "${address}", which is neither loopback nor ::1, and no ${EXPECTED_ADDRESS_ENV} is available to prove which server this is.`
        );
    }
    return { database: target.database, host: target.host, serverAddress: address, identity: 'loopback-server-report' };
}

module.exports = {
    assertDisposableTestDatabase,
    EXPECTED_ADDRESS_ENV,
    classifyAddress,
    databaseNameFromUrl: (raw) => {
        const parsed = parseTarget(raw);
        return parsed ? parsed.database : null;
    },
    describeTarget,
    interpretExpectedAddress,
    interpretServerAddress,
    isLocalAddress,
    isLoopbackAddress,
    isLoopbackHost,
    isMappedIPv6,
    parseTarget,
};
