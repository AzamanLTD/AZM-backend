// services/loginStreakService.js
// =============================================================================
// AZAMAN — SHARED DAILY LOGIN-STREAK RECORDER (2026-07-06)
//
// THE REAL BUG THIS FIXES: the calendar-day streak math itself was already
// fixed in authController.login() (see login-streak-daycalc.test.js), but
// that fix only ran on the explicit POST /api/auth/login endpoint.
// controllers/refreshController.js's POST /api/auth/refresh — which is what
// silently fires on almost every app re-open once a user has a valid session
// (JWT refresh-token rotation) — never touched loginStreak / lastLoginAt /
// azmRewardService.rewardLoginStreak AT ALL. Since a rotating refresh token
// means most users never hit /login again after their very first sign-in,
// their streak was frozen at day 1 for essentially every normal "just open
// the app" flow. That's the actual "daily logins aren't recording" bug.
//
// Fix: extract the exact, already-tested calendar-day logic out of
// authController.login() into this shared helper, then call it from BOTH
// login() and refresh(). One code path, one set of tests, no drift risk
// between the two call sites.
// =============================================================================

// Calendar-day difference (UTC midnight-to-midnight), NOT a rolling 24h
// window — see login-streak-daycalc.test.js for why that distinction matters.
function _daysBetweenCalendarDates(a, b) {
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / (1000 * 60 * 60 * 24));
}

/**
 * Records a login/session-resume event for the calendar-day streak and
 * fires the AZM reward if the streak advanced. Safe to call from ANY
 * authenticated entry point (password login, refresh-token rotation, SSO).
 *
 * Perf note: on a same calendar day repeat call (the common case for
 * refresh, which can fire many times per day for an active user) this is a
 * deliberate no-op — no DB write, no reward lookup — so wiring it into the
 * high-frequency /refresh path doesn't add a write per token rotation.
 *
 * @param {object} prisma
 * @param {{id:number, loginStreak:number|null, lastLoginAt:Date|null}} user
 * @param {object|null} azmRewardService - app.get('azmRewardService'); reward is skipped if null (e.g. not wired in a given app instance)
 * @returns {Promise<number>} the loginStreak value after this call (unchanged if same calendar day)
 */
async function recordDailyLogin(prisma, user, azmRewardService) {
    const now = new Date();
    let loginStreak = user.loginStreak || 0;

    if (user.lastLoginAt) {
        const lastLogin = new Date(user.lastLoginAt);
        const daysSinceLastLogin = _daysBetweenCalendarDates(lastLogin, now);

        if (daysSinceLastLogin === 0) {
            // Same calendar day — nothing changes. Skip the write entirely;
            // this is the path that fires repeatedly on /refresh for an
            // active user throughout a single day.
            return loginStreak;
        }
        if (daysSinceLastLogin === 1) {
            loginStreak += 1; // Consecutive calendar day
        } else {
            loginStreak = 1; // Streak broken (gap of 2+ days), restart
        }
    } else {
        loginStreak = 1; // First-ever recorded login
    }

    const previousStreak = user.loginStreak || 0;

    await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now, loginStreak },
    });

    if (loginStreak > previousStreak && azmRewardService) {
        // Fire-and-forget, exactly like the original login() call site —
        // the AZM credit must never block or fail the auth response itself.
        setImmediate(() => {
            azmRewardService.rewardLoginStreak(user.id, loginStreak)
                .catch((err) => console.error('[loginStreakService] AZM login streak reward error:', err.message));
        });
    }

    return loginStreak;
}

module.exports = { recordDailyLogin, _daysBetweenCalendarDates };
