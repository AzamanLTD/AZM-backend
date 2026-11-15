// §WP-H F — the harness must be safe when setup fails halfway.
//
// These are unit proofs about naming and cleanup contracts; the real-PostgreSQL
// proof that no database or role survives a run is the post-suite sweep in
// __tests__/wp-h-test-residue.pg.test.js.
const { disposableName } = require('./helpers/disposableDatabase');

describe('WP-H disposable database harness', () => {
    test('names fit PostgreSQL identifier limits and are collision resistant', () => {
        const names = new Set();
        for (let i = 0; i < 200; i += 1) names.add(disposableName('a-very-long-tag-that-would-otherwise-overflow-the-limit'));
        expect(names.size).toBe(200);
        for (const n of names) {
            // PostgreSQL silently truncates at 63 bytes; anything longer can
            // collide without the code ever seeing it.
            expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(63);
            expect(n).toMatch(/^[a-z0-9_]+$/);
            expect(n.startsWith('azm_')).toBe(true);
        }
    });

    test('unsafe tag characters cannot escape the identifier', () => {
        const n = disposableName('p5e"; DROP DATABASE postgres; --');
        expect(n).toMatch(/^[a-z0-9_]+$/);
        expect(n).not.toContain('"');
        expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(63);
    });
});
