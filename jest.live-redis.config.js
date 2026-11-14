// jest.live-redis.config.js — config for the LIVE Redis proof lane only.
//
// The repo's main jest config runs test-support/global-setup.js, which connects
// to PostgreSQL. The Redis suites need no database at all, and requiring one
// made the first live run fail with PrismaClientInitializationError before a
// single Redis command was sent — a lane failing for a reason unrelated to what
// it claims to prove. This config keeps the env defaults from jest.setup.js and
// drops the database-dependent setup/teardown entirely.
module.exports = {
    testEnvironment: 'node',
    rootDir: __dirname,
    setupFiles: ['./jest.setup.js'],
    testMatch: [
        '<rootDir>/__tests__/redis-live-roundtrip.test.js',
        '<rootDir>/__tests__/sms-otp-real-redis.integration.test.js',
        '<rootDir>/__tests__/app-unlock-redis.integration.test.js',
    ],
    testTimeout: 60000,
};
