// __tests__/login-streak-daycalc.test.js
// =============================================================================
// Regression test for the login-streak "doesn't record daily logins" bug.
//
// Root cause (fixed 2026-07-06): authController's login handler used to diff
// `now - lastLoginAt` as a rolling 24h window
// (`Math.floor(ms / 86400000)`), NOT calendar dates. That silently breaks the
// streak the moment a user logs in even slightly earlier one day than the
// day before — e.g. 8:00am Monday then 7:30am Tuesday is only 23.5h apart,
// floors to 0, and the old code read that as "same day, keep streak as is"
// even though it's a brand new calendar day. This is a very ordinary,
// real-world login pattern, so the streak would appear "stuck" for a large
// share of real users.
//
// This suite exercises the pure helper directly (no DB/network needed) —
// fast, deterministic, and pins the exact scenario that was broken.
// =============================================================================

const { _daysBetweenCalendarDates } = require('../controllers/authController');

describe('login streak — calendar-day diff (not rolling 24h window)', () => {
  test('A: login 23.5h later but next calendar day → counts as +1 day (the bug this fixes)', () => {
    // Monday 08:00 → Tuesday 07:30. Only 23.5h elapsed, but it IS the next
    // calendar day. The old Math.floor(ms/86400000) logic returned 0 here
    // (streak silently frozen); the fix must return 1.
    const monday0800 = new Date('2026-06-01T08:00:00Z');
    const tuesday0730 = new Date('2026-06-02T07:30:00Z');
    expect(_daysBetweenCalendarDates(monday0800, tuesday0730)).toBe(1);
  });

  test('B: two logins within the same calendar day (hours apart) → 0 days', () => {
    const morning = new Date('2026-06-01T08:00:00Z');
    const evening = new Date('2026-06-01T22:00:00Z');
    expect(_daysBetweenCalendarDates(morning, evening)).toBe(0);
  });

  test('C: login 25h later, next calendar day → 1 day (still correct under the old logic too, sanity check)', () => {
    const day1 = new Date('2026-06-01T08:00:00Z');
    const day2 = new Date('2026-06-02T09:00:00Z');
    expect(_daysBetweenCalendarDates(day1, day2)).toBe(1);
  });

  test('D: gap of exactly one full calendar day skipped → 2 days (streak should reset, not increment)', () => {
    const day1 = new Date('2026-06-01T08:00:00Z');
    const day3 = new Date('2026-06-03T08:00:00Z');
    expect(_daysBetweenCalendarDates(day1, day3)).toBe(2);
  });

  test('E: login right at midnight boundary (23:59:59 → 00:00:01 next day) → 1 day', () => {
    const justBeforeMidnight = new Date('2026-06-01T23:59:59Z');
    const justAfterMidnight = new Date('2026-06-02T00:00:01Z');
    expect(_daysBetweenCalendarDates(justBeforeMidnight, justAfterMidnight)).toBe(1);
  });

  test('F: month/year boundary crossed correctly (Jan 31 → Feb 1)', () => {
    const jan31 = new Date('2026-01-31T20:00:00Z');
    const feb1 = new Date('2026-02-01T06:00:00Z');
    expect(_daysBetweenCalendarDates(jan31, feb1)).toBe(1);
  });
});
