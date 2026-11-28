// __tests__/socket-rate-limiter-redis-failure.test.js
// =============================================================================
// DEFECT C (2026-11-17 audit) — the socket rate limiter's Redis failure path
// must fail OPEN, log through the real logger, and call next() exactly once.
//
// Before the fix, middleware/socketRateLimiter.js called `logger.error(...)` in
// its catch without ever importing a logger. When redis.eval() rejected, the
// catch threw a ReferenceError, next() was never invoked, and Socket.IO stalled
// the packet forever — a designed fail-open path silently became a hang.
//
// The proof is a real express/socket-middleware invocation: `socket.use()` is
// driven with a fake packet and the assertions are on next() call counts and on
// the injected logger's call log.
// =============================================================================
'use strict';

const redisState = { mode: 'ok', evalImpl: null };
const fakeRedis = {
    async eval(...args) {
        if (redisState.evalImpl) return redisState.evalImpl(...args);
        return 1;
    },
};

jest.mock('../src/lib/redisConnection', () => ({
    getRedis: () => (redisState.mode === 'none' ? null : fakeRedis),
}));

const loggerCalls = [];
jest.mock('../src/config/logger', () => ({
    error: (...args) => { loggerCalls.push(args); },
    warn: (...args) => { loggerCalls.push(args); },
    info: () => {},
    debug: () => {},
}));

const { attach, EVENT_LIMITS } = require('../middleware/socketRateLimiter');

// Minimal socket.io-shaped object: only `use` and `emit` are exercised.
function makeSocket(user = { id: 42 }) {
    const handlers = [];
    const emitted = [];
    return {
        user,
        emitted,
        handlers,
        use(fn) { handlers.push(fn); },
        emit(event, payload) { emitted.push({ event, payload }); },
        // Run the registered middleware exactly like socket.io does.
        //
        // A DENIED packet is deliberately swallowed: the limiter emits
        // 'rate_limited' and never calls next(). So "settled" means EITHER
        // next() was called OR the promise chain completed without it. The
        // short settle window is what lets a swallow be observed instead of
        // hanging the test until jest's timeout.
        dispatch(packet) {
            return new Promise((resolve) => {
                let calls = 0;
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({ calls });
                };
                const timer = setTimeout(finish, 30);
                timer.unref?.();
                const next = () => { calls += 1; finish(); };
                handlers.forEach((h) => h(packet, next));
            });
        },
    };
}

describe('DEFECT C — socket rate limiter Redis failure path', () => {
    beforeEach(() => {
        redisState.mode = 'ok';
        redisState.evalImpl = null;
        loggerCalls.length = 0;
    });

    test('a successful eval keeps the existing rate-limit decision (allowed)', async () => {
        redisState.evalImpl = async () => 1;
        const socket = makeSocket();
        attach(socket);

        const { calls } = await socket.dispatch(['typing', {}]);
        expect(calls).toBe(1);          // allowed → next() once
        expect(loggerCalls.length).toBe(0);
        expect(socket.emitted.length).toBe(0);
    });

    test('a successful eval over the limit swallows the packet and emits rate_limited', async () => {
        redisState.evalImpl = async () => EVENT_LIMITS.typing.max + 1;
        const socket = makeSocket();
        attach(socket);

        const { calls } = await socket.dispatch(['typing', {}]);
        expect(calls).toBe(0);          // packet swallowed by design
        expect(socket.emitted.length).toBe(1);
        expect(socket.emitted[0].event).toBe('rate_limited');
    });

    test('a rejected eval fails OPEN: next() exactly once, no ReferenceError', async () => {
        redisState.evalImpl = async () => { throw new Error('Connection is closed'); };
        const socket = makeSocket();
        attach(socket);

        const { calls } = await socket.dispatch(['typing', {}]);
        expect(calls).toBe(1);          // the whole point: the socket keeps working
        // The error was logged through the REAL logger, not a missing binding.
        expect(loggerCalls.length).toBe(1);
        expect(String(loggerCalls[0][1])).toMatch(/failing open/);
        expect(socket.emitted.length).toBe(0);
    });

    test('a logger that itself throws cannot stop next() from being called', async () => {
        redisState.evalImpl = async () => { throw new Error('boom'); };
        const original = loggerCalls.push;
        // Simulate a broken logger transport for this case only.
        const loggerModule = require('../src/config/logger');
        const realError = loggerModule.error;
        loggerModule.error = () => { throw new Error('logger transport down'); };

        try {
            const socket = makeSocket();
            attach(socket);
            const { calls } = await socket.dispatch(['typing', {}]);
            expect(calls).toBe(1);
        } finally {
            loggerModule.error = realError;
            loggerCalls.push = original;
        }
    });

    test('no unhandled rejection escapes the failure path', async () => {
        redisState.evalImpl = async () => { throw new Error('ECONNRESET'); };
        const unhandled = [];
        const onUnhandled = (e) => unhandled.push(e);
        process.on('unhandledRejection', onUnhandled);
        try {
            const socket = makeSocket();
            attach(socket);
            await socket.dispatch(['typing', {}]);
            await new Promise((r) => setTimeout(r, 25));
            expect(unhandled.length).toBe(0);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    test('no Redis at all uses the in-memory fallback (same explicit policy)', async () => {
        redisState.mode = 'none';
        const socket = makeSocket();
        attach(socket);

        const first = await socket.dispatch(['typing', {}]);
        expect(first.calls).toBe(1);
        // The memory fallback counts within the window, so a burst still limits.
        let last = first;
        for (let i = 0; i < EVENT_LIMITS.typing.max + 2; i += 1) {
            last = await socket.dispatch(['typing', {}]);
        }
        expect(last.calls).toBe(0);     // over the limit → swallowed
        expect(socket.emitted.some((e) => e.event === 'rate_limited')).toBe(true);
    });

    test('a socket without an authenticated user bypasses the limiter', async () => {
        const socket = makeSocket(null);
        attach(socket);
        const { calls } = await socket.dispatch(['typing', {}]);
        expect(calls).toBe(1);
    });
});
