/**
 * r272 — Bootstrap runbook documentation contract (real codebase checks)
 *
 * The runbook (docs/RBAC_SUPER_ADMIN_BOOTSTRAP.md) makes an operational
 * promise to platform operators: specialized-role enforcement is PARTIAL, and
 * the surfaces that remain outside authoritative effective-role enforcement
 * are inventoried. This suite fails if that promise drifts from the
 * codebase, in either direction:
 *
 *   1. The specific partial-enforcement warning text must remain in the doc.
 *   2. The legacy (claim-based) route inventory in the doc must match the
 *      ACTUAL set of route files with a claim-based admin boundary — every
 *      such file must be listed, and no listed file may disappear.
 *   3. The claim-gated controller handlers named in the doc must still exist
 *      and must still be claim-gated (requireAdminPermission / JWT claim),
 *      and the enforced flows named in the doc must still actually resolve
 *      effective roles from authoritative database state.
 *   4. The overbroad legacy claim ("restricted to the catalog's read-only
 *      permission set" stated as if platform-wide) must not return.
 *
 * It is deliberately NOT a generic wording check: each assertion ties a
 * documented statement to a verifiable codebase fact.
 */

const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'docs', 'RBAC_SUPER_ADMIN_BOOTSTRAP.md');
const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const CONTROLLERS_DIR = path.join(__dirname, '..', 'controllers');

const readDoc = () => fs.readFileSync(DOC, 'utf8');

/** Route files whose admin boundary is claim-based (no effective-role
 *  resolution) — mirrors the doc's inventory contract. adminRbacRoutes.js is
 *  excluded: its handlers enforce in-controller via the effective-role
 *  resolver (except the three claim-gated handlers inventoried separately). */
function findClaimBasedAdminRouteFiles() {
    return fs
        .readdirSync(ROUTES_DIR)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => f !== 'adminRbacRoutes.js')
        .filter((f) => {
            const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
            return (
                /\bisAdmin\b|\brequireAdmin\b|\badminOnly\b/.test(src) &&
                !/resolveEffectiveAdminRole/.test(src)
            );
        })
        .sort();
}

describe('r272 bootstrap runbook documentation contract', () => {
    describe('partial-enforcement operational warning', () => {
        it('must prominently state that specialized-role enforcement is partial, not platform-wide', () => {
            const doc = readDoc();
            expect(doc).toMatch(
                /Scope of enforcement — READ BEFORE ASSIGNING ANY SPECIALIZED ROLE/
            );
            expect(doc).toMatch(/Specialized-role enforcement is \*\*partial, not platform-wide\*\*/);
        });

        it('must warn that specialized roles are not globally least-privilege identities until migration completes', () => {
            const doc = readDoc();
            expect(doc).toMatch(
                /must NOT be treated as globally least-privilege\s+identities\*\* until the legacy admin endpoint migration is complete/
            );
            for (const role of [
                'READ_ONLY_ADMIN',
                'FINANCE_ADMIN',
                'SUPPORT_ADMIN',
                'COMPLIANCE_ADMIN',
            ]) {
                expect(doc).toContain(role);
            }
        });

        it('must state that enforcement applies only to flows explicitly resolving effective roles from authoritative database state', () => {
            const doc = readDoc();
            expect(doc).toMatch(
                /explicitly resolve\s+the acting admin's role from authoritative database state/
            );
            expect(doc).toMatch(/AdminRoleAssignment/);
        });

        it('must state that a listed catalog permission does not automatically secure an endpoint', () => {
            const doc = readDoc();
            expect(doc).toMatch(
                /does not automatically secure an endpoint\*\* simply\s+because a permission is listed there/
            );
        });

        it('must not reinstate the overbroad platform-wide READ_ONLY_ADMIN claim', () => {
            const doc = readDoc();
            // The corrected phrasing scopes the restriction to enforced flows.
            expect(doc).toMatch(
                /Within\s+the \*\*enforced flows\*\* listed below it is restricted to the catalog's\s+read-only permission set/
            );
            // The old unqualified claim must be gone.
            expect(doc).not.toMatch(
                /keeps the account administrative but\s+restricted to the catalog's read-only permission set/
            );
        });

        it('must keep the legacy migration explicitly out of scope for this branch', () => {
            const doc = readDoc();
            expect(doc).toMatch(/separately tracked task/);
        });
    });

    describe('legacy route inventory matches the codebase', () => {
        it('every claim-based admin route file in the codebase is listed in the doc inventory', () => {
            const doc = readDoc();
            const actual = findClaimBasedAdminRouteFiles();
            expect(actual.length).toBeGreaterThan(20); // sanity: the boundary is real and large
            const missing = actual.filter((f) => !doc.includes(`routes/${f}`));
            expect(missing).toEqual([]);
        });

        it('no stale entries: every file inventoried in the doc exists and is still claim-based', () => {
            const doc = readDoc();
            const listed = [...doc.matchAll(/- `routes\/([a-zA-Z0-9]+\.js)`/g)].map((m) => m[1]);
            expect(listed.length).toBeGreaterThan(20);
            const actual = new Set(findClaimBasedAdminRouteFiles());
            const stale = listed.filter((f) => !actual.has(f));
            expect(stale).toEqual([]);
        });
    });

    describe('claim-gated and enforced surfaces named in the doc match the code', () => {
        const readController = (f) =>
            fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8');

        it('the documented claim-gated handlers still use the claim-based permission gate', () => {
            const src = readController('adminRbacController.js');
            const doc = readDoc();
            for (const handler of [
                'listApprovals',
                'exportAuditLog',
                'getSusuHealthDashboard',
            ]) {
                // handler exists
                expect(src).toMatch(new RegExp(`async function ${handler}\\b`));
                // doc inventories it as claim-gated
                expect(doc).toContain(handler);
            }
            // the claim-based gate itself (reads req.user claim) is still what
            // protects them — i.e. they are NOT behind the effective-role
            // resolver
            expect(src).toMatch(/checkAdminPermission\(req\.user, 'audit\.view'\)/);
            expect(src).toMatch(/checkAdminPermission\(req\.user, 'audit\.export'\)/);
            expect(src).toMatch(/checkAdminPermission\(req\.user, 'susu\.health'\)/);
        });

        it('the documented enforced flows really do resolve effective roles from authoritative state', () => {
            const rbac = readController('adminRbacController.js');
            const admin = readController('adminController.js');
            const roleAdmin = readController('adminRoleAdminController.js');

            // approval lifecycle
            for (const fn of ['createApprovalRequest', 'approveRequest', 'rejectRequest']) {
                expect(rbac).toMatch(new RegExp(`async function ${fn}\\b`));
            }
            expect(rbac.match(/resolveEffectiveAdminRole/g).length).toBeGreaterThan(3);

            // approveWithdrawal
            expect(admin).toMatch(/exports\.approveWithdrawal = async/);
            expect(admin).toMatch(/resolveEffectiveAdminRole/);

            // provisioning endpoints
            expect(roleAdmin).toMatch(/resolveEffectiveAdminRole/);
        });
    });
});
