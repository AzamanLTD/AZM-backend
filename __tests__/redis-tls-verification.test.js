// __tests__/redis-tls-verification.test.js
// =============================================================================
// DEFECT B — transport security proven against a REAL TLS socket.
//
// The scheduler used to build its own ioredis connections and decide TLS by
// sniffing the scheme, so it never consulted the shared policy. These cases use
// a locally generated CA + server certificate (no external service, no
// credential) and prove three separate things:
//
//   1. an UNTRUSTED certificate is REFUSED — i.e. verification is genuinely on,
//      not quietly disabled with rejectUnauthorized:false;
//   2. the SAME factory connects when that CA is trusted, so the refusal above
//      is verification working rather than a broken fixture;
//   3. the options the factory hands ioredis keep verification enabled and keep
//      BullMQ's maxRetriesPerRequest:null.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');

const { createQueueClient } = require('../src/lib/redisConnection');

function openssl(args, cwd) {
    execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

function makeCerts(dir) {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=AZM Test CA',
        '-addext', 'basicConstraints=critical,CA:TRUE'], dir);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost'], dir);
    fs.writeFileSync(path.join(dir, 'ext.cnf'),
        'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n');
    openssl(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
        '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf'], dir);
}

// Minimal RESP server: enough for ioredis' ready check (INFO) and PING.
function startTlsRedis(dir) {
    const server = tls.createServer({
        key: fs.readFileSync(path.join(dir, 'srv.key')),
        cert: fs.readFileSync(path.join(dir, 'srv.pem')),
    }, (socket) => {
        socket.on('error', () => {});
        socket.on('data', (buf) => {
            const text = buf.toString('utf8');
            if (/\+PONG/i.test(text)) return;            // ignore our own echo shape
            if (/ping/i.test(text)) { socket.write('+PONG\r\n'); return; }
            if (/info/i.test(text)) {
                const info = 'role:master\r\nredis_version:7.2.0\r\nloading:0\r\nmaxmemory:0\r\n';
                socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
                return;
            }
            socket.write('+OK\r\n');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

describe('DEFECT B — TLS certificate verification on the queue path', () => {
    let dir;
    let server;
    let port;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-tls-'));
        makeCerts(dir);
        ({ server, port } = await startTlsRedis(dir));
    }, 60000);

    afterAll(async () => {
        if (server) await new Promise((r) => server.close(r));
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    test('an UNTRUSTED certificate is refused: verification is genuinely ON', async () => {
        const client = createQueueClient({
            env: { REDIS_URL: `rediss://localhost:${port}` },
            overrides: { retryStrategy: () => null, connectTimeout: 2000, maxRetriesPerRequest: 1 },
            label: 'tls-untrusted',
        });
        await expect(client.ping()).rejects.toBeTruthy();
        const err = String(client.__azmLastError || '');
        expect(err).toMatch(/certificate|self.signed|unable to verify/i);
        client.disconnect();
    }, 20000);

    test('the SAME factory connects when REDIS_TLS_CA trusts that CA (real PING)', async () => {
        const client = createQueueClient({
            env: { REDIS_URL: `rediss://localhost:${port}`, REDIS_TLS_CA: path.join(dir, 'ca.pem') },
            overrides: { retryStrategy: () => null, connectTimeout: 4000 },
            label: 'tls-trusted',
        });
        await expect(client.ping()).resolves.toBe('PONG');
        client.disconnect();
    }, 20000);

    test('an unreadable REDIS_TLS_CA fails closed instead of trusting everything', () => {
        expect(() => createQueueClient({
            env: { REDIS_URL: `rediss://localhost:${port}`, REDIS_TLS_CA: path.join(dir, 'does-not-exist.pem') },
        })).toThrow(/unreadable/);
    });

    test('the factory keeps verification enabled and BullMQ\'s required option', () => {
        const client = createQueueClient({
            env: { REDIS_URL: `rediss://localhost:${port}` },
            overrides: { retryStrategy: () => null, lazyConnect: true, enableReadyCheck: false },
            label: 'tls-options',
        });
        expect(client.options.tls).toBeTruthy();
        expect(client.options.tls.rejectUnauthorized).toBe(true);
        expect(client.options.maxRetriesPerRequest).toBeNull();
        client.disconnect();
    });
});
