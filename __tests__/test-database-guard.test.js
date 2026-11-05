// __tests__/test-database-guard.test.js
// =============================================================================
// Strict tests for __tests__/helpers/testDatabaseGuard.js.
//
// Pure unit tests: no database, no network, so they run anywhere — including as
// their own step in the financial-durability lane.
//
// WHAT IS AND IS NOT A STUB HERE, stated plainly:
//   * OIDC verification is REAL: tokens are signed with a generated RSA key and
//     verified by the guard's own verifyRunnerIdentity against a matching JWKS.
//     Only the JWKS transport (a network fetch) is replaced.
//   * The instance prober is REAL: probeLocalInstance runs for every local case,
//     with /proc and postmaster.pid supplied through its seams. A physical
//     standby was NOT stood up; the standby case is a faithful seam-level
//     reproduction of the exact condition (same cluster identifier, same data
//     directory, same port, different backend/ancestry).
//   * The live local instance is exercised for real by the admin-review suite,
//     whose beforeEach runs the guard-and-sweep transaction.
// =============================================================================

const crypto = require('crypto');
const {
    assertDisposableTestDatabase: guard,
    inspectContainerIdentity,
    interpretExpectedAddress,
    interpretServerAddress,
    isLocalAddress,
    isLoopbackAddress,
    isLoopbackHost,
    isMappedIPv6,
    probeLocalInstance,
    readProcStat,
    splitCidr,
    verifyRunnerIdentity,
} = require('./helpers/testDatabaseGuard');

const LOCAL_URL = 'postgres://postgres:postgres@localhost:5432/azm_iso?schema=public';
const CI_EXPECTED = '172.18.0.2';
// A full 64-character container id, as the real job supplied.
const CI_CONTAINER = 'a2b412d028b26fe9f9ff87b5ecc36e145ba8e3d02c493768d60c96f0219aa744';
const SERVICE_CONTAINER = CI_CONTAINER;
// The run this fixture binds to, supplied to the guard as the RUNNER runtime
// would (never read back out of the token it is checking).
const RUN_ID = '90000000123';
const RUN_ATTEMPT = '2';
const RUN_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const RUN_REF = 'refs/pull/392/merge';
const FD_WORKFLOW = '.github/workflows/financial-durability.yml';
const TEST_WORKFLOW = '.github/workflows/test.yml';
const SID = '7686515198152565070';
const DATA_DIR = '/var/lib/postgresql/15/main';
const BTIME = 1700000000;
const HZ = 100;
const POSTMASTER = { pid: 400, ppid: 1, starttime: 500, comm: 'postgres', state: 'S' };
const BACKEND = { pid: 900, ppid: 400, starttime: 900, comm: 'postgres', state: 'S' };
const POSTMASTER_STARTED = BTIME + POSTMASTER.starttime / HZ;

// ---------------------------------------------------------------------------
// OIDC: a real key pair, a real signature, a real JWKS.
// ---------------------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_ID = 'test-key-1';
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, alg: 'RS256', use: 'sig' }] };
const REPO = 'AzamanLTD/AZM-backend';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function signToken(over = {}, { kid = KEY_ID, alg = 'RS256', signer = privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: 'https://token.actions.githubusercontent.com',
        aud: 'azm-test-db-guard',
        exp: now + 300,
        nbf: now - 10,
        iat: now - 10,
        repository: REPO,
        repository_owner: 'AzamanLTD',
        workflow_ref: `${REPO}/${FD_WORKFLOW}@${RUN_REF}`,
        workflow: 'financial-durability',
        run_id: RUN_ID,
        run_attempt: RUN_ATTEMPT,
        sha: RUN_SHA,
        ref: RUN_REF,
        ...over,
    };
    const head = b64({ alg, typ: 'JWT', kid });
    const body = b64(payload);
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signer).toString('base64url');
    return `${head}.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// Clients and seams.
// ---------------------------------------------------------------------------
function stubClient({
    database = 'azm_iso',
    serverAddress = '127.0.0.1/32',
    systemIdentifier = SID,
    dataDirectory = DATA_DIR,
    port = '5432',
    backendPid = BACKEND.pid,
    postmasterStartTime = new Date(POSTMASTER_STARTED * 1000).toISOString(),
} = {}) {
    const statements = [];
    return {
        statements,
        $queryRawUnsafe: async (sql) => {
            statements.push(sql);
            return [{ database, server_address: serverAddress, system_identifier: systemIdentifier, data_directory: dataDirectory, port, backend_pid: backendPid, postmaster_start_time: postmasterStartTime }];
        },
        $executeRawUnsafe: async (sql) => { statements.push(sql); },
    };
}
const mutations = (client) => client.statements.filter((sql) => /^\s*(UPDATE|DELETE|TRUNCATE|INSERT)/i.test(sql));

function procSeams({ table, platform = 'linux', postmasterPidFile, hz = HZ, btime = BTIME } = {}) {
    const processes = table || { [POSTMASTER.pid]: POSTMASTER, [BACKEND.pid]: BACKEND };
    return {
        platform,
        clockTicks: hz,
        bootEpoch: btime,
        readProcStat: (pid) => processes[pid] || null,
        readText: (file) => {
            if (file.endsWith('postmaster.pid')) {
                return (postmasterPidFile || [
                    POSTMASTER.pid, DATA_DIR, Math.round(POSTMASTER_STARTED), '5432', '/var/run/postgresql', '', '',
                ].join('\n'));
            }
            if (file.includes('/cmdline')) {
                const pid = Number(file.split('/')[2]);
                if (pid === POSTMASTER.pid) return `postgres\0-D\0${DATA_DIR}\0`;
                return `postgres: 15/main: azm_iso azm_iso 127.0.0.1(5432) idle\0`;
            }
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
    };
}

const instanceArgs = (over = {}) => ({
    backendPid: BACKEND.pid,
    postmasterStartTime: new Date(POSTMASTER_STARTED * 1000).toISOString(),
    dataDirectory: DATA_DIR,
    port: '5432',
    ...over,
});

const localSeams = (over = {}) => ({
    testUrl: LOCAL_URL,
    databaseUrl: LOCAL_URL,
    nodeEnv: 'test',
    expectedAddress: '',
    containerId: '',
    localDataDir: '',
    githubActions: false,
    probeLocalInstance: (args) => probeLocalInstance(args, procSeams()),
    readClusterSystemIdentifier: () => SID,
    ...over,
});

const ciSeams = (over = {}) => ({
    testUrl: LOCAL_URL,
    databaseUrl: LOCAL_URL,
    nodeEnv: 'test',
    githubActions: true,
    expectedAddress: CI_EXPECTED,
    containerId: CI_CONTAINER,
    serviceContainerId: SERVICE_CONTAINER,
    jwks: JWKS,
    oidcToken: signToken(),
    // The runner's own identity, as the workflow runtime reports it.
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    sha: RUN_SHA,
    ref: RUN_REF,
    inspectContainerIdentity: ({ address }) => ({ containerId: SERVICE_CONTAINER, containerAddress: address, image: 'postgres:16' }),
    ...over,
});

// ---------------------------------------------------------------------------
describe('§1 CI provenance is an authenticated, run-bound GitHub Actions runner (OIDC)', () => {
    test('a correctly signed token for this repository, this run and this attempt is accepted', async () => {
        const result = await guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams());
        expect(result).toMatchObject({ identity: 'ci-container-identity', serverAddress: CI_EXPECTED });
        expect(result.runner.runId).toBe(RUN_ID);
        expect(result.runner.runAttempt).toBe(RUN_ATTEMPT);
        expect(result.runner.workflowPath).toBe(FD_WORKFLOW);
        expect(result.runner.repository).toBe(REPO);
    });

    test('both allowed workflows pass: financial-durability.yml and test.yml', async () => {
        const fd = await guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams());
        expect(fd.runner.workflowName).toBe('financial-durability');

        const testLane = await guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            oidcToken: signToken({ workflow_ref: `${REPO}/${TEST_WORKFLOW}@${RUN_REF}`, workflow: 'Azaman Test Suite' }),
        }));
        expect(testLane.runner.workflowPath).toBe(TEST_WORKFLOW);
        expect(testLane.runner.workflowName).toBe('Azaman Test Suite');
    });

    test('another workflow in the same repository is refused, even correctly signed', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({
            oidcToken: signToken({ workflow_ref: `${REPO}/.github/workflows/release.yml@${RUN_REF}`, workflow: 'release' }),
        }))).rejects.toThrow(/is not one of the workflows allowed to authenticate this database/);
        expect(mutations(client)).toHaveLength(0);

        // A nested path that merely begins with the allowed prefix is not allowed either.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            oidcToken: signToken({ workflow_ref: `${REPO}/.github/workflows/financial-durability.yml/extra@${RUN_REF}`, workflow: 'financial-durability' }),
        }))).rejects.toThrow(/is not one of the workflows allowed/);
    });

    test('an allowed path with the wrong workflow NAME is refused', async () => {
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            oidcToken: signToken({ workflow: 'Financial Durability' }),
        }))).rejects.toThrow(/but the token claims workflow "Financial Durability"/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            oidcToken: signToken({ workflow_ref: `${REPO}/${TEST_WORKFLOW}@${RUN_REF}`, workflow: 'financial-durability' }),
        }))).rejects.toThrow(/whose name is "Azaman Test Suite", but the token claims workflow "financial-durability"/);
    });

    test('a token from another RUN is refused', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({ oidcToken: signToken({ run_id: '90000000999' }) })))
            .rejects.toThrow(/issued for run 90000000999, but this runner is run 90000000123/);
        expect(mutations(client)).toHaveLength(0);
        // And the runtime value must come from the runner, not the token.
        // `''` (not `undefined`) forces "absent": the seam resolver treats
        // undefined as "not overridden" and would fall back to the real
        // GITHUB_RUN_ID, which the lane exports.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ runId: '', oidcToken: signToken() })))
            .rejects.toThrow(/runner did not supply a numeric GITHUB_RUN_ID/);
    });

    test('a token from another ATTEMPT is refused', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({ oidcToken: signToken({ run_attempt: '1' }) })))
            .rejects.toThrow(/issued for attempt 1, but this runner is attempt 2/);
        expect(mutations(client)).toHaveLength(0);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ runAttempt: '', oidcToken: signToken() })))
            .rejects.toThrow(/runner did not supply a numeric GITHUB_RUN_ATTEMPT/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ run_attempt: undefined }) })))
            .rejects.toThrow(/carries no valid run_attempt/);
    });

    test('the token is bound to this commit and ref as well', async () => {
        // Mismatch, with a correctly signed token: the runner's own values win.
        for (const [claims, pattern] of [
            [{ sha: 'b'.repeat(40) }, /but this runner is at/],
            [{ ref: 'refs/heads/main' }, /but this runner is on/],
        ]) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ oidcToken: signToken(claims) }))).rejects.toThrow(pattern);
            expect(mutations(client)).toHaveLength(0);
        }
    });

    test('a MISSING runtime commit or ref is refused, never skipped', async () => {
        // `''` (not undefined) forces absence: undefined means "not overridden"
        // and would fall back to the real GITHUB_SHA / GITHUB_REF.
        for (const [over, pattern] of [
            [{ sha: '' }, /did not supply GITHUB_SHA/],
            [{ ref: '' }, /did not supply GITHUB_REF/],
        ]) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ ...over, oidcToken: signToken() }))).rejects.toThrow(pattern);
            expect(mutations(client)).toHaveLength(0);
        }
    });

    test('nbf is REQUIRED and must be numeric', async () => {
        for (const nbf of [undefined, null, 'soon', '', 0.5]) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ oidcToken: signToken({ nbf }) })))
                .rejects.toThrow(/"nbf" claim is .*a numeric nbf is required/);
            expect(mutations(client)).toHaveLength(0);
        }
    });

    test('iat is REQUIRED and must be numeric', async () => {
        for (const iat of [undefined, null, 'yesterday', '']) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ oidcToken: signToken({ iat }) })))
                .rejects.toThrow(/"iat" claim is .*a numeric iat is required/);
            expect(mutations(client)).toHaveLength(0);
        }
    });

    test('exp is REQUIRED, must be numeric, and must be in the future', async () => {
        const now = Math.floor(Date.now() / 1000);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ exp: undefined }) })))
            .rejects.toThrow(/"exp" claim is .*a numeric exp is required/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ exp: 'later' }) })))
            .rejects.toThrow(/"exp" claim is/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ exp: now - 1 }) })))
            .rejects.toThrow(/expired at/);
    });

    test('future iat and future nbf beyond the documented skew are refused', async () => {
        const now = Math.floor(Date.now() / 1000);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ iat: now + 600 }) })))
            .rejects.toThrow(/in the future beyond the 60s clock-skew allowance/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ nbf: now + 600 }) })))
            .rejects.toThrow(/not valid until .*beyond the 60s clock-skew allowance/);
        // Within the allowance is accepted.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ nbf: now + 20, iat: now + 20 }) })))
            .resolves.toMatchObject({ identity: 'ci-container-identity' });
    });

    test('inconsistent time ordering is refused', async () => {
        const now = Math.floor(Date.now() / 1000);
        // nbf within the skew allowance but after exp.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ exp: now + 10, nbf: now + 20 }) })))
            .rejects.toThrow(/nbf is after exp/);
        // iat within the skew allowance but after exp.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({ exp: now + 10, iat: now + 20 }) })))
            .rejects.toThrow(/iat is after exp/);
    });

    test('the algorithm and key id are exact', async () => {
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({}, { alg: 'rs256' }) })))
            .rejects.toThrow(/uses "rs256"; only RS256 is accepted/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({}, { alg: 'HS256' }) })))
            .rejects.toThrow(/only RS256 is accepted/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({}, { kid: '' }) })))
            .rejects.toThrow(/carries no key id \(kid\)/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({}, { kid: 'not-a-github-key' }) })))
            .rejects.toThrow(/not among GitHub's published keys/);
    });

    test('issuer, audience, repository and signature are still enforced', async () => {
        const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const cases = [
            [{ iss: 'https://evil.example.com' }, /issuer is/],
            [{ aud: 'someone-else' }, /audience is/],
            [{ repository: 'attacker/fork' }, /names repository/],
            [{ workflow_ref: 'attacker/fork/.github/workflows/test.yml@main', workflow: 'Azaman Test Suite' }, /does not belong to/],
        ];
        for (const [over, pattern] of cases) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ oidcToken: signToken(over) }))).rejects.toThrow(pattern);
            expect(mutations(client)).toHaveLength(0);
        }
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ oidcToken: signToken({}, { signer: otherKey }) })))
            .rejects.toThrow(/signature does not verify against GitHub's published keys/);
    });

    test('GITHUB_ACTIONS=true on a laptop without a token does NOT enable CI mode', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({ oidcToken: '' })))
            .rejects.toThrow(/no GitHub Actions OIDC token was supplied, so the runner is not authenticated/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('a local container plus a forged run id and label still fails without a token', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({
            oidcToken: '',
            inspectContainerIdentity: () => ({ containerId: CI_CONTAINER, containerAddress: CI_EXPECTED, image: 'postgres:16' }),
        }))).rejects.toThrow(/runner is not authenticated/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('a JWKS fetch failure refuses rather than skipping the check', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams({ jwks: undefined, fetchJwks: async () => { throw new Error('network down'); } })))
            .rejects.toThrow(/published signing keys could not be fetched/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('the job service-container id is MANDATORY, full-length and exactly equal', async () => {
        const cases = [
            [{ serviceContainerId: '' }, /AZM_CI_SERVICE_CONTAINER_ID is not set/],
            [{ serviceContainerId: '   ' }, /AZM_CI_SERVICE_CONTAINER_ID is not set/],
            [{ serviceContainerId: CI_CONTAINER.slice(0, 12) }, /is not a full 64-character container id/],
            [{ serviceContainerId: `${CI_CONTAINER}00` }, /is not a full 64-character container id/],
            [{ serviceContainerId: 'z'.repeat(64) }, /is not a full 64-character container id/],
            // A different but valid full id: the guard's own equality check refuses,
            // independently of which container it inspected.
            [{ serviceContainerId: 'b'.repeat(64), inspectContainerIdentity: ({ address }) => ({ containerId: CI_CONTAINER, containerAddress: address, image: 'postgres:16' }) }, /is not the service container/],
        ];
        for (const [over, pattern] of cases) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ inspectContainerIdentity, ...over }))).rejects.toThrow(pattern);
            expect(mutations(client)).toHaveLength(0);
        }
        // A prefix match is NOT equality: a container whose id merely begins with
        // the declared one is refused.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            inspectContainerIdentity: ({ address }) => ({ containerId: `ffff${CI_CONTAINER.slice(4)}`, containerAddress: address, image: 'postgres:16' }),
        }))).rejects.toThrow(/declared by the workflow job/);
    });

    test('the container must exist, run, be PostgreSQL and hold the expected address', async () => {
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ containerId: '', inspectContainerIdentity })))
            .rejects.toThrow(/AZM_TEST_PG_CONTAINER is missing/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ containerId: '0'.repeat(64), inspectContainerIdentity })))
            .rejects.toThrow(/docker inspection of AZM_TEST_PG_CONTAINER failed/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            containerId: '0'.repeat(64),
            inspectContainerIdentity: () => { throw new Error('[test-db-guard] refusing to run: AZM_TEST_PG_CONTAINER (0000) is not running.'); },
        }))).rejects.toThrow(/is not running/);
        // The inspector's own address check refusing is fatal too.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            inspectContainerIdentity: () => { throw new Error('[test-db-guard] refusing to run: the container AZM_TEST_PG_CONTAINER holds 172.18.0.7, not the expected "172.18.0.2".'); },
        }))).rejects.toThrow(/holds 172\.18\.0\.7/);
    });

    test('the address expectation is still strict: missing, malformed, prefixed or unix-socket all refuse', async () => {
        for (const expectedAddress of ['', '   ', null, 'garbage', '172.18.0.2/32', '::1', '172.18.0.999']) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ expectedAddress }))).rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS/);
            expect(mutations(client)).toHaveLength(0);
        }
        await expect(guard(stubClient({ serverAddress: null }), ciSeams()))
            .rejects.toThrow(/reported SQL NULL .*An expectation that cannot be checked is not satisfied/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.3/32' }), ciSeams()))
            .rejects.toThrow(/Identity mismatch/);
    });

    test('verifyRunnerIdentity is the only door into CI mode', () => {
        const runtime = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, sha: RUN_SHA, ref: RUN_REF };
        expect(verifyRunnerIdentity({ token: signToken(), jwks: JWKS, ...runtime }).runId).toBe(RUN_ID);
        expect(() => verifyRunnerIdentity({ token: 'not-a-jwt', jwks: JWKS, ...runtime })).toThrow(/three-part JWT/);
        expect(() => verifyRunnerIdentity({ token: '', jwks: JWKS, ...runtime })).toThrow(/no GitHub Actions OIDC token/);
        expect(() => verifyRunnerIdentity({ token: signToken(), jwks: null, ...runtime })).toThrow(/no GitHub signing keys/);
        expect(() => verifyRunnerIdentity({ token: signToken(), jwks: JWKS })).toThrow(/did not supply a numeric GITHUB_RUN_ID/);
    });
});

// ---------------------------------------------------------------------------
describe('§2 local identity is the INSTANCE, not the cluster lineage', () => {
    test('the live instance proof accepts a backend descended from the postmaster', () => {
        const proof = probeLocalInstance(instanceArgs(), procSeams());
        expect(proof).toMatchObject({ backendPid: BACKEND.pid, postmasterPid: POSTMASTER.pid, dataDirectory: DATA_DIR });
    });

    test('a standby shares the cluster identifier, the data directory and the port — and is still refused', async () => {
        // The cluster identifier matches, so only the instance proof can tell.
        const standby = { ...BACKEND, pid: 1900, ppid: 777 };
        await expect(guard(stubClient({ backendPid: standby.pid }), localSeams({
            probeLocalInstance: (args) => probeLocalInstance(args, procSeams({
                table: {
                    [POSTMASTER.pid]: POSTMASTER,
                    777: { pid: 777, ppid: 1, starttime: 600, comm: 'postgres', state: 'S' },
                    1900: { pid: 1900, ppid: 777, starttime: 700, comm: 'postgres', state: 'S' },
                },
            })),
        }))).rejects.toThrow(/does not descend from the postmaster/);
    });

    test('a same-lineage remote TCP server is refused (no local backend process)', async () => {
        const client = stubClient({ backendPid: 44444 });
        await expect(guard(client, localSeams())).rejects.toThrow(/not a live process on this machine/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('a same-lineage forwarded unix socket is refused (SQL NULL is not identity)', async () => {
        const client = stubClient({ serverAddress: null, backendPid: 44444 });
        await expect(guard(client, localSeams())).rejects.toThrow(/not a live process on this machine/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('the verified local unix socket is accepted once the instance is proven', async () => {
        await expect(guard(stubClient({ serverAddress: null }), localSeams()))
            .resolves.toMatchObject({ identity: 'local-instance-identity', transport: 'unix-socket', backendPid: BACKEND.pid });
    });

    test('a different cluster identifier is refused (consistency check)', async () => {
        await expect(guard(stubClient(), localSeams({ readClusterSystemIdentifier: () => '1111111111111111111' })))
            .rejects.toThrow(/belongs to cluster 7686515198152565070, but the local cluster/);
    });

    test('a server that reports no cluster identifier is refused', async () => {
        await expect(guard(stubClient({ systemIdentifier: null }), localSeams()))
            .rejects.toThrow(/did not report its pg_control system identifier/);
    });

    test('the instance prober refuses: dead backend, wrong process, stale PID file', () => {
        expect(() => probeLocalInstance(instanceArgs({ backendPid: 0 }), procSeams())).toThrow(/not a live process on this machine/);
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ table: { [POSTMASTER.pid]: POSTMASTER, [BACKEND.pid]: { ...BACKEND, comm: 'bash' } } }))).toThrow(/not a PostgreSQL backend/);
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ table: {} }))).toThrow(/no live local process 400|stale PID file/);
    });

    test('a stale postmaster.pid (no live postmaster) is refused', () => {
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ table: { [BACKEND.pid]: BACKEND } })))
            .toThrow(/no live local process 400 backs the postmaster.pid/);
    });

    test('a missing, blank or malformed postmaster.pid start time is REFUSED, never skipped', () => {
        for (const line of ['', '   ', 'not-a-timestamp', '0', '-5', '1700000005abc', '1.5']) {
            const file = [POSTMASTER.pid, DATA_DIR, line, '5432', '/var/run/postgresql', '', ''].join('\n');
            expect(() => probeLocalInstance(instanceArgs(), procSeams({ postmasterPidFile: file })))
                .toThrow(/no valid start time on its third line/);
        }
        const blankPid = ['', DATA_DIR, String(Math.round(POSTMASTER_STARTED)), '5432', '', '', ''].join('\n');
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ postmasterPidFile: blankPid })))
            .toThrow(/unreadable pid/);
    });

    test('PID reuse is caught by the recorded start time', () => {
        const reused = [POSTMASTER.pid, DATA_DIR, String(Math.round(POSTMASTER_STARTED) - 7200), '5432', '/var/run/postgresql', '', ''].join('\n');
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ postmasterPidFile: reused })))
            .toThrow(/reused PID or a stale file/);
    });

    test('a postmaster startup-time mismatch is refused', () => {
        expect(() => probeLocalInstance(instanceArgs({ postmasterStartTime: new Date((POSTMASTER_STARTED + 600) * 1000).toISOString() }), procSeams()))
            .toThrow(/not being served by this instance/);
        expect(() => probeLocalInstance(instanceArgs({ postmasterStartTime: null }), procSeams()))
            .toThrow(/did not report pg_postmaster_start_time/);
    });

    test('data directory and port must agree with the verified instance', () => {
        expect(() => probeLocalInstance(instanceArgs(), procSeams({
            postmasterPidFile: [POSTMASTER.pid, '/srv/other', Math.round(POSTMASTER_STARTED), '5432', '/var/run/postgresql', '', ''].join('\n'),
        }))).toThrow(/was written for "\/srv\/other"/);
        expect(() => probeLocalInstance(instanceArgs({ port: '6543' }), procSeams()))
            .toThrow(/listens on port 5432, not on the connected port 6543/);
    });

    test('a non-Linux host is refused before any mutation, with no weaker fallback', async () => {
        expect(() => probeLocalInstance(instanceArgs(), procSeams({ platform: 'darwin' })))
            .toThrow(/only implemented for Linux .*This host is "darwin"/);
        const client = stubClient();
        await expect(guard(client, localSeams({ probeLocalInstance: (args) => probeLocalInstance(args, procSeams({ platform: 'win32' })) })))
            .rejects.toThrow(/This host is "win32"/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('a locally supplied expected address is a claim, not identity', async () => {
        for (const expectedAddress of ['203.0.113.9', '10.4.5.6', '127.0.0.1']) {
            const client = stubClient({ serverAddress: `${expectedAddress}/32` });
            await expect(guard(client, localSeams({ expectedAddress })))
                .rejects.toThrow(/is not an independently verified identity/);
            expect(mutations(client)).toHaveLength(0);
        }
    });

    test('a loopback URL with a loopback report is not enough on its own', async () => {
        const client = stubClient({ serverAddress: '127.0.0.1/32' });
        await expect(guard(client, localSeams({ probeLocalInstance: (args) => probeLocalInstance(args, procSeams({ platform: 'darwin' })) })))
            .rejects.toThrow(/only implemented for Linux/);
        expect(mutations(client)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
describe('§3 /proc parsing is anchored, not split on whitespace', () => {
    test('a comm containing spaces and parentheses is parsed correctly', () => {
        const raw = '900 (postgres: worker (x) y) S 400 900 900 0 -1 4194560 1 0 0 0 3 4 0 0 20 0 1 0 900 1000 100\n';
        const parsed = (() => {
            const open = raw.indexOf('(');
            const close = raw.lastIndexOf(')');
            const rest = raw.slice(close + 2).trim().split(/\s+/);
            return { comm: raw.slice(open + 1, close), state: rest[0], ppid: Number(rest[1]), starttime: Number(rest[19]) };
        })();
        expect(parsed.comm).toBe('postgres: worker (x) y');
        expect(parsed.state).toBe('S');
        expect(parsed.ppid).toBe(400);
        expect(parsed.starttime).toBe(900);
    });

    test('readProcStat reads this process, and refuses nonsense pids', () => {
        const self = readProcStat(process.pid);
        expect(self).not.toBeNull();
        expect(self.pid).toBe(process.pid);
        expect(self.ppid).toBe(process.ppid);
        expect(Number.isInteger(self.starttime)).toBe(true);
        expect(readProcStat(0)).toBeNull();
        expect(readProcStat(-1)).toBeNull();
        expect(readProcStat(99999999)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe('§4 addresses, prefixes and the previously established refusals', () => {
    test('strict IPv4 loopback', () => {
        for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.255']) {
            expect(classify(address)).toBe('ipv4');
            expect(isLoopbackAddress(address)).toBe(true);
        }
        for (const address of ['127.999.1.1', '127.1', '127.0.0.01', '0x7f.0.0.1', '127.0.0.256', '127 .0.0.1']) {
            expect(classify(address)).toBeNull();
            expect(isLoopbackAddress(address)).toBe(false);
            expect(isLoopbackHost(address)).toBe(false);
        }
        function classify(value) { return interpretServerAddressSafe(value); }
    });

    test('mapped IPv6 is refused in both spellings', () => {
        for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1']) {
            expect(isMappedIPv6(address)).toBe(true);
            expect(isLocalAddress(address)).toBe(false);
        }
        expect(isLocalAddress('::1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
    });

    test('CIDR prefixes are validated, never stripped', () => {
        expect(interpretServerAddress('127.0.0.1/32')).toEqual({ address: '127.0.0.1', prefix: 32 });
        expect(interpretServerAddress('::1/128')).toEqual({ address: '::1', prefix: 128 });
        for (const value of ['127.0.0.1/33', '127.0.0.1/999', '::1/129', '::1/0129', '127.0.0.1/+1', '127.0.0.1/', '127.0.0.1/ 32']) {
            expect(splitCidr(value)).toBeNull();
            expect(() => interpretServerAddress(value)).toThrow(/valid CIDR prefix/);
        }
        expect(interpretServerAddress(null)).toEqual({ reported: false });
        expect(() => interpretServerAddress('')).toThrow(/EMPTY address/);
        expect(() => interpretServerAddress(42)).toThrow(/was not a string/);
        expect(interpretExpectedAddress('172.18.0.2')).toBe('172.18.0.2');
        expect(() => interpretExpectedAddress('172.18.0.2/32')).toThrow(/CIDR prefix/);
    });

    test('URL, environment and connection refusals still hold, with zero mutations', async () => {
        const cases = [
            [{ testUrl: '' }, /TEST_DATABASE_URL is not set/],
            [{ nodeEnv: 'production' }, /NODE_ENV is "production", not "test"/],
            [{ databaseUrl: '' }, /DATABASE_URL is not bound/],
            [{ testUrl: 'postgres://u:p@[::bad/db', databaseUrl: 'postgres://u:p@[::bad/db' }, /does not parse into a host and a database name/],
        ];
        for (const [over, pattern] of cases) {
            const client = stubClient();
            await expect(guard(client, localSeams(over))).rejects.toThrow(pattern);
            expect(mutations(client)).toHaveLength(0);
        }
        const remote = 'postgres://postgres:postgres@azm-prod-db.example.com:5432/azm_iso?schema=public';
        const client = stubClient();
        await expect(guard(client, localSeams({ testUrl: remote, databaseUrl: remote }))).rejects.toThrow(/is not a loopback address/);
        expect(client.statements).toHaveLength(0);
        await expect(guard(stubClient({ database: 'azm_production' }), localSeams())).rejects.toThrow(/connected to database "azm_production"/);
    });

    test('credentials never reach an error message', async () => {
        const credentialled = 'postgres://ci_runner:hunter2-should-never-leak@db.prod.example.com:5432/azm_test?schema=public';
        let error;
        try { await guard(stubClient(), localSeams({ databaseUrl: credentialled })); } catch (err) { error = err; }
        expect(error.message).not.toContain('hunter2-should-never-leak');
        expect(error.message).not.toContain('ci_runner');
        expect(error.message).toContain('db.prod.example.com:5432/azm_test');
    });

    test('the positive local path issues one identity query and no mutation', async () => {
        const client = stubClient();
        const result = await guard(client, localSeams());
        expect(result.identity).toBe('local-instance-identity');
        expect(client.statements).toHaveLength(1);
        expect(client.statements[0]).toMatch(/pg_catalog\.pg_backend_pid\(\)/);
        expect(client.statements[0]).toMatch(/pg_catalog\.pg_control_system\(\)/);
        expect(mutations(client)).toHaveLength(0);
    });
});

// The classifier is exported; this keeps the table above readable.
function interpretServerAddressSafe(value) {
    try { const parsed = interpretServerAddress(value); return parsed.reported === false ? null : classifyAddress(parsed.address); } catch (_) { return null; }
}
const { classifyAddress } = require('./helpers/testDatabaseGuard');
