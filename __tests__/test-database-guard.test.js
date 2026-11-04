// __tests__/test-database-guard.test.js
// =============================================================================
// Strict tests for __tests__/helpers/testDatabaseGuard.js.
//
// Pure unit tests: no database, no connection string, so they run anywhere —
// including as their own step in the financial-durability lane.
//
// The guard is the last line of defence in front of a table-wide maintenance
// statement. What these tests care about most is the thing a name, a hostname,
// a loopback report or a caller-supplied address CANNOT prove: that the server
// is disposable. So the matrix is organised around identity, not around shape.
// =============================================================================

const {
    assertDisposableTestDatabase: guard,
    inspectContainerIdentity,
    classifyAddress,
    describeTarget,
    interpretExpectedAddress,
    interpretServerAddress,
    isLocalAddress,
    isLoopbackAddress,
    isLoopbackHost,
    isMappedIPv6,
    splitCidr,
} = require('./helpers/testDatabaseGuard');

const LOCAL_URL = 'postgres://postgres:postgres@localhost:5432/azm_iso?schema=public';
const CI_EXPECTED = '172.18.0.2';
const CI_CONTAINER = '2f206542ec5f';
const LOCAL_SID = '7686515198152565070';

// A client that reports an identity and records every statement, so "refused"
// also means "the caller's UPDATE never reached the database".
function stubClient({
    database = 'azm_iso',
    serverAddress = '127.0.0.1/32',
    systemIdentifier = LOCAL_SID,
    dataDirectory = '/var/lib/postgresql/15/main',
    port = '5432',
} = {}) {
    const statements = [];
    return {
        statements,
        $queryRawUnsafe: async (sql) => {
            statements.push(sql);
            return [{ database, server_address: serverAddress, system_identifier: systemIdentifier, data_directory: dataDirectory, port }];
        },
        $executeRawUnsafe: async (sql) => { statements.push(sql); },
    };
}

const mutations = (client) => client.statements.filter((sql) => /^\s*(UPDATE|DELETE|TRUNCATE|INSERT)/i.test(sql));

// Local-mode seams: the machine's own cluster is stubbed to the same identity
// the fake server reports, which is what the real probe establishes.
const localProof = (over = {}) => ({ systemIdentifier: LOCAL_SID, dataDirectory: '/var/lib/postgresql/15/main', postmasterPid: 422, port: '5432', ...over });
const seams = (over = {}) => ({
    testUrl: LOCAL_URL,
    databaseUrl: LOCAL_URL,
    nodeEnv: 'test',
    expectedAddress: '',
    containerId: '',
    localDataDir: '/var/lib/postgresql/15/main',
    githubActions: false,
    probeLocalCluster: () => localProof(),
    ...over,
});

const ciSeams = (over = {}) => seams({
    githubActions: true,
    expectedAddress: CI_EXPECTED,
    containerId: CI_CONTAINER,
    inspectContainerIdentity: ({ address }) => ({ containerId: CI_CONTAINER, containerAddress: address, image: 'postgres:16' }),
    ...over,
});

describe('§1 GitHub Actions proves an exact container identity', () => {
    test('the exact container address is accepted, after docker verification', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, ciSeams())).resolves.toMatchObject({
            database: 'azm_iso', serverAddress: '172.18.0.2', identity: 'ci-container-identity', containerAddress: '172.18.0.2',
        });
        expect(mutations(client)).toHaveLength(0);
    });

    test('a different address inside 172.18.0.0/16 is refused', async () => {
        await expect(guard(stubClient({ serverAddress: '172.18.0.3/32' }), ciSeams()))
            .rejects.toThrow(/server reports address "172\.18\.0\.3", but the expected disposable database address is "172\.18\.0\.2"/);
    });

    test('172.20.5.9 and 172.31.9.9 are refused — inside the retired 172.16/12 allowance', async () => {
        for (const address of ['172.20.5.9', '172.31.9.9']) {
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), ciSeams()))
                .rejects.toThrow(/but the expected disposable database address is/);
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), ciSeams({ githubActions: true, expectedAddress: '' })))
                .rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS is not set/);
        }
    });

    test('10/8, 192.168/16 and public addresses are refused', async () => {
        for (const address of ['10.4.1.9', '192.168.1.4', '203.0.113.7', '8.8.8.8']) {
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), ciSeams()))
                .rejects.toThrow(/but the expected disposable database address is/);
        }
    });

    test('a mismatch is refused before the caller\'s UPDATE, after only the identity query', async () => {
        const client = stubClient({ serverAddress: '172.18.0.9/32' });
        await expect(guard(client, ciSeams())).rejects.toThrow(/Identity mismatch/);
        expect(mutations(client)).toHaveLength(0);
        expect(client.statements).toHaveLength(1);
        expect(client.statements[0]).toMatch(/pg_control_system\(\)/);
    });

    test('a missing expectation fails closed with zero queries', async () => {
        for (const expectedAddress of ['', '   ', undefined]) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ expectedAddress }))).rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS is not set/);
            expect(client.statements).toHaveLength(0);
        }
    });

    test('a malformed or ambiguous expectation fails closed with zero queries', async () => {
        for (const expectedAddress of ['garbage', '172.18.0.2 172.18.0.3', 'localhost', '::ffff:172.18.0.2', '::1', '172.18.0.2/32']) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, ciSeams({ expectedAddress }))).rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS/);
            expect(client.statements).toHaveLength(0);
        }
    });

    test('the expectation must be backed by a verified container, not just supplied', async () => {
        // server and expectation agree, but the container cannot be verified.
        const unverified = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(unverified, ciSeams({ containerId: '', inspectContainerIdentity })))
            .rejects.toThrow(/AZM_TEST_PG_CONTAINER is missing or is not a container id/);
        expect(mutations(unverified)).toHaveLength(0);

        // docker itself is unavailable (a local machine faking GITHUB_ACTIONS).
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({ inspectContainerIdentity })))
            .rejects.toThrow(/docker inspection of AZM_TEST_PG_CONTAINER failed/);

        // the container exists but is not running / not postgres / holds another address.
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            inspectContainerIdentity: () => { throw new Error('[test-db-guard] refusing to run: AZM_TEST_PG_CONTAINER (2f206542ec5f) is not running.'); },
        }))).rejects.toThrow(/is not running/);
        await expect(guard(stubClient({ serverAddress: '172.18.0.2/32' }), ciSeams({
            inspectContainerIdentity: () => { throw new Error('[test-db-guard] refusing to run: the container AZM_TEST_PG_CONTAINER holds 172.18.0.7, not the expected "172.18.0.2".'); },
        }))).rejects.toThrow(/holds 172\.18\.0\.7/);
    });

    test('an expectation that cannot be checked against a unix socket is not satisfied', async () => {
        await expect(guard(stubClient({ serverAddress: null }), ciSeams()))
            .rejects.toThrow(/reported SQL NULL .*An expectation that cannot be checked is not satisfied/);
    });
});

describe('§2 local mode refuses a loopback or socket The connection cannot prove', () => {
    test('a caller-supplied public expected address is refused even when the server agrees', async () => {
        await expect(guard(stubClient({ serverAddress: '203.0.113.9/32' }), seams({ expectedAddress: '203.0.113.9' })))
            .rejects.toThrow(/is not an independently verified identity/);
    });

    test('a caller-supplied private expected address is refused even when the server agrees', async () => {
        await expect(guard(stubClient({ serverAddress: '10.4.5.6/32' }), seams({ expectedAddress: '10.4.5.6' })))
            .rejects.toThrow(/is not an independently verified identity/);
    });

    test('a caller-supplied LOOPBACK expected address is refused too', async () => {
        await expect(guard(stubClient({ serverAddress: '127.0.0.1/32' }), seams({ expectedAddress: '127.0.0.1' })))
            .rejects.toThrow(/is not an independently verified identity/);
    });

    test('a loopback URL with a loopback server report is NOT enough — an ssh -L tunnel looks like this', async () => {
        const tunnelled = stubClient({ serverAddress: '127.0.0.1/32', systemIdentifier: '1111111111111111111' });
        await expect(guard(tunnelled, seams()))
            .rejects.toThrow(/belongs to cluster 1111111111111111111, but this machine's cluster at .* is 7686515198152565070/);
        expect(mutations(tunnelled)).toHaveLength(0);
        expect(tunnelled.statements).toHaveLength(1);
    });

    test('a forwarded unix socket (SQL NULL) is not accepted on its own', async () => {
        const forwarded = stubClient({ serverAddress: null, systemIdentifier: '2222222222222222222' });
        await expect(guard(forwarded, seams()))
            .rejects.toThrow(/A forwarded, tunnelled or proxied server is not a disposable local target/);
        expect(mutations(forwarded)).toHaveLength(0);
    });

    test('a forwarded unix socket whose cluster cannot be read locally is refused', async () => {
        await expect(guard(stubClient({ serverAddress: null }), seams({
            probeLocalCluster: () => { throw new Error('[test-db-guard] refusing to run: the local cluster data directory "/var/lib/postgresql/15/main" is not readable by this process (EACCES).'); },
        }))).rejects.toThrow(/is not readable by this process/);
    });

    test('a local unix socket IS supported once the cluster identity is proven', async () => {
        await expect(guard(stubClient({ serverAddress: null }), seams())).resolves.toMatchObject({
            database: 'azm_iso', serverAddress: null, identity: 'local-cluster-identity', transport: 'unix-socket',
        });
    });

    test('the local cluster proof must own the connected data directory', async () => {
        await expect(guard(stubClient({ dataDirectory: '/srv/other-cluster' }), seams()))
            .rejects.toThrow(/runs from "\/srv\/other-cluster", not from the local cluster/);
    });

    test('a server that cannot report its cluster identity is refused', async () => {
        await expect(guard(stubClient({ systemIdentifier: null }), seams()))
            .rejects.toThrow(/did not report its pg_control system identifier/);
    });

    test('local mode reaches the identity refusal only after the URL and database checks', async () => {
        const client = stubClient({ database: 'azm_production', serverAddress: '127.0.0.1/32' });
        await expect(guard(client, seams())).rejects.toThrow(/connected to database "azm_production"/);
        expect(mutations(client)).toHaveLength(0);
    });
});

describe('§3 strict IPv4 loopback validation', () => {
    test('valid loopback addresses are accepted', () => {
        for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.255']) {
            expect(classifyAddress(address)).toBe('ipv4');
            expect(isLoopbackAddress(address)).toBe(true);
        }
    });

    test('127.999.1.1 is refused — it is not an IPv4 address', () => {
        expect(classifyAddress('127.999.1.1')).toBeNull();
        expect(isLoopbackAddress('127.999.1.1')).toBe(false);
        expect(isLoopbackHost('127.999.1.1')).toBe(false);
    });

    test('malformed and noncanonical numeric forms are refused', () => {
        for (const address of ['127.1', '127.0.0', '127.0.0.1.1', '127.0.0.01', '0x7f.0.0.1', '127.0.0.-1', '127.0.0.256', '127 .0.0.1']) {
            expect(classifyAddress(address)).toBeNull();
            expect(isLoopbackAddress(address)).toBe(false);
        }
        expect(classifyAddress(' 127.0.0.1 ')).toBe('ipv4');
    });

    test('ordinary non-loopback IPv4 addresses are refused', () => {
        for (const address of ['128.0.0.1', '10.0.0.1', '172.18.0.2', '192.168.0.1', '8.8.8.8']) {
            expect(classifyAddress(address)).toBe('ipv4');
            expect(isLocalAddress(address)).toBe(false);
        }
    });

    test('an invalid address is refused before any database query', async () => {
        const client = stubClient();
        const url = 'postgres://u:p@127.999.1.1:5432/azm_iso';
        await expect(guard(client, seams({ testUrl: url, databaseUrl: url }))).rejects.toThrow(/is not a loopback address/);
        expect(client.statements).toHaveLength(0);
    });
});

describe('§4 IPv4-mapped IPv6 (fail closed)', () => {
    test('::1 is the only accepted IPv6 loopback form', () => {
        expect(isLocalAddress('::1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
    });

    test('mapped forms are identified and refused, in both spellings', () => {
        for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:1']) {
            expect(isMappedIPv6(address)).toBe(true);
            expect(isLocalAddress(address)).toBe(false);
            expect(isLoopbackHost(address)).toBe(false);
        }
    });

    test('a mapped IPv6 URL host is refused before any query', async () => {
        const url = 'postgres://u:p@[::ffff:127.0.0.1]:5432/azm_iso';
        const client = stubClient();
        await expect(guard(client, seams({ testUrl: url, databaseUrl: url }))).rejects.toThrow(/is not a loopback address/);
        expect(client.statements).toHaveLength(0);
    });

    test('a mapped server-reported address is refused', async () => {
        await expect(guard(stubClient({ serverAddress: '::ffff:127.0.0.1/128' }), seams()))
            .rejects.toThrow(/IPv4-mapped IPv6 form/);
    });
});

describe('§5 server-reported addresses and CIDR prefixes', () => {
    test('only SQL NULL means a unix socket', async () => {
        expect(interpretServerAddress(null)).toEqual({ reported: false });
        const client = stubClient({ serverAddress: null });
        await expect(guard(client, seams())).resolves.toMatchObject({ transport: 'unix-socket' });
        expect(mutations(client)).toHaveLength(0);
    });

    test('an empty address is refused, never read as a unix socket', async () => {
        for (const value of ['', '   ']) {
            expect(() => interpretServerAddress(value)).toThrow(/EMPTY address/);
            await expect(guard(stubClient({ serverAddress: value }), seams())).rejects.toThrow(/EMPTY address/);
        }
    });

    test('malformed values and a missing column are refused', async () => {
        for (const value of ['garbage', '127.0.0.1/abc', 42, {}, []]) {
            expect(() => interpretServerAddress(value)).toThrow(/not a valid IPv4 or IPv6 address|was not a string/);
            await expect(guard(stubClient({ serverAddress: value }), seams())).rejects.toThrow();
        }
        expect(() => interpretServerAddress(undefined)).toThrow(/was not a string/);
    });

    test('valid CIDR prefixes are parsed', () => {
        expect(interpretServerAddress('127.0.0.1/32')).toEqual({ address: '127.0.0.1', prefix: 32 });
        expect(interpretServerAddress('172.18.0.2/32')).toEqual({ address: '172.18.0.2', prefix: 32 });
        expect(interpretServerAddress('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8 });
        expect(interpretServerAddress('::1/128')).toEqual({ address: '::1', prefix: 128 });
        expect(interpretServerAddress('127.0.0.1')).toEqual({ address: '127.0.0.1', prefix: null });
    });

    test('out-of-range and malformed CIDR prefixes are REFUSED, not stripped', () => {
        for (const value of ['127.0.0.1/33', '127.0.0.1/999', '::1/129', '::1/0129', '127.0.0.1/+1', '127.0.0.1/', '127.0.0.1/ 32', '172.18.0.2/33']) {
            expect(splitCidr(value)).toBeNull();
            expect(() => interpretServerAddress(value)).toThrow(/valid CIDR prefix/);
        }
    });

    test('the CI expectation must be a bare IPv4 address, never a normalized CIDR', () => {
        expect(interpretExpectedAddress(' 172.18.0.2 ')).toBe('172.18.0.2');
        expect(interpretExpectedAddress('')).toBeNull();
        for (const value of ['172.18.0.2/32', 'garbage', '::1', '::1/128', '::ffff:172.18.0.2', '172.18.0.999']) {
            expect(() => interpretExpectedAddress(value)).toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS/);
        }
    });
});

describe('§6 previously established refusals still hold', () => {
    test('absent test URL, NODE_ENV, unbound URL, unreadable URL, wrong database', async () => {
        await expect(guard(stubClient(), seams({ testUrl: '' }))).rejects.toThrow(/TEST_DATABASE_URL is not set/);
        await expect(guard(stubClient(), seams({ nodeEnv: 'production' }))).rejects.toThrow(/NODE_ENV is "production", not "test"/);
        await expect(guard(stubClient(), seams({ databaseUrl: '' }))).rejects.toThrow(/DATABASE_URL is not bound/);
        const opaque = 'postgres://u:p@[::bad/db';
        await expect(guard(stubClient(), seams({ testUrl: opaque, databaseUrl: opaque }))).rejects.toThrow(/does not parse into a host and a database name/);
        await expect(guard(stubClient({ database: 'azm_production' }), seams())).rejects.toThrow(/connected to database "azm_production"/);
    });

    test('a remote URL host is refused before any query', async () => {
        const remote = 'postgres://postgres:postgres@azm-prod-db.example.com:5432/azm_iso?schema=public';
        const client = stubClient({ database: 'azm_iso' });
        await expect(guard(client, seams({ testUrl: remote, databaseUrl: remote })))
            .rejects.toThrow(/host "azm-prod-db\.example\.com".*is not a loopback address/);
        expect(client.statements).toHaveLength(0);
    });

    test('credentials never reach an error message', async () => {
        const credentialled = 'postgres://ci_runner:hunter2-should-never-leak@db.prod.example.com:5432/azm_test?schema=public';
        let error;
        try { await guard(stubClient(), seams({ databaseUrl: credentialled })); } catch (err) { error = err; }
        expect(error.message).not.toContain('hunter2-should-never-leak');
        expect(error.message).not.toContain('ci_runner');
        expect(error.message).not.toContain(credentialled);
        expect(error.message).toContain('db.prod.example.com:5432/azm_test');
    });

    test('describeTarget never includes credentials', () => {
        const described = describeTarget('postgres://user:sekret@example.com:5432/db?password=sekret');
        expect(described).toBe('example.com:5432/db');
        expect(described).not.toContain('sekret');
        expect(describeTarget('postgres://user:sekret@[::bad/db')).toBe('an unparseable value');
    });

    test('the local positive path issues one identity query and no mutation', async () => {
        const client = stubClient();
        await expect(guard(client, seams())).resolves.toMatchObject({
            database: 'azm_iso', host: 'localhost', identity: 'local-cluster-identity', systemIdentifier: LOCAL_SID, transport: 'tcp',
        });
        expect(client.statements).toHaveLength(1);
        expect(mutations(client)).toHaveLength(0);
    });
});
