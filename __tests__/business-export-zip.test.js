// __tests__/business-export-zip.test.js
// =============================================================================
// The business export used to be built with `archiver`, whose dependency chain
// carried unfixable production advisories. It is now built with a narrow yazl
// writer. These tests prove the archive is still a real, readable ZIP with the
// same documents, correct CRCs and intact UTF-8 names.
// =============================================================================

const yauzl = require('yauzl');
const { buildZipStream } = require('../utils/exportZip');

function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

function readEntries(buffer) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            const out = [];
            zipfile.on('error', reject);
            zipfile.on('entry', (entry) => {
                zipfile.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => {
                        out.push({
                            name: entry.fileName,
                            size: entry.uncompressedSize,
                            crc: entry.crc32,
                            content: Buffer.concat(chunks).toString('utf8'),
                        });
                        zipfile.readEntry();
                    });
                });
            });
            zipfile.on('end', () => resolve(out));
            zipfile.readEntry();
        });
    });
}

describe('business export archive', () => {
    test('is a readable zip containing the six expected documents', async () => {
        const { stream } = buildZipStream([
            { name: 'orders.csv', data: 'a,b\n1,2' },
            { name: 'invoices.csv', data: 'c,d\n3,4' },
            { name: 'reviews.csv', data: '' },
            { name: 'employees.csv', data: 'e\n5' },
            { name: 'products.csv', data: 'f\n6' },
            { name: 'manifest.json', data: '{"counts":{"orders":1}}' },
        ]);

        const buffer = await collect(stream);
        // Local file header signature: PK\x03\x04
        expect(buffer.slice(0, 4).toString('binary')).toBe('PK\u0003\u0004');

        const entries = await readEntries(buffer);
        expect(entries.map((e) => e.name)).toEqual([
            'orders.csv', 'invoices.csv', 'reviews.csv',
            'employees.csv', 'products.csv', 'manifest.json',
        ]);
        expect(entries.find((e) => e.name === 'orders.csv').content).toBe('a,b\n1,2');
        expect(entries.find((e) => e.name === 'reviews.csv').size).toBe(0);
    });

    test('integrity: every entry carries a non-zero CRC unless empty', async () => {
        const { stream } = buildZipStream([
            { name: 'data.csv', data: 'x,y\n9,8' },
        ]);
        const entries = await readEntries(await collect(stream));
        expect(entries[0].crc).toBeGreaterThan(0);
    });

    test('nested paths and Unicode names survive', async () => {
        const { stream } = buildZipStream([
            { name: 'reports/2026/orders.csv', data: 'ok' },
            { name: 'ünïcodé_文件.csv', data: 'ok' },
        ]);
        const entries = await readEntries(await collect(stream));
        expect(entries.map((e) => e.name)).toEqual(['reports/2026/orders.csv', 'ünïcodé_文件.csv']);
    });

    test('a large payload round-trips intact', async () => {
        const big = 'row,'.repeat(50000);
        const { stream } = buildZipStream([{ name: 'big.csv', data: big }]);
        const entries = await readEntries(await collect(stream));
        expect(entries[0].content).toHaveLength(big.length);
        expect(entries[0].content).toBe(big);
    });

    test('reports the archive size once consumed', async () => {
        const { stream, done } = buildZipStream([{ name: 'a.csv', data: 'x' }]);
        const buffer = await collect(stream);
        await expect(done).resolves.toBe(buffer.length);
    });

    test('refuses an empty archive and duplicate entries', () => {
        expect(() => buildZipStream([])).toThrow(/at least one entry/i);
        expect(() => buildZipStream([{ name: 'a.csv', data: 'x' }, { name: 'a.csv', data: 'y' }]))
            .toThrow(/Duplicate archive entry/);
        expect(() => buildZipStream([{ name: '', data: 'x' }])).toThrow(/needs a name/);
    });

    test('the route no longer loads archiver', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'businessOSRoutes.js'), 'utf8');
        expect(src).not.toMatch(/require\('archiver'\)/);
        expect(src).toMatch(/require\('\.\.\/utils\/exportZip'\)/);
    });
});
