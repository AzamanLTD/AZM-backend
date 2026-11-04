// __tests__/test-database-guard.test.js
// =============================================================================
// Strict tests for __tests__/helpers/testDatabaseGuard.js — ITEM 1-4 of the
// independent review. Pure unit tests: no database, no connection string, so
// they run anywhere and prove the guard's classification and identity logic
// directly.
//
// The guard is the last line of defence in front of a table-wide maintenance
// statement, so every accepted form is proved positively and every ambiguous or
// malformed form is proved to be refused.
// =============================================================================

const {
    assertDisposableTestDatabase: guard,
    classifyAddress,
    describeTarget,
    interpretExpectedAddress,
    interpretServerAddress,
    isLocalAddress,
    isLoopbackAddress,
    isLoopbackHost,
    isMappedIPv6,
} = require('./helpers/testDatabaseGuard');

const LOCAL_URL = 'postgres://postgres:postgres@localhost:5432/azm_iso?schema=public';
const CI_EXPECTED = '172.18.0.2';

// A client that reports an identity and records every statement it is asked to
// run, so "refused" also means "the caller's UPDATE never reached the database".
function stubClient({ database = 'azm_iso', serverAddress = '127.0.0.1/32' } = {}) {
    const statements = [];
    return {
        statements,
        $queryRawUnsafe: async (sql) => {
            statements.push(sql);
            return [{ database, server_address: serverAddress }];
        },
        $executeRawUnsafe: async (sql) => { statements.push(sql); },
    };
}

const mutations = (client) => client.statements.filter((sql) => /^\s*(UPDATE|DELETE|TRUNCATE|INSERT)/i.test(sql));

// The seams always pin githubActions so a local shell cannot leak MOCK_ENV in.
const seams = (over = {}) => ({
    testUrl: LOCAL_URL,
    databaseUrl: LOCAL_URL,
    nodeEnv: 'test',
    expectedAddress: '',
    githubActions: false,
    ...over,
});

describe('§1 exact container identity, not a private subnet', () => {
    test('the exact CI container address is accepted', async () => {
        const client = stubClient({ serverAddress: '172.18.0.2/32' });
        await expect(guard(client, seams({ expectedAddress: CI_EXPECTED }))).resolves.toEqual({
            database: 'azm_iso', host: 'localhost', serverAddress: '172.18.0.2', identity: 'exact-expected-address',
        });
        expect(mutations(client)).toHaveLength(0);
    });

    test('a different address in 172.18.0.0/16 is refused', async () => {
        const client = stubClient({ serverAddress: '172.18.0.3/32' });
        await expect(guard(client, seams({ expectedAddress: CI_EXPECTED })))
            .rejects.toThrow(/server reports address "172\.18\.0\.3", but the expected disposable database address is "172\.18\.0\.2"/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('172.20.5.9 and 172.31.9.9 are refused — inside the old 172.16/12 allowance', async () => {
        for (const address of ['172.20.5.9', '172.31.9.9']) {
            // with an expectation: mismatch
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), seams({ expectedAddress: CI_EXPECTED })))
                .rejects.toThrow(/Identity mismatch|but the expected disposable database address/);
            // without one, under CI: no expectation at all is a refusal
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), seams({ githubActions: true })))
                .rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS is not set/);
            // without one, locally: a private address is not local
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), seams()))
                .rejects.toThrow(/neither loopback nor ::1/);
        }
    });

    test('10/8, 192.168/16 and public addresses are refused', async () => {
        for (const address of ['10.4.1.9', '192.168.1.4', '203.0.113.7', '8.8.8.8']) {
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), seams()))
                .rejects.toThrow(/neither loopback nor ::1/);
            await expect(guard(stubClient({ serverAddress: `${address}/32` }), seams({ expectedAddress: CI_EXPECTED })))
                .rejects.toThrow(/but the expected disposable database address/);
        }
    });

    test('a loopback URL with a matching database name but a mismatched server identity is refused before the UPDATE', async () => {
        const client = stubClient({ database: 'azm_iso', serverAddress: '172.18.0.9/32' });
        await expect(guard(client, seams({ expectedAddress: CI_EXPECTED }))).rejects.toThrow(/Identity mismatch/);
        // the caller's statement never ran; only the identity SELECT did
        expect(mutations(client)).toHaveLength(0);
        expect(client.statements).toHaveLength(1);
        expect(client.statements[0]).toMatch(/current_database\(\)/);
    });

    test('a missing expected CI identity fails closed', async () => {
        for (const expectedAddress of ['', '   ', undefined]) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, seams({ githubActions: true, expectedAddress })))
                .rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS is not set/);
            expect(client.statements).toHaveLength(0); // refused before any query
        }
    });

    test('a malformed or ambiguous expected identity fails closed', async () => {
        for (const expectedAddress of ['garbage', '172.18.0.2 172.18.0.3', 'localhost', '::ffff:172.18.0.2']) {
            const client = stubClient({ serverAddress: '172.18.0.2/32' });
            await expect(guard(client, seams({ expectedAddress })))
                .rejects.toThrow(/AZM_EXPECTED_TEST_DB_ADDRESS/);
            expect(client.statements).toHaveLength(0);
        }
    });

    test('an expectation that cannot be checked against a unix socket is not satisfied', async () => {
        await expect(guard(stubClient({ serverAddress: null }), seams({ expectedAddress: CI_EXPECTED })))
            .rejects.toThrow(/reported SQL NULL .*An expectation that cannot be checked is not satisfied/);
    });
});

describe('§2 strict IPv4 loopback validation', () => {
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
        const malformed = ['127.1', '127.0.0', '127.0.0.1.1', '127.0.0.01', '0x7f.0.0.1', '127.0.0.-1', '127.0.0.256', '127 .0.0.1'];
        for (const address of malformed) {
            expect(classifyAddress(address)).toBeNull();
            expect(isLoopbackAddress(address)).toBe(false);
        }
        // Surrounding whitespace is trimmed at the boundary on purpose (env and
        // inet::text values can carry it); it is never allowed INSIDE an octet.
        expect(classifyAddress(' 127.0.0.1 ')).toBe('ipv4');
        expect(isLoopbackAddress(' 127.0.0.1 ')).toBe(true);
    });

    test('ordinary non-loopback IPv4 addresses are refused', () => {
        for (const address of ['128.0.0.1', '10.0.0.1', '172.18.0.2', '192.168.0.1', '8.8.8.8']) {
            expect(classifyAddress(address)).toBe('ipv4');
            expect(isLoopbackAddress(address)).toBe(false);
            expect(isLocalAddress(address)).toBe(false);
        }
    });

    test('an invalid address is refused before any database query', async () => {
        const client = stubClient();
        await expect(guard(client, seams({ testUrl: 'postgres://u:p@127.999.1.1:5432/azm_iso', databaseUrl: 'postgres://u:p@127.999.1.1:5432/azm_iso' })))
            .rejects.toThrow(/is not a loopback address/);
        expect(client.statements).toHaveLength(0);
    });
});

describe('§3 IPv4-mapped IPv6 handling (fail closed)', () => {
    test('::1 is the only accepted IPv6 loopback form', () => {
        expect(classifyAddress('::1')).toBe('ipv6');
        expect(isLocalAddress('::1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
    });

    test('mapped forms are identified and refused, in both dotted and normalized spelling', () => {
        for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:1']) {
            expect(isMappedIPv6(address)).toBe(true);
            expect(isLocalAddress(address)).toBe(false);
            expect(isLoopbackHost(address)).toBe(false);
        }
    });

    test('a mapped IPv6 URL host is refused before any query', async () => {
        const url = 'postgres://u:p@[::ffff:127.0.0.1]:5432/azm_iso';
        const client = stubClient();
        await expect(guard(client, seams({ testUrl: url, databaseUrl: url })))
            .rejects.toThrow(/is not a loopback address/);
        expect(client.statements).toHaveLength(0);
    });

    test('a mapped server-reported address is refused', async () => {
        await expect(guard(stubClient({ serverAddress: '::ffff:127.0.0.1/128' }), seams()))
            .rejects.toThrow(/IPv4-mapped IPv6 form/);
    });
});

describe('§4 server-reported address: only SQL NULL means a unix socket', () => {
    test('SQL NULL is the unix-socket signal', async () => {
        expect(interpretServerAddress(null)).toEqual({ reported: false });
        await expect(guard(stubClient({ serverAddress: null }), seams())).resolves.toEqual({
            database: 'azm_iso', host: 'localhost', serverAddress: null, identity: 'unix-socket',
        });
    });

    test('an empty address is refused, never read as a unix socket', async () => {
        for (const value of ['', '   ']) {
            expect(() => interpretServerAddress(value)).toThrow(/EMPTY address/);
            await expect(guard(stubClient({ serverAddress: value }), seams())).rejects.toThrow(/EMPTY address/);
        }
    });

    test('malformed values are refused', async () => {
        for (const value of ['garbage', '127.0.0.1/abc', 42, {}, []]) {
            expect(() => interpretServerAddress(value)).toThrow(/not a valid IPv4 or IPv6 address|was not a string/);
            await expect(guard(stubClient({ serverAddress: value }), seams())).rejects.toThrow();
        }
    });

    test('a MISSING server address column is refused, not defaulted', async () => {
        // A row without inet_server_addr() must not be mistaken for a unix socket.
        const client = {
            statements: [],
            $queryRawUnsafe: async (sql) => { client.statements.push(sql); return [{ database: 'azm_iso' }]; },
            $executeRawUnsafe: async (sql) => { client.statements.push(sql); },
        };
        expect(() => interpretServerAddress(undefined)).toThrow(/was not a string/);
        await expect(guard(client, seams({ expectedAddress: '' }))).rejects.toThrow(/was not a string/);
        expect(mutations(client)).toHaveLength(0);
    });

    test('valid CIDR-wrapped addresses are parsed', () => {
        expect(interpretServerAddress('127.0.0.1/32')).toEqual({ address: '127.0.0.1' });
        expect(interpretServerAddress('172.18.0.2/32')).toEqual({ address: '172.18.0.2' });
        expect(interpretServerAddress('::1/128')).toEqual({ address: '::1' });
    });

    test('expected-address parsing refuses junk', () => {
        expect(interpretExpectedAddress('')).toBeNull();
        expect(interpretExpectedAddress(undefined)).toBeNull();
        expect(interpretExpectedAddress(' 172.18.0.2 ')).toBe('172.18.0.2');
        expect(() => interpretExpectedAddress('garbage')).toThrow(/not a valid IPv4 or IPv6 address/);
    });
});

describe('§5 previously established refusals still hold', () => {
    test('absent test URL, NODE_ENV, unbound URL, mismatch, unreadable URL', async () => {
        await expect(guard(stubClient(), seams({ testUrl: '' }))).rejects.toThrow(/TEST_DATABASE_URL is not set/);
        await expect(guard(stubClient(), seams({ nodeEnv: 'production' }))).rejects.toThrow(/NODE_ENV is "production", not "test"/);
        await expect(guard(stubClient(), seams({ databaseUrl: '' }))).rejects.toThrow(/DATABASE_URL is not bound/);
        await expect(guard(stubClient(), seams({ testUrl: 'postgres://u:p@[::bad/db', databaseUrl: 'postgres://u:p@[::bad/db' })))
            .rejects.toThrow(/does not parse into a host and a database name/);
        await expect(guard(stubClient({ database: 'azm_production' }), seams()))
            .rejects.toThrow(/connected to database "azm_production", but the disposable test database is "azm_iso"/);
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
        try {
            await guard(stubClient(), seams({ databaseUrl: credentialled }));
        } catch (err) { error = err; }
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

    test('the local positive path issues exactly one identity query and no mutation', async () => {
        const client = stubClient();
        await expect(guard(client, seams())).resolves.toEqual({
            database: 'azm_iso', host: 'localhost', serverAddress: '127.0.0.1', identity: 'loopback-server-report',
        });
        expect(client.statements).toHaveLength(1);
        expect(mutations(client)).toHaveLength(0);
    });
});
