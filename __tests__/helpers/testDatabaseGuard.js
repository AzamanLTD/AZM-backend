// __tests__/helpers/testDatabaseGuard.js
// =============================================================================
// TEST-ONLY: refuse to mutate a database that is not provably disposable.
//
// Some suites contain maintenance statements that change rows across a whole
// table (the native-GHS review orphan sweep resolves stale OPEN exception rows).
// Those statements are correct inside a disposable test database and must never
// be reachable anywhere else.
//
// WHAT A NAME OR A HOSTNAME PROVES: nothing. Nor does a loopback URL, nor a
// loopback address reported by the server, nor a matching database name. OpenSSH
// local forwarding (ssh -L) can listen on your machine's loopback and make the
// outbound connection from the remote host, so a REMOTE PostgreSQL can report
// its own loopback address (or a unix-socket connection, where inet_server_addr()
// is NULL) while your tests believe they are local. See ssh(1), -L and -W.
//
// So the guard requires an INDEPENDENT identity, established here, not supplied
// by whoever set the environment:
//
//   GitHub Actions  the exact address of the PostgreSQL service container, as
//                   discovered by the workflow with docker inspect and exported
//                   through $GITHUB_ENV, AND re-verified by this helper through
//                   docker inspect (the container must exist, be running, be a
//                   postgres image, and hold that address). A fabricated
//                   expectation with no matching running container is refused.
//
//   local           a NATIVE local PostgreSQL cluster, proven by comparing the
//                   connected server's 64-bit pg_control system identifier with
//                   the identifier read locally from the cluster's own data
//                   directory (pg_controldata + postmaster.pid). A remote server
//                   cannot present the local cluster's system identifier, so a
//                   tunnel, forwarded socket or proxy is refused. A caller-
//                   supplied address is NEVER accepted as identity here, and a
//                   unix-socket connection (SQL NULL) is not accepted on its own
//                   either — it proves the transport, not the machine.
//
// SUPPORTED DEVELOPER MODES, stated plainly:
//   - a native local PostgreSQL cluster whose data directory this process can
//     read (run as the cluster owner, or with access to it);
//   - the CI lanes, which prove the service container by container identity.
// NOT SUPPORTED (fail closed, deliberately): a local Docker/remote PostgreSQL, a
// port-forward, an SSH tunnel, a proxy, a cloud database with a matching name,
// and any target whose identity cannot be read. Supporting a local container
// would need a repository-owned harness that launches it and proves the
// connection belongs to it; inventing that proof from an environment variable
// would be worse than refusing.
//
// Every error reports redacted diagnostics only — host:port/database or the
// offending address. Usernames, passwords and full URLs never appear.
// =============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPECTED_ADDRESS_ENV = 'AZM_EXPECTED_TEST_DB_ADDRESS';
const CONTAINER_ID_ENV = 'AZM_TEST_PG_CONTAINER';
const LOCAL_DATA_DIR_ENV = 'AZM_LOCAL_PG_DATA_DIR';

const refuse = (message) => { throw new Error(`[test-db-guard] refusing to run: ${message}`); };

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
    return raw.replace(/^\[/, '').replace(/\]$/, '');
}

/** Strict IP classification: 'ipv4' | 'ipv6' | null. Node's parser, not a regex. */
function classifyAddress(value) {
    if (typeof value !== 'string') return null;
    const address = normalizeHost(value);
    if (!address) return null;
    if (net.isIPv4(address)) return 'ipv4';
    if (net.isIPv6(address)) return 'ipv6';
    return null;
}

/**
 * Split an optional CIDR suffix and VALIDATE the prefix.
 * '/33', '/999' and '/0129' are not "an address with decoration", they are
 * malformed input and are refused rather than stripped.
 */
function splitCidr(value) {
    const text = String(value).trim();
    if (!text) return null;
    const slash = text.lastIndexOf('/');
    if (slash === -1) {
        const bare = normalizeHost(text);
        const bareKind = classifyAddress(bare);
        return bareKind ? { address: bare, prefix: null, kind: bareKind } : null;
    }
    const address = normalizeHost(text.slice(0, slash));
    const prefixText = text.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return null;
    const kind = classifyAddress(address);
    if (!kind) return null;
    const prefix = Number(prefixText);
    if (kind === 'ipv4' && prefix > 32) return null;
    if (kind === 'ipv6' && prefix > 128) return null;
    return { address, prefix, kind };
}

function isLoopbackAddress(value) {
    if (classifyAddress(value) !== 'ipv4') return false;
    return Number(normalizeHost(value).split('.')[0]) === 127;
}

/** Local-by-address: strict IPv4 loopback, or exactly ::1. Mapped forms are out. */
function isLocalAddress(value) {
    const kind = classifyAddress(value);
    if (kind === 'ipv4') return isLoopbackAddress(value);
    if (kind === 'ipv6') return normalizeHost(value) === '::1';
    return false;
}

function isMappedIPv6(value) {
    if (classifyAddress(value) !== 'ipv6') return false;
    return normalizeHost(value).startsWith('::ffff:');
}

function isLoopbackHost(hostname) {
    const host = normalizeHost(hostname);
    if (host === 'localhost') return true;
    return isLocalAddress(host);
}

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
 * SQL NULL => { reported: false } (a unix socket). It is NOT on its own proof of
 * locality: a forwarded local socket over ssh(1) -L reports NULL too, which is
 * why local mode additionally requires the cluster identity.
 */
function interpretServerAddress(reported) {
    if (reported === null) return { reported: false };
    if (typeof reported !== 'string') {
        refuse('the server-reported address was not a string (or SQL NULL), so it cannot be interpreted.');
    }
    const text = reported.trim();
    if (!text) {
        refuse('the server reported an EMPTY address. Only SQL NULL means a unix socket; an empty value is treated as malformed.');
    }
    const split = splitCidr(text);
    if (!split) refuse(`the server-reported address "${text}" is not a valid IPv4 or IPv6 address with a valid CIDR prefix (0-32 for IPv4, 0-128 for IPv6).`);
    if (isMappedIPv6(split.address)) refuse(`the server-reported address "${split.address}" is an IPv4-mapped IPv6 form, which this guard does not interpret.`);
    return { address: split.address, prefix: split.prefix };
}

/**
 * Interpret the CI expectation. It must be a BARE address — the workflow exports
 * a bare address, and a CIDR-suffixed or otherwise dressed-up value must not be
 * silently normalized into a valid one.
 */
function interpretExpectedAddress(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) return null;
    if (text.includes('/')) {
        refuse(`${EXPECTED_ADDRESS_ENV} is set to "${text}", which carries a CIDR prefix. The workflow exports a bare address; a prefixed value is not silently normalized.`);
    }
    if (classifyAddress(text) === null) {
        refuse(`${EXPECTED_ADDRESS_ENV} is set to "${text}", which is not a valid IPv4 or IPv6 address. An unreadable expectation is not a licence to skip the check.`);
    }
    if (isMappedIPv6(text)) {
        refuse(`${EXPECTED_ADDRESS_ENV} is an IPv4-mapped IPv6 form ("${text}"), which this guard does not interpret.`);
    }
    if (classifyAddress(text) !== 'ipv4') {
        refuse(`${EXPECTED_ADDRESS_ENV} is "${text}"; the CI expectation is a bare IPv4 container address.`);
    }
    return normalizeHost(text);
}

// ---------------------------------------------------------------------------
// Independent identity #1 (CI): verify the container that holds the address.
// ---------------------------------------------------------------------------

function run(command, args) {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
}

/**
 * Verify through docker that exactly one running container holds `address` and
 * that the caller's container id names it. A caller-supplied address alone is
 * not evidence; this is what turns it into evidence, and it is why a local run
 * that fakes GITHUB_ACTIONS is refused when docker is unavailable.
 */
function inspectContainerIdentity({ address, containerId }) {
    if (!containerId || !/^[0-9a-f]{12,64}$/i.test(String(containerId).trim())) {
        refuse(`${CONTAINER_ID_ENV} is missing or is not a container id, so the expected address cannot be tied to a container.`);
    }
    let info;
    try {
        info = JSON.parse(run('docker', ['inspect', String(containerId).trim()]));
    } catch (err) {
        refuse(`docker inspection of ${CONTAINER_ID_ENV} failed, so the expected address "${address}" is unverified. ${String(err.message || '').split('\n')[0].slice(0, 120)}`);
    }
    const container = Array.isArray(info) ? info[0] : null;
    if (!container) refuse(`${CONTAINER_ID_ENV} did not resolve to a container.`);
    if (!container.State || container.State.Running !== true) {
        refuse(`${CONTAINER_ID_ENV} (${container.Id ? container.Id.slice(0, 12) : 'unknown'}) is not running.`);
    }
    if (!/postgres/i.test(String(container.Config && container.Config.Image ? container.Config.Image : ''))) {
        refuse(`${CONTAINER_ID_ENV} is not a PostgreSQL image (${container.Config ? container.Config.Image : 'unknown'}).`);
    }
    const addresses = Object.values((container.NetworkSettings || {}).Networks || {})
        .map((network) => normalizeHost((network || {}).IPAddress))
        .filter(Boolean);
    if (!addresses.includes(address)) {
        refuse(`the container ${CONTAINER_ID_ENV} holds ${addresses.length ? addresses.join(', ') : 'no address'}, not the expected "${address}".`);
    }
    return { containerId: String(container.Id || containerId).trim(), containerAddress: address, image: container.Config ? container.Config.Image : null };
}

// ---------------------------------------------------------------------------
// Independent identity #2 (local): prove the cluster this process can SEE.
// ---------------------------------------------------------------------------

function findPgControldata() {
    if (process.env.PG_CONTROLDATA) return process.env.PG_CONTROLDATA;
    const candidates = ['/usr/lib/postgresql'];
    for (const root of candidates) {
        let versions = [];
        try { versions = fs.readdirSync(root).sort().reverse(); } catch (_) { continue; }
        for (const version of versions) {
            const candidate = path.join(root, version, 'bin', 'pg_controldata');
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return 'pg_controldata';
}

/**
 * Read the identity of the LOCAL cluster at `dataDirectory`.
 * A remote server cannot produce this: the system identifier lives in the local
 * cluster's pg_control and is unique per cluster (initdb).
 */
function probeLocalCluster({ dataDirectory, port } = {}) {
    const directory = String(dataDirectory || process.env[LOCAL_DATA_DIR_ENV] || '').trim();
    if (!directory || !path.isAbsolute(directory)) {
        refuse(`local mode needs the disposable cluster's data directory (${LOCAL_DATA_DIR_ENV}); none was provided, so the server's identity cannot be established.`);
    }
    let stats;
    try { stats = fs.statSync(directory); } catch (err) {
        refuse(`the local cluster data directory "${directory}" is not readable by this process (${err.code || 'error'}). Run the suite as the cluster owner, or use the CI lanes, which prove the service container instead.`);
    }
    if (!stats.isDirectory()) refuse(`the local cluster data directory "${directory}" is not a directory.`);

    let postmaster;
    try {
        postmaster = fs.readFileSync(path.join(directory, 'postmaster.pid'), 'utf8').split('\n');
    } catch (err) {
        refuse(`the local cluster "${directory}" has no readable postmaster.pid (${err.code || 'error'}), so it is not a running cluster on this machine.`);
    }
    const postmasterPid = Number(String(postmaster[0] || '').trim());
    const postmasterDirectory = String(postmaster[1] || '').trim();
    const postmasterPort = String(postmaster[3] || '').trim();
    if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) refuse(`the local cluster "${directory}" has an unreadable postmaster pid.`);
    if (postmasterDirectory !== directory) refuse(`the local cluster "${directory}" has a postmaster.pid written for "${postmasterDirectory}".`);
    if (port && postmasterPort !== String(port)) refuse(`the local cluster "${directory}" listens on port ${postmasterPort}, not on the connected port ${port}.`);

    let controldata;
    try {
        controldata = run(findPgControldata(), [directory]);
    } catch (err) {
        refuse(`pg_controldata could not read the local cluster "${directory}" (${String(err.message || '').split('\n')[0].slice(0, 100)}). Local Docker or remote targets must use the CI lanes.`);
    }
    const match = /Database system identifier:\s*(\d+)/.exec(controldata);
    if (!match) refuse(`pg_controldata did not report a system identifier for "${directory}".`);

    // A live local postmaster process is the last piece: /proc on Linux.
    if (process.platform === 'linux') {
        let cmdline = '';
        try { cmdline = fs.readFileSync(`/proc/${postmasterPid}/cmdline`, 'utf8'); } catch (_) {
            refuse(`no local process ${postmasterPid} owns the postmaster.pid in "${directory}", so the cluster is not running on this machine.`);
        }
        if (!/postgres/i.test(cmdline)) refuse(`local process ${postmasterPid} is not a PostgreSQL process.`);
    }

    return { systemIdentifier: match[1], dataDirectory: directory, postmasterPid, port: postmasterPort };
}

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

/**
 * @param {object} prisma      client exposing $queryRawUnsafe
 * @param {object} [overrides] seams: { testUrl, databaseUrl, nodeEnv, expectedAddress,
 *                             containerId, localDataDir, githubActions, probeLocalCluster,
 *                             inspectContainerIdentity }
 * @returns {Promise<object>}  { database, host, identity, ... }
 */
async function assertDisposableTestDatabase(prisma, overrides = {}) {
    const env = process.env;
    const pick = (key, fallback) => (overrides[key] !== undefined ? overrides[key] : fallback);
    const testUrl = String(pick('testUrl', env.TEST_DATABASE_URL || '')).trim();
    const databaseUrl = String(pick('databaseUrl', env.DATABASE_URL || '')).trim();
    const nodeEnv = pick('nodeEnv', env.NODE_ENV);
    const githubActions = pick('githubActions', env.GITHUB_ACTIONS === 'true');
    const expectedRaw = pick('expectedAddress', env[EXPECTED_ADDRESS_ENV]);
    const containerId = pick('containerId', env[CONTAINER_ID_ENV]);
    const localDataDir = pick('localDataDir', env[LOCAL_DATA_DIR_ENV]);

    if (!testUrl) refuse('TEST_DATABASE_URL is not set, so this process cannot prove which database it is connected to.');
    if (nodeEnv !== 'test') refuse(`NODE_ENV is "${nodeEnv}", not "test". A disposable-database maintenance statement may only run inside the test environment.`);
    if (!databaseUrl) refuse('DATABASE_URL is not bound. Bind it to TEST_DATABASE_URL before constructing the client.');
    if (databaseUrl !== testUrl) refuse(`DATABASE_URL targets ${describeTarget(databaseUrl)}, which is not the explicit test database ${describeTarget(testUrl)}.`);

    const target = parseTarget(testUrl);
    if (!target) refuse(`TEST_DATABASE_URL (${describeTarget(testUrl)}) does not parse into a host and a database name.`);
    if (!isLoopbackHost(target.host)) {
        refuse(`the test database host "${target.host}" (${describeTarget(testUrl)}) is not a loopback address. This maintenance statement is local-only; a remote or private-network database is not a supported disposable target.`);
    }

    // Identity expectations are resolved BEFORE any query.
    let expectedAddress = null;
    if (githubActions) {
        expectedAddress = interpretExpectedAddress(expectedRaw);
        if (!expectedAddress) refuse(`${EXPECTED_ADDRESS_ENV} is not set, but this is a GitHub Actions run. The workflow must export the exact PostgreSQL service-container address; a missing expectation may not silently disable the identity check.`);
    } else if (String(expectedRaw === undefined || expectedRaw === null ? '' : expectedRaw).trim() !== '') {
        // A locally supplied address is a CLAIM, never an identity.
        refuse(`a locally set ${EXPECTED_ADDRESS_ENV} ("${String(expectedRaw).trim()}") is not an independently verified identity. Local mode proves the cluster itself; remove the variable instead of asserting an address.`);
    }

    const rows = await prisma.$queryRawUnsafe(
        'SELECT current_database() AS database, inet_server_addr()::text AS server_address, '
        + '(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, '
        + "current_setting('data_directory') AS data_directory, current_setting('port') AS port"
    );
    const row = rows && rows[0] ? rows[0] : null;
    const connected = row ? row.database : null;
    if (!connected) refuse('the connection did not report its database identity.');
    if (String(connected) !== target.database) {
        refuse(`connected to database "${connected}", but the disposable test database is "${target.database}" on ${target.host}.`);
    }

    const server = interpretServerAddress(row ? row.server_address : undefined);

    if (githubActions) {
        if (server.reported === false) {
            refuse(`the expected database address is "${expectedAddress}", but the server reported SQL NULL (a unix socket). An expectation that cannot be checked is not satisfied.`);
        }
        if (server.address !== expectedAddress) {
            refuse(`the server reports address "${server.address}", but the expected disposable database address is "${expectedAddress}". Identity mismatch.`);
        }
        const inspector = overrides.inspectContainerIdentity || inspectContainerIdentity;
        const container = inspector({ address: expectedAddress, containerId });
        return {
            database: target.database, host: target.host, serverAddress: server.address,
            identity: 'ci-container-identity', containerAddress: container.containerAddress, containerId: container.containerId,
        };
    }

    // LOCAL: the transport tells us nothing. Prove the cluster this machine owns.
    // The data directory comes from the SERVER's own report unless overridden:
    // reading it locally and comparing system identifiers is what closes the
    // tunnel, because a remote cluster cannot present this machine's identifier.
    const prober = overrides.probeLocalCluster || probeLocalCluster;
    const dataDirectory = String(localDataDir || '').trim() || (row && row.data_directory ? String(row.data_directory) : '');
    const local = prober({ dataDirectory, port: row ? row.port : target.port });
    const serverSystemIdentifier = row && row.system_identifier ? String(row.system_identifier).trim() : '';
    if (!serverSystemIdentifier) {
        refuse('the connected server did not report its pg_control system identifier, so it cannot be matched to a local cluster.');
    }
    if (serverSystemIdentifier !== local.systemIdentifier) {
        refuse(`the connected server belongs to cluster ${serverSystemIdentifier}, but this machine's cluster at "${local.dataDirectory}" is ${local.systemIdentifier}. A forwarded, tunnelled or proxied server is not a disposable local target.`);
    }
    if (row && row.data_directory && String(row.data_directory) !== local.dataDirectory) {
        refuse(`the connected server runs from "${row.data_directory}", not from the local cluster "${local.dataDirectory}".`);
    }
    return {
        database: target.database, host: target.host,
        serverAddress: server.reported === false ? null : server.address,
        identity: 'local-cluster-identity', systemIdentifier: local.systemIdentifier,
        dataDirectory: local.dataDirectory, transport: server.reported === false ? 'unix-socket' : 'tcp',
    };
}

module.exports = {
    assertDisposableTestDatabase,
    CONTAINER_ID_ENV,
    EXPECTED_ADDRESS_ENV,
    LOCAL_DATA_DIR_ENV,
    classifyAddress,
    databaseNameFromUrl: (raw) => { const parsed = parseTarget(raw); return parsed ? parsed.database : null; },
    describeTarget,
    findPgControldata,
    inspectContainerIdentity,
    interpretExpectedAddress,
    interpretServerAddress,
    isLocalAddress,
    isLoopbackAddress,
    isLoopbackHost,
    isMappedIPv6,
    parseTarget,
    probeLocalCluster,
    splitCidr,
};
