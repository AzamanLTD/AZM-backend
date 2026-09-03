const { withRequestContext, getRequestContext } = require('../utils/requestContext');

describe('requestContext', () => {
    test('propagates the active request through synchronous middleware execution', () => {
        const req = { user: { id: 'user-a' } };
        expect(withRequestContext(req, () => getRequestContext())).toBe(req);
    });

    test('does not leak context outside an active request', () => {
        expect(getRequestContext()).toBeNull();
    });
});
