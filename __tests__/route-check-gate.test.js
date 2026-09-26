/**
 * route-check-gate.test.js — gate-integrity regression for scripts/route-checker.js.
 *
 * §Gate: "PASS" must always mean the frontend was actually scanned. A
 * backend-only workspace (the historical CI condition) used to yield
 * "0 frontend API calls / PASS" — a vacuous gate. The checker now supports
 * fail-closed gate mode (ROUTE_CHECK_REQUIRE_FRONTEND=1) and explicit
 * frontend supply (ROUTE_CHECK_FRONTEND_ROOT), and CI checks the
 * authoritative frontend (AZM-businessPortal) out for the route-check step.
 *
 * These tests pin the gate so a future CI or checker change can never
 * silently turn the route check back into a zero-call PASS.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECKER = path.join(__dirname, '..', 'scripts', 'route-checker.js');

function runChecker(envOverrides) {
    const r = spawnSync(process.execPath, [CHECKER], {
        encoding: 'utf8',
        env: { ...process.env, ...envOverrides },
    });
    return { code: r.status, output: `${r.stdout}\n${r.stderr}` };
}

function makeTempFrontend(apiJs, marketplaceJs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-routegate-'));
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'lib', 'api.js'), apiJs || '');
    fs.writeFileSync(path.join(root, 'src', 'lib', 'marketplaceApi.js'), marketplaceJs || '');
    return root;
}

describe('route-check gate integrity (no vacuous PASS)', () => {
    afterAll(() => {
        // best-effort temp cleanup
        for (const d of fs.readdirSync(os.tmpdir())) {
            if (d.startsWith('azm-routegate-')) {
                fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
            }
        }
    });

    test('GATE MODE: absent frontend sources FAIL LOUDLY (exit 1, missing files named) — never a zero-call PASS', () => {
        const { code, output } = runChecker({
            ROUTE_CHECK_REQUIRE_FRONTEND: '1',
            ROUTE_CHECK_FRONTEND_ROOT: path.join(os.tmpdir(), `azm-nonexistent-${Date.now()}`),
        });
        expect(code).toBe(1);
        expect(output).toMatch(/FAIL: route-check is running as a frontend\/backend compatibility gate/);
        expect(output).toContain('src/lib/api.js');
        expect(output).toContain('src/lib/marketplaceApi.js');
        expect(output).not.toMatch(/PASS: All frontend API calls/);
    });

    test('GATE MODE: ZERO extracted frontend calls fail the gate even when the files exist (empty vacuous scan ≠ PASS)', () => {
        const frontendRoot = makeTempFrontend('// no request() calls here\n', '// none here either\n');
        const { code, output } = runChecker({
            ROUTE_CHECK_REQUIRE_FRONTEND: '1',
            ROUTE_CHECK_FRONTEND_ROOT: frontendRoot,
        });
        expect(code).toBe(1);
        expect(output).toMatch(/FAIL: gate mode requires a NONZERO frontend call set/);
        expect(output).not.toMatch(/PASS: All frontend API calls/);
    });

    test('GATE MODE POSITIVE CONTROL: real matching frontend calls PASS and the scanned count is reported', () => {
        // POST /api/auth/login is a stable, real backend route (mounted at
        // /api/auth in src/routes/index.js, handler in routes/authRoutes.js).
        const frontendRoot = makeTempFrontend(
            "export function login(body) {\n  return request('/api/auth/login', { method: 'POST', body });\n}\n",
            "export const noop = () => {};\n"
        );
        const { code, output } = runChecker({
            ROUTE_CHECK_REQUIRE_FRONTEND: '1',
            ROUTE_CHECK_FRONTEND_ROOT: frontendRoot,
        });
        expect(code).toBe(0);
        expect(output).toContain('1 frontend API calls');
        expect(output).toMatch(/PASS: All frontend API calls have matching backend routes/);
    });

    test('GATE MODE: a frontend call with NO matching backend route fails the gate (matching logic still enforced)', () => {
        const frontendRoot = makeTempFrontend(
            "export function ghost() {\n  return request('/api/no/such/route/anywhere', { method: 'GET' });\n}\n",
            ''
        );
        const { code, output } = runChecker({
            ROUTE_CHECK_REQUIRE_FRONTEND: '1',
            ROUTE_CHECK_FRONTEND_ROOT: frontendRoot,
        });
        expect(code).toBe(1);
        expect(output).toMatch(/FAIL: 1 frontend call\(s\) have no matching backend route/);
        expect(output).toContain('GET /api/no/such/route/anywhere');
    });

    test('LEGACY (non-gate) MODE: absent frontend sources no longer masquerade as compatibility — the vacuous run is labeled loudly as NOT a proof', () => {
        const { code, output } = runChecker({
            ROUTE_CHECK_FRONTEND_ROOT: path.join(os.tmpdir(), `azm-nonexistent-${Date.now()}`),
        });
        // Local-dev ergonomics preserved (exit 0 without a frontend clone),
        // but the output can never be quoted as a compatibility PASS.
        expect(code).toBe(0);
        expect(output).toContain('WARNING: expected frontend sources are ABSENT — 0 frontend calls scanned.');
        expect(output).toContain('NOT a');
        expect(output).toMatch(/frontend\/backend compatibility proof/);
    });
});
