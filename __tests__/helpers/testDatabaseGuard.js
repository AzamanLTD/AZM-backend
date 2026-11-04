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
//   local (Linux)   the INSTANCE, not the cluster. A physical standby, a clone or
//                   a promoted standby keeps the SAME pg_control system
//                   identifier, data directory path and port, so the cluster
//                   identifier alone cannot tell two instances apart. The guard
//                   therefore walks the backend the connection is actually
//                   served by: pg_backend_pid() must be a live local PostgreSQL
//                   process whose /proc ancestry reaches the exact postmaster PID
//                   in the local postmaster.pid, that postmaster must be live and
//                   started at pg_postmaster_start_time(), and its start ticks
//                   must not have been reused. The system identifier stays as a
//                   CONSISTENCY check only — never as instance identity. A
//                   caller-supplied address is never accepted as identity, and a
//                   unix socket (SQL NULL) proves the transport, not the machine.
//
//   The instance proof is Linux-specific (/proc). On any other platform local
//   mode is REFUSED before any mutation, with no weaker fallback.
//
// SUPPORTED DEVELOPER MODES, stated plainly:
//   - Linux, with a native local PostgreSQL cluster whose data directory and
//     /proc entries this process can read (run as the cluster owner, or root);
//   - the CI lanes, which prove the service container by container identity.
// NOT SUPPORTED (fail closed, deliberately): macOS, Windows and any non-Linux
// host; a local Docker or remote PostgreSQL; a port-forward, SSH tunnel or proxy;
// a cloud database with a matching name or with the same cluster lineage; and any
// target whose instance identity cannot be read. Supporting a local container
// would need a repository-owned harness that launches it and proves the
// connection belongs to it; inventing that proof from an environment variable
// would be worse than refusing.
//
// CI PROVENANCE: GITHUB_ACTIONS=true alone is NOT authentication — any laptop can
// set it. The CI branch is enabled only by a GitHub Actions OIDC token whose
// RS256 signature verifies against GitHub's published JWKS and whose issuer,
// audience, expiry, repository and workflow claims all match. A Docker label or a
// GITHUB_RUN_ID is forgeable and is never treated as proof.
//
// Every error reports redacted diagnostics only — host:port/database or the
// offending address. Usernames, passwords and full URLs never appear.
// =============================================================================

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const EXPECTED_ADDRESS_ENV = 'AZM_EXPECTED_TEST_DB_ADDRESS';
const CONTAINER_ID_ENV = 'AZM_TEST_PG_CONTAINER';
const LOCAL_DATA_DIR_ENV = 'AZM_LOCAL_PG_DATA_DIR';
const OIDC_TOKEN_PATH_ENV = 'AZM_CI_OIDC_TOKEN_PATH';
const OIDC_AUDIENCE = 'azm-test-db-guard';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;
const SERVICE_CONTAINER_ENV = 'AZM_CI_SERVICE_CONTAINER_ID';
const START_TIME_TOLERANCE_SECONDS = 10;
// The only workflows whose tokens may authenticate the CI branch. Exact paths,
// bound to the workflow display name each file declares.
const ALLOWED_WORKFLOWS = Object.freeze({
    '.github/workflows/financial-durability.yml': 'financial-durability',
    '.github/workflows/test.yml': 'Azaman Test Suite',
});
// Deliberately narrow: GitHub-issued tokens are short-lived and the runner clock
// is the same host that signs the request.
const CLOCK_SKEW_SECONDS = 60;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const CLOCK_TICKS_FALLBACK = 100;

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
function inspectContainerIdentity({ address, containerId, serviceContainerId }) {
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
    const resolvedId = String(container.Id || containerId).trim().toLowerCase();
    // The job-declared service container is mandatory and must BE this container.
    const declared = String(serviceContainerId === undefined || serviceContainerId === null ? '' : serviceContainerId).trim().toLowerCase();
    if (!declared) {
        refuse(`AZM_CI_SERVICE_CONTAINER_ID is not set. The workflow must export job.services.postgres.id; the guard will not fall back to a docker ps selection alone.`);
    }
    if (!CONTAINER_ID_PATTERN.test(declared)) {
        refuse(`AZM_CI_SERVICE_CONTAINER_ID ("${declared}") is not a full 64-character container id, so it cannot identify a container unambiguously.`);
    }
    if (!CONTAINER_ID_PATTERN.test(resolvedId)) {
        refuse(`the inspected container reported id "${resolvedId}", which is not a full 64-character container id.`);
    }
    if (resolvedId !== declared) {
        refuse(`the inspected container ${resolvedId} is not the service container ${declared} declared by the workflow job.`);
    }
    return { containerId: resolvedId, containerAddress: address, image: container.Config ? container.Config.Image : null };
}

// ---------------------------------------------------------------------------
// Independent identity #2 (local, Linux): prove the INSTANCE serving this
// connection is a process on this machine that descends from the postmaster in
// the local data directory's postmaster.pid.
//
// The cluster system identifier is NOT instance identity: a physical standby,
// a clone or a promoted standby carries the same identifier, the same data
// directory path and the same port. Identity comes from processes and clocks.
// ---------------------------------------------------------------------------

function findPgControldata() {
    if (process.env.PG_CONTROLDATA) return process.env.PG_CONTROLDATA;
    try {
        const versions = fs.readdirSync('/usr/lib/postgresql').sort().reverse();
        for (const version of versions) {
            const candidate = path.join('/usr/lib/postgresql', version, 'bin', 'pg_controldata');
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch (_) { /* fall through */ }
    return 'pg_controldata';
}

/**
 * Parse /proc/<pid>/stat WITHOUT splitting the whole line on whitespace.
 * Field 2 (comm) is parenthesised and may itself contain spaces and parentheses,
 * so the split is anchored on the FIRST '(' and the LAST ')' in the line.
 * Returns the fields this guard needs, and nothing derived from a guess.
 */
function readProcStat(pid) {
    const id = Number(pid);
    if (!Number.isInteger(id) || id <= 0) return null;
    let raw;
    try { raw = fs.readFileSync(`/proc/${id}/stat`, 'utf8'); } catch (err) {
        if (err.code === 'ENOENT') return null;
        refuse(`/proc/${id}/stat could not be read (${err.code || 'error'}).`);
    }
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    if (open === -1 || close === -1 || close < open) return null;
    const comm = raw.slice(open + 1, close);
    const rest = raw.slice(close + 2).trim().split(/\s+/);
    // rest[0] is field 3 (state), so field N is rest[N - 3].
    const state = rest[0];
    const ppid = Number(rest[1]);
    const starttime = Number(rest[19]);
    if (!Number.isInteger(ppid) || !Number.isInteger(starttime)) return null;
    return { pid: id, comm, state, ppid, starttime };
}

function clockTicks() {
    if (process.env.AZM_CLOCK_TICKS) return Number(process.env.AZM_CLOCK_TICKS) || CLOCK_TICKS_FALLBACK;
    try {
        const raw = String(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 })).trim();
        const value = Number(raw);
        if (Number.isInteger(value) && value > 0) return value;
    } catch (_) { /* fall back */ }
    return CLOCK_TICKS_FALLBACK;
}

function bootEpoch() {
    try {
        const stat = fs.readFileSync('/proc/stat', 'utf8');
        const match = /^btime\s+(\d+)$/m.exec(stat);
        if (match) return Number(match[1]);
    } catch (_) { /* fall through */ }
    return null;
}

/** Wall-clock start of a process, from its start ticks and the boot time. */
function processStartEpoch(stat, hz, btime) {
    if (!stat || !btime) return null;
    return btime + stat.starttime / hz;
}

/**
 * Prove the backend that served this connection is a live local PostgreSQL
 * backend descended from the local postmaster, and that both clocks agree.
 *
 * @param {object} args backendPid, postmasterStartTime, dataDirectory, port
 */
function probeLocalInstance({ backendPid, postmasterStartTime, dataDirectory, port } = {}, seams = {}) {
    const platform = seams.platform || process.platform;
    const readText = seams.readText || ((file) => fs.readFileSync(file, 'utf8'));
    const readStat = seams.readProcStat || readProcStat;
    const hz = seams.clockTicks || clockTicks();
    const btime = seams.bootEpoch !== undefined ? seams.bootEpoch : bootEpoch();
    if (platform !== 'linux') {
        refuse(`local mode is only implemented for Linux (/proc process identity). This host is "${platform}"; there is no equivalent instance proof here, so it is refused rather than downgraded to the cluster-lineage check.`);
    }
    const directory = String(dataDirectory || '').trim();
    if (!directory || !path.isAbsolute(directory)) {
        refuse(`local mode needs the disposable instance's data directory; the server reported "${directory || 'nothing'}".`);
    }
    let postmaster;
    try {
        postmaster = readText(path.join(directory, 'postmaster.pid')).split('\n');
    } catch (err) {
        refuse(`the data directory "${directory}" has no readable postmaster.pid (${err.code || 'error'}), so no postmaster on this machine is serving it.`);
    }
    const rawPid = String(postmaster[0] || '').trim();
    const rawStart = String(postmaster[2] || '').trim();
    const postmasterDirectory = String(postmaster[1] || '').trim();
    const postmasterPort = String(postmaster[3] || '').trim();
    if (!/^\d+$/.test(rawPid) || Number(rawPid) <= 0) refuse(`the postmaster.pid in "${directory}" has an unreadable pid ("${rawPid || 'empty'}").`);
    const postmasterPid = Number(rawPid);
    // The third line is the postmaster's start time. A missing, blank or
    // malformed value cannot exclude PID reuse, so it is refused rather than
    // skipping the comparison.
    if (!/^\d+$/.test(rawStart) || Number(rawStart) <= 0) {
        refuse(`the postmaster.pid in "${directory}" has no valid start time on its third line ("${rawStart || 'empty'}"), so PID reuse cannot be excluded.`);
    }
    const postmasterStartPid = Number(rawStart);
    if (postmasterDirectory !== directory) refuse(`the postmaster.pid in "${directory}" was written for "${postmasterDirectory}".`);
    if (port && postmasterPort !== String(port)) refuse(`the local instance listens on port ${postmasterPort}, not on the connected port ${port}.`);

    const postmasterStat = readStat(postmasterPid);
    if (!postmasterStat) refuse(`no live local process ${postmasterPid} backs the postmaster.pid in "${directory}" — a stale PID file is not a running instance.`);
    if (!/postgres/i.test(postmasterStat.comm)) refuse(`local process ${postmasterPid} is "${postmasterStat.comm}", not a PostgreSQL postmaster.`);
    if (postmasterStat.state === 'Z') refuse(`local process ${postmasterPid} is a zombie, not a live postmaster.`);

    let cmdline = '';
    try { cmdline = readText(`/proc/${postmasterPid}/cmdline`); } catch (_) {
        refuse(`/proc/${postmasterPid}/cmdline is unreadable, so the process behind "${directory}" cannot be confirmed as this instance.`);
    }
    if (!cmdline.includes(directory)) {
        refuse(`the postmaster at ${postmasterPid} does not reference the data directory "${directory}".`);
    }

    const backend = readStat(backendPid);
    if (!backend) refuse(`the connection reported backend pid ${backendPid}, which is not a live process on this machine. A remote, tunnelled or forwarded server cannot satisfy this.`);
    if (!/postgres/i.test(backend.comm)) refuse(`local process ${backendPid} is "${backend.comm}", not a PostgreSQL backend.`);
    if (backend.state === 'Z') refuse(`local process ${backendPid} is a zombie.`);

    // Ancestry: the backend must descend from THIS postmaster, not merely exist.
    let cursor = backend;
    let reached = false;
    const chain = [backend.pid];
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
        if (cursor.ppid === postmasterPid) { reached = true; break; }
        if (cursor.ppid <= 1) break;
        cursor = readStat(cursor.ppid);
        if (cursor) chain.push(cursor.pid);
    }
    if (!reached) {
        refuse(`backend ${backendPid} does not descend from the postmaster ${postmasterPid} in "${directory}" (ancestry: ${chain.join(' -> ')}).`);
    }

    const postmasterStarted = processStartEpoch(postmasterStat, hz, btime);
    if (postmasterStarted === null) refuse('the local postmaster start time could not be derived from /proc/stat btime and its start ticks.');

    // PID reuse: the process must have started when the cluster says it did.
    {
        if (Math.abs(postmasterStartPid - postmasterStarted) > START_TIME_TOLERANCE_SECONDS) {
            refuse(`the postmaster.pid records start time ${postmasterStartPid}, but process ${postmasterPid} started at ${Math.round(postmasterStarted)} — a reused PID or a stale file.`);
        }
    }
    const reported = postmasterStartTime ? new Date(postmasterStartTime) : null;
    if (!reported || Number.isNaN(reported.getTime())) {
        refuse('the server did not report pg_postmaster_start_time(), so the instance clock cannot be checked.');
    }
    if (Math.abs(reported.getTime() / 1000 - postmasterStarted) > START_TIME_TOLERANCE_SECONDS) {
        refuse(`the server reports a postmaster start time of ${reported.toISOString()}, but the local postmaster ${postmasterPid} started at ${new Date(postmasterStarted * 1000).toISOString()}. The connection is not being served by this instance.`);
    }

    return {
        backendPid: backend.pid, postmasterPid, postmasterStarted: new Date(postmasterStarted * 1000).toISOString(),
        dataDirectory: directory, port: postmasterPort, ancestry: chain, clockTicks: hz,
    };
}

// ---------------------------------------------------------------------------
// CI provenance: a GitHub Actions OIDC token, verified against GitHub's JWKS.
// GITHUB_ACTIONS, a container label, a GITHUB_RUN_ID or a container id are all
// settable by anyone and are never treated as authentication.
// ---------------------------------------------------------------------------

let jwksCache = null;

function fetchGithubJwks() {
    if (jwksCache) return Promise.resolve(jwksCache);
    return new Promise((resolve, reject) => {
        const request = https.get(OIDC_JWKS_URL, { timeout: 15000 }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`JWKS endpoint answered HTTP ${response.statusCode}`));
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (!parsed || !Array.isArray(parsed.keys)) throw new Error('no keys');
                    jwksCache = parsed;
                    resolve(parsed);
                } catch (err) { reject(new Error(`JWKS payload unreadable: ${err.message}`)); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('JWKS request timed out')));
        request.on('error', reject);
    });
}

function base64UrlToBuffer(part) {
    return Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwt(token) {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 3) refuse('the GitHub Actions OIDC token is not a three-part JWT.');
    let header, payload;
    try {
        header = JSON.parse(base64UrlToBuffer(parts[0]).toString('utf8'));
        payload = JSON.parse(base64UrlToBuffer(parts[1]).toString('utf8'));
    } catch (_) {
        refuse('the GitHub Actions OIDC token header or payload is not readable JSON.');
    }
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlToBuffer(parts[2]) };
}

/**
 * Verify a GitHub Actions OIDC token. Signature first, then every claim that
 * matters. Returns the verified identity; throws on any failure.
 */
function verifyRunnerIdentity({
    token, jwks, now = Date.now(),
    audience = OIDC_AUDIENCE,
    repository = process.env.AZM_CI_REPOSITORY || 'AzamanLTD/AZM-backend',
    runId, runAttempt, sha, ref,
} = {}) {
    if (!token) refuse('no GitHub Actions OIDC token was supplied, so the runner is not authenticated.');
    const decoded = decodeJwt(token);
    // Exact algorithm, not a case-normalized guess.
    if (decoded.header.alg !== 'RS256') refuse(`the OIDC token uses ${JSON.stringify(decoded.header.alg)}; only RS256 is accepted.`);
    const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid.trim() : '';
    if (!kid) refuse('the OIDC token header carries no key id (kid), so the signing key cannot be identified.');
    const keys = (jwks && Array.isArray(jwks.keys)) ? jwks.keys : null;
    if (!keys) refuse('no GitHub signing keys are available to verify the OIDC token.');
    const matching = keys.filter((key) => key && key.kid === kid);
    if (!matching.length) refuse(`the OIDC token is signed with key "${kid}", which is not among GitHub's published keys.`);
    let verifiedSignature = false;
    for (const key of matching) {
        try {
            const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
            if (crypto.verify('RSA-SHA256', Buffer.from(decoded.signingInput), publicKey, decoded.signature)) { verifiedSignature = true; break; }
        } catch (_) { /* try the next key */ }
    }
    if (!verifiedSignature) refuse('the OIDC token signature does not verify against GitHub\'s published keys.');

    const claims = decoded.payload;
    if (claims.iss !== OIDC_ISSUER) refuse(`the OIDC token issuer is "${claims.iss}", not "${OIDC_ISSUER}".`);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) refuse(`the OIDC token audience is "${audiences.join(', ')}", not "${audience}".`);

    // § standard time claims, all required and all numeric.
    const numeric = (name) => {
        const value = claims[name];
        if (!Number.isInteger(value)) refuse(`the OIDC token's "${name}" claim is ${JSON.stringify(value === undefined ? null : value)}; a numeric ${name} is required.`);
        return value;
    };
    const exp = numeric('exp');
    const nbf = numeric('nbf');
    const iat = numeric('iat');
    const nowSeconds = Math.floor(now / 1000);
    const skew = CLOCK_SKEW_SECONDS;
    if (exp <= nowSeconds) refuse(`the OIDC token expired at ${new Date(exp * 1000).toISOString()}.`);
    if (nbf > nowSeconds + skew) refuse(`the OIDC token is not valid until ${new Date(nbf * 1000).toISOString()}, beyond the ${skew}s clock-skew allowance.`);
    if (iat > nowSeconds + skew) refuse(`the OIDC token was issued at ${new Date(iat * 1000).toISOString()}, in the future beyond the ${skew}s clock-skew allowance.`);
    if (nbf > exp) refuse('the OIDC token is inconsistent: nbf is after exp.');
    if (iat > exp) refuse('the OIDC token is inconsistent: iat is after exp.');

    if (claims.repository !== repository) refuse(`the OIDC token names repository "${claims.repository}", not "${repository}".`);

    // § only the workflows that own this lane may authenticate it.
    const workflowRef = String(claims.workflow_ref || '');
    const at = workflowRef.lastIndexOf('@');
    const pathAndRepo = at > 0 ? workflowRef.slice(0, at) : workflowRef;
    const prefix = `${repository}/`;
    if (!pathAndRepo.startsWith(prefix)) refuse(`the OIDC token names workflow "${workflowRef || 'nothing'}", which does not belong to ${repository}.`);
    const workflowPath = pathAndRepo.slice(prefix.length);
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_WORKFLOWS, workflowPath)) {
        refuse(`the OIDC token was issued to workflow "${workflowPath || 'unknown'}", which is not one of the workflows allowed to authenticate this database (${Object.keys(ALLOWED_WORKFLOWS).join(', ')}).`);
    }
    const expectedWorkflowName = ALLOWED_WORKFLOWS[workflowPath];
    if (claims.workflow !== expectedWorkflowName) {
        refuse(`the OIDC token was issued to workflow "${workflowPath}", whose name is "${expectedWorkflowName}", but the token claims workflow "${claims.workflow}".`);
    }

    // § the token must belong to THIS run and THIS attempt, as reported by the
    // runner runtime — never by the token itself.
    const runtimeRunId = String(runId === undefined || runId === null ? '' : runId).trim();
    const runtimeAttempt = String(runAttempt === undefined || runAttempt === null ? '' : runAttempt).trim();
    if (!/^\d+$/.test(runtimeRunId)) refuse('the current runner did not supply a numeric GITHUB_RUN_ID, so the token cannot be bound to this run.');
    if (!/^\d+$/.test(runtimeAttempt)) refuse('the current runner did not supply a numeric GITHUB_RUN_ATTEMPT, so the token cannot be bound to this attempt.');
    const tokenRunId = claims.run_id === undefined || claims.run_id === null ? '' : String(claims.run_id).trim();
    const tokenAttempt = claims.run_attempt === undefined || claims.run_attempt === null ? '' : String(claims.run_attempt).trim();
    if (!/^\d+$/.test(tokenRunId)) refuse(`the OIDC token carries no valid run_id (${JSON.stringify(claims.run_id === undefined ? null : claims.run_id)}).`);
    if (!/^\d+$/.test(tokenAttempt)) refuse(`the OIDC token carries no valid run_attempt (${JSON.stringify(claims.run_attempt === undefined ? null : claims.run_attempt)}).`);
    if (tokenRunId !== runtimeRunId) refuse(`the OIDC token was issued for run ${tokenRunId}, but this runner is run ${runtimeRunId}.`);
    if (tokenAttempt !== runtimeAttempt) refuse(`the OIDC token was issued for attempt ${tokenAttempt}, but this runner is attempt ${runtimeAttempt}.`);
    // § and to the current commit/ref where the runtime supplies them.
    const runtimeSha = String(sha === undefined || sha === null ? '' : sha).trim();
    if (runtimeSha && claims.sha !== runtimeSha) refuse(`the OIDC token names commit "${claims.sha || ''}", but this runner is at "${runtimeSha}".`);
    const runtimeRef = String(ref === undefined || ref === null ? '' : ref).trim();
    if (runtimeRef && claims.ref !== runtimeRef) refuse(`the OIDC token names ref "${claims.ref || ''}", but this runner is on "${runtimeRef}".`);

    return {
        runId: tokenRunId, runAttempt: tokenAttempt, workflow: workflowRef, workflowPath,
        workflowName: expectedWorkflowName, repository: claims.repository,
        expiresAt: new Date(exp * 1000).toISOString(), issuedAt: new Date(iat * 1000).toISOString(),
        sha: claims.sha || null, ref: claims.ref || null,
    };
}

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

/**
 * @param {object} client      Prisma client OR an interactive transaction client
 * @param {object} [overrides] seams
 * @returns {Promise<object>}  identity evidence
 */
async function assertDisposableTestDatabase(client, overrides = {}) {
    const env = process.env;
    const pick = (key, fallback) => (overrides[key] !== undefined ? overrides[key] : fallback);
    const testUrl = String(pick('testUrl', env.TEST_DATABASE_URL || '')).trim();
    const databaseUrl = String(pick('databaseUrl', env.DATABASE_URL || '')).trim();
    const nodeEnv = pick('nodeEnv', env.NODE_ENV);
    const githubActions = pick('githubActions', env.GITHUB_ACTIONS === 'true');
    const expectedRaw = pick('expectedAddress', env[EXPECTED_ADDRESS_ENV]);
    const containerId = pick('containerId', env[CONTAINER_ID_ENV]);
    const serviceContainerId = pick('serviceContainerId', env[SERVICE_CONTAINER_ENV]);
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

    // The CI expectation, when this is the CI branch. Resolved before any query.
    let expectedAddress = null;
    let runner = null;
    if (githubActions) {
        expectedAddress = interpretExpectedAddress(expectedRaw);
        if (!expectedAddress) refuse(`${EXPECTED_ADDRESS_ENV} is not set, but this is a GitHub Actions run. The workflow must export the exact PostgreSQL service-container address; a missing expectation may not silently disable the identity check.`);
        // GITHUB_ACTIONS is a claim. The runner is authenticated by OIDC or not at all.
        const token = pick('oidcToken', (() => {
            const tokenPath = pick('oidcTokenPath', env[OIDC_TOKEN_PATH_ENV]);
            if (!tokenPath) return '';
            try { return fs.readFileSync(String(tokenPath), 'utf8').trim(); } catch (_) { return ''; }
        })());
        const verifier = overrides.verifyRunnerIdentity || verifyRunnerIdentity;
        let jwks = overrides.jwks || null;
        if (!jwks) {
            try {
                jwks = overrides.fetchJwks ? await overrides.fetchJwks() : await fetchGithubJwks();
            } catch (err) {
                refuse(`GitHub's published signing keys could not be fetched, so the runner cannot be authenticated: ${String((err && err.message) || err).slice(0, 120)}`);
            }
        }
        runner = verifier({
            token, jwks, now: overrides.now || Date.now(), audience: overrides.audience || OIDC_AUDIENCE,
            // From the runner runtime, never from the token.
            runId: pick('runId', env.GITHUB_RUN_ID),
            runAttempt: pick('runAttempt', env.GITHUB_RUN_ATTEMPT),
            sha: pick('sha', env.GITHUB_SHA),
            ref: pick('ref', env.GITHUB_REF),
        });
        if (!runner || !runner.runId) refuse('the runner identity could not be verified.');
    } else if (String(expectedRaw === undefined || expectedRaw === null ? '' : expectedRaw).trim() !== '') {
        refuse(`a locally set ${EXPECTED_ADDRESS_ENV} ("${String(expectedRaw).trim()}") is not an independently verified identity. Local mode proves the instance itself; remove the variable instead of asserting an address.`);
    }

    const rows = await client.$queryRawUnsafe(
        'SELECT pg_catalog.current_database() AS database, '
        + 'pg_catalog.inet_server_addr()::text AS server_address, '
        + '(SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier, '
        + "pg_catalog.current_setting('data_directory') AS data_directory, "
        + "pg_catalog.current_setting('port') AS port, "
        + 'pg_catalog.pg_backend_pid() AS backend_pid, '
        + 'pg_catalog.pg_postmaster_start_time() AS postmaster_start_time'
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
        // The job-declared service container is validated BEFORE any docker call,
        // so a missing or misshapen declaration refuses on its own terms.
        const declared = String(serviceContainerId === undefined || serviceContainerId === null ? '' : serviceContainerId).trim().toLowerCase();
        if (!declared) {
            refuse('AZM_CI_SERVICE_CONTAINER_ID is not set. The workflow must export job.services.postgres.id; the guard will not fall back to a docker ps selection alone.');
        }
        if (!CONTAINER_ID_PATTERN.test(declared)) {
            refuse(`AZM_CI_SERVICE_CONTAINER_ID ("${declared}") is not a full 64-character container id, so it cannot identify a container unambiguously.`);
        }
        const inspector = overrides.inspectContainerIdentity || inspectContainerIdentity;
        const container = inspector({ address: expectedAddress, containerId, serviceContainerId: declared });
        // Enforced here as well as inside the inspector, so a replaced inspector
        // cannot return a container that is not the declared one.
        const inspectedId = String((container && container.containerId) || '').trim().toLowerCase();
        if (inspectedId !== declared) {
            refuse(`the inspected container ${inspectedId || '(none)'} is not the service container ${declared} declared by the workflow job.`);
        }
        return {
            database: target.database, host: target.host, serverAddress: server.address,
            identity: 'ci-container-identity', containerAddress: container.containerAddress, containerId: container.containerId,
            runner, backendPid: row ? Number(row.backend_pid) : null,
        };
    }

    // LOCAL: the transport proves nothing; prove the instance.
    const prober = overrides.probeLocalInstance || probeLocalInstance;
    const instance = prober({
        backendPid: row ? Number(row.backend_pid) : null,
        postmasterStartTime: row ? row.postmaster_start_time : null,
        dataDirectory: String(localDataDir || '').trim() || (row && row.data_directory ? String(row.data_directory) : ''),
        port: row ? row.port : target.port,
    });

    const serverSystemIdentifier = row && row.system_identifier ? String(row.system_identifier).trim() : '';
    if (!serverSystemIdentifier) refuse('the connected server did not report its pg_control system identifier, so it cannot be checked against the local cluster.');

    const controldata = (() => {
        const reader = overrides.readClusterSystemIdentifier || ((directory) => {
            let output;
            try { output = run(findPgControldata(), [directory]); } catch (err) {
                refuse(`pg_controldata could not read the local cluster "${directory}" (${String(err.message || '').split('\n')[0].slice(0, 100)}).`);
            }
            const match = /Database system identifier:\s*(\d+)/.exec(output);
            if (!match) refuse(`pg_controldata did not report a system identifier for "${directory}".`);
            return match[1];
        });
        return reader(instance.dataDirectory);
    })();
    // CONSISTENCY ONLY: a standby or clone shares this identifier, so it can
    // corroborate the instance proof but never replace it.
    if (serverSystemIdentifier !== controldata) {
        refuse(`the connected server belongs to cluster ${serverSystemIdentifier}, but the local cluster at "${instance.dataDirectory}" is ${controldata}.`);
    }

    return {
        database: target.database, host: target.host,
        serverAddress: server.reported === false ? null : server.address,
        identity: 'local-instance-identity', systemIdentifier: serverSystemIdentifier,
        dataDirectory: instance.dataDirectory, transport: server.reported === false ? 'unix-socket' : 'tcp',
        backendPid: instance.backendPid, postmasterPid: instance.postmasterPid,
        postmasterStarted: instance.postmasterStarted, ancestry: instance.ancestry,
    };
}

module.exports = {
    assertDisposableTestDatabase,
    CONTAINER_ID_ENV,
    EXPECTED_ADDRESS_ENV,
    LOCAL_DATA_DIR_ENV,
    ALLOWED_WORKFLOWS,
    CLOCK_SKEW_SECONDS,
    OIDC_AUDIENCE,
    OIDC_TOKEN_PATH_ENV,
    SERVICE_CONTAINER_ENV,
    classifyAddress,
    databaseNameFromUrl: (raw) => { const parsed = parseTarget(raw); return parsed ? parsed.database : null; },
    decodeJwt,
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
    probeLocalInstance,
    readProcStat,
    splitCidr,
    verifyRunnerIdentity,
};
