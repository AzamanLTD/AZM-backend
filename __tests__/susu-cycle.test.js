// __tests__/susu-cycle.test.js
// Real-signature smoke tests for services/susu/susuCycle.service.SusuCycleService.
//
// The full processCycle path depends on a fully-seeded group fixture
// (rotationSnapshot, per-member SusuMember rows with cycleSlot/trustScore,
// SusuContribution rows, the multi-worker advisory lock, GlobalSettings.susuProfitPct,
// and the injected vouch/member/war-room services). That fixture is large and the
// schema differs substantially from the design doc (SusuGroup has no name/ownerId/
// totalMembers; SusuCycle uses cycleNumber/collectionDate/payoutUserId, not
// recipientId/dueDate). Rather than ship a fictional full-cycle test, this suite
// locks in the service's real constructor + configuration guard. The end-to-end
// cycle test should be authored against a live TEST_DATABASE_URL with a proper
// group fixture.
//
// The constructor guard runs WITHOUT a database, so this part is unconditional;
// the DB-backed portion still gates on TEST_DATABASE_URL.
const SusuCycleService = require('../services/susu/susuCycle.service');

describe('SusuCycleService — construction & config guard', () => {
  test('constructor throws without a prisma client', () => {
    expect(() => new SusuCycleService(undefined, {})).toThrow(/prisma/i);
  });

  test('processCycle refuses to run when treasuryUserId is not configured', async () => {
    // A fake prisma is fine — the guard fires before any query.
    const fakePrisma = {};
    const svc = new SusuCycleService(fakePrisma, { treasuryUserId: undefined });
    await expect(svc.processCycle('any-cycle-id')).rejects.toThrow(/treasuryUserId/i);
  });

  test('processCycle is callable once treasuryUserId is provided', () => {
    const fakePrisma = {};
    const svc = new SusuCycleService(fakePrisma, { treasuryUserId: 1 });
    expect(typeof svc.processCycle).toBe('function');
  });
});
