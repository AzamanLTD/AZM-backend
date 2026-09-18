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
    // CI-hosted Postgres (service container) pays an fsync per commit, so
    // TRUNCATE-heavy beforeEach/afterEach cleanup hooks can exceed the 5s
    // default on a loaded runner while the test itself is healthy. Hooks get
    // a 30s budget; individual TEST timeouts stay at their defaults (tests
    // that need longer declare their own).
    hookTimeout: 30000,
};
