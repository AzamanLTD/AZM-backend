'use strict';
// =============================================================================
// WORKSTREAM D (PR #366) — BOOT-TIME PROVISIONING WIRING (autoRelease.js)
//
// Render's Free plan does NOT execute the pre-deploy command, so the boot-time
// autoRelease.js chain is the REAL production provisioning path for the
// BusinessProfile.offeredCategories column. This suite pins the two facts the
// work order demands:
//   1. the boot chain actually CALLS the offered-categories installer
//      (a drift failure must be attributable to a wired step, not a
//      forgotten one);
//   2. a provisioning/drift failure is RECORDED in releaseStatus — which
//      /api/health exposes under susu.release — and never swallowed into a
//      log line that makes the process look healthy-provisioned.
//
// The installer is mocked to throw the exact drift error the real module
// throws; every other autoRelease step runs for real against the disposable
// PostgreSQL test database exactly as CI provisions it.
// =============================================================================

jest.mock('../infra/install-business-offered-categories-overlay', () => ({
    installBusinessOfferedCategoriesOverlay: jest.fn(async () => {
        throw new Error(
            'BusinessProfile.offeredCategories drift: simulated incompatible shape');
    }),
    ADD_COLUMN_SQL: '-- mocked',
    VALIDATE_SQL: '-- mocked',
}));

const { PrismaClient } = require('@prisma/client');
const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('autoRelease boot path wires the offered-categories overlay (fail-visible)', () => {
    test('a drift failure is recorded in releaseStatus — never merely logged', async () => {
        const { autoRelease, releaseStatus } = require('../infra/autoRelease');
        const db = new PrismaClient();
        try {
            const status = await autoRelease(db, { force: true });

            // 1. The boot chain CALLED the installer (proves wiring).
            const overlay = require('../infra/install-business-offered-categories-overlay');
            expect(overlay.installBusinessOfferedCategoriesOverlay).toHaveBeenCalled();

            // 2. The failure is RECORDED — /api/health exposes releaseStatus
            //    verbatim under susu.release, so an operator sees the drift
            //    instead of a silently unprovisioned column.
            expect(status.offeredCategoriesOverlay).toBeDefined();
            expect(status.offeredCategoriesOverlay.error).toMatch(/drift/i);

            // 3. The surrounding boot chain still completes (the established
            //    non-fatal convention) — the error is surfaced, not fatal.
            expect(status.error).toBeNull();
        } finally {
            await db.$disconnect();
        }
    });
});
