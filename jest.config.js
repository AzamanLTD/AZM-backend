// jest.config.js
// Node test environment for the backend. The __tests__/helpers directory holds
// shared factories (not test files), so it is excluded from test discovery —
// otherwise Jest treats factories.js as an empty suite and fails the run.
module.exports = {
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
};
