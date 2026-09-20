// jest.config.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.test') });

// Fallback defaults so PrismaClient can initialise even without .env.test
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL =
        'postgresql://postgres:postgres@localhost:5432/azm_test';
}
if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test_secret_exactly_32_characters_long';
}
if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test';
}

module.exports = {
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
    setupFiles: ['./jest.setup.js'],
    setupFilesAfterEnv: ['./test-support/setup-shift-business-context.js'],
    // Jest 29 has no `hookTimeout` config option — the repo's old
    // `hookTimeout: 30000` key was silently ignored (validation warning),
    // leaving TRUNCATE-heavy cleanup hooks on the 5s default. On a loaded
    // CI runner this manufactured false flakes: healthy suites' beforeEach/
    // afterAll cleanup exceeded 5s while every test inside was correct
    // (observed 2026-09-20: p5d afterAll timing out, whose residue then
    // failed the business-ad/follower-adapter cleanups with FK violations).
    // jest-circus 29 resolves hook timeouts as `hook.timeout ||
    // state.testTimeout` (node_modules/jest-circus/build/run.js), so raising
    // testTimeout raises both hooks AND tests. An earlier attempt wrapped
    // the hook globals from setupFilesAfterEnv — it does NOT work: jest
    // re-injects the framework's own globals per test file, discarding the
    // wrapper (verified by experiment: an 8s afterAll still died at 5000ms).
    // 30s is the default for both; slower CI runners are covered, and any
    // genuinely hung test merely takes 30s instead of 5s to surface.
    testTimeout: 30000,
};
