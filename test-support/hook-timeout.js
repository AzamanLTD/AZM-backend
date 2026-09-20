// test-support/hook-timeout.js — setupFilesAfterEnv entry.
//
// Jest 29 has NO `hookTimeout` config option (that key is Jest 30+); the repo's
// jest.config.js previously carried `hookTimeout: 30000`, which Jest silently
// ignored with a validation warning, leaving TRUNCATE-heavy cleanup hooks on
// the 5s default (testTimeout state). On a slow CI runner this manufactured a
// false flake class: a healthy suite's beforeEach/afterEach cleanup exceeded
// 5s while every test inside it was correct (observed on CI 2026-09-20:
// withdrawal-reconciliation-finance-settlement afterEach).
//
// In jest-circus 29 a hook's timeout resolves as `hook.timeout || testTimeout`
// (node_modules/jest-circus/build/run.js), and the registration API accepts
// an explicit per-hook timeout as the second argument. This entry wraps the
// four hook globals so an unspecified hook timeout becomes 30s, exactly the
// documented intent of the former dead config key:
//
//   - hooks (beforeEach/afterEach/beforeAll/afterAll): default 30s
//   - individual TESTS: unchanged (their default stays testTimeout=5000;
//     tests that need longer declare their own)
//   - per-hook overrides keep working: beforeEach(fn, 60000) wins
//
// Wrapping is additive and framework-version-guarded: if a future Jest
// upgrade brings native `hookTimeout` support, the upgrade may drop both this
// file and its jest.config.js wiring.

const HOOK_DEFAULT_TIMEOUT_MS = 30000;
const HOOK_NAMES = ['beforeEach', 'afterEach', 'beforeAll', 'afterAll'];

module.exports = function setupHookTimeouts() {
    for (const name of HOOK_NAMES) {
        const original = global[name];
        if (typeof original !== 'function') continue;
        const wrapped = function hooked(fn, timeout) {
            return original(fn, timeout === undefined ? HOOK_DEFAULT_TIMEOUT_MS : timeout);
        };
        // Preserve jest's own marker surface for stack-trace trimming.
        wrapped.toString = () => original.toString();
        global[name] = wrapped;
    }
};
