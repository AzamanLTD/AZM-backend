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

test('the overlay installer exists and is idempotent-shaped', () => {
    const p = path.join(ROOT, 'infra', 'install-wp-i-observation-wallet-overlay.js');
    expect(fs.existsSync(p)).toBe(true);
    const src = fs.readFileSync(p, 'utf8');
    expect(src).toMatch(/IF NOT EXISTS|ADD COLUMN IF NOT EXISTS/i);
});
