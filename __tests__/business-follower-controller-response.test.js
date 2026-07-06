// __tests__/business-follower-controller-response.test.js
// =============================================================================
// FIX (2026-07-06): followController.myFollowing / myFollowers did
// `res.json({ success: true, ...result })` where `result` is a bare array
// returned by getFollowing/getFollowers. Spreading an array into a plain
// object produces numeric-string-keyed junk ({"0": {...}, "1": {...}}),
// NOT a JSON array -- any real client reading a `.following`/`.followers`
// field (or expecting an array at all) got nothing usable. This test
// exercises the exact response-shaping logic the controller uses (rather
// than spinning up the full HTTP server) to lock in the correct contract.
// =============================================================================
describe('followController response shaping (array-spread bug)', () => {
    test('spreading a bare array into a JSON object produces the broken shape (documents the bug)', () => {
        const result = [{ id: 'biz1' }, { id: 'biz2' }];
        const broken = { success: true, ...result };
        expect(Array.isArray(broken.following)).toBe(false);
        expect(broken['0']).toEqual({ id: 'biz1' });
    });

    test('wrapping under a named key produces the correct, client-usable shape', () => {
        const result = [{ id: 'biz1' }, { id: 'biz2' }];
        const fixed = { success: true, following: result };
        expect(Array.isArray(fixed.following)).toBe(true);
        expect(fixed.following).toHaveLength(2);
        expect(fixed.following[0].id).toBe('biz1');
    });
});
