// The trusted-wallet overlay must be registered in the release chain at the one
// position that is safe: immediately AFTER the installer that creates
// FiatProviderEvent (install-fiat-liquidity-overlay.js) and BEFORE the
// settlement installers that depend on the wallet binding.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const chain = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.release
    .split('&&').map((s) => s.trim());

test('the trusted-wallet overlay sits immediately after the FiatProviderEvent installer', () => {
    const steps = chain();
    const wallet = steps.findIndex((c) => /install-wp-i-observation-wallet-overlay\.js/.test(c));
    const providerEvent = steps.findIndex((c) => /install-fiat-liquidity-overlay\.js/.test(c));
    expect(providerEvent).toBeGreaterThanOrEqual(0);
    expect(wallet).toBeGreaterThanOrEqual(0);
    expect(wallet).toBe(providerEvent + 1);
});

test('the trusted-wallet overlay precedes every settlement installer', () => {
    const steps = chain();
    const wallet = steps.findIndex((c) => /install-wp-i-observation-wallet-overlay\.js/.test(c));
    for (const name of ['install-model-b-settlement-overlay', 'install-ghs-wallet-overlay', 'install-native-ghs-settlement-overlay', 'install-native-ghs-withdrawal-overlay']) {
        const i = steps.findIndex((c) => c.includes(name));
        if (i >= 0) expect(wallet).toBeLessThan(i);
    }
});

test('the overlay applies idempotent DDL from the single SQL source of truth', () => {
    const installer = path.join(ROOT, 'infra', 'install-wp-i-observation-wallet-overlay.js');
    const ddl = path.join(ROOT, 'prisma', 'sql', '2026-11-18-fiat-provider-event-wallet-account.sql');
    expect(fs.existsSync(installer)).toBe(true);
    expect(fs.existsSync(ddl)).toBe(true);
    // The installer must not restate the DDL; it applies this file.
    expect(fs.readFileSync(installer, 'utf8')).toMatch(/prisma\/sql\/2026-11-18-fiat-provider-event-wallet-account\.sql/);
    expect(fs.readFileSync(ddl, 'utf8')).toMatch(/ADD COLUMN IF NOT EXISTS/i);
});
