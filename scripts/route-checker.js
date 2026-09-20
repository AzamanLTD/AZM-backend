#!/usr/bin/env node
/**
 * route-checker.js — CI check: every frontend request() call has a backend route.
 *
 * Scans src/lib/api.js and src/lib/marketplaceApi.js for request(...) calls,
 * extracts path + HTTP method, then scans routes/ (with mount prefixes from
 * server.js) for router.<method>('path', ...) handlers. Any frontend call with
 * no matching backend route exits non-zero.
 *
 * Usage: node scripts/route-checker.js
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');

// The authoritative frontend source (AZM-businessPortal) is supplied
// EXPLICITLY. CI checks that repository out and points
// ROUTE_CHECK_FRONTEND_ROOT at it; the historical default (a sibling clone
// named AZM-businessPortal) is kept for local development. The frontend
// repository is never inferred from the backend workspace — a backend-only
// checkout must never be mistaken for "no frontend calls".
const FRONTEND_ROOT = process.env.ROUTE_CHECK_FRONTEND_ROOT
    ? path.resolve(process.env.ROUTE_CHECK_FRONTEND_ROOT)
    : path.resolve(__dirname, '..', '..', 'AZM-businessPortal');

// GATE MODE (fail-closed): when route-check is used as a frontend/backend
// compatibility gate (CI sets ROUTE_CHECK_REQUIRE_FRONTEND=1), the
// authoritative frontend sources MUST be present and MUST yield a nonzero
// call set. A vacuous scan (0 frontend calls because the files are absent)
// must FAIL LOUDLY — "PASS" must always mean the frontend was actually
// scanned, never "there was nothing in this workspace to check".
const REQUIRE_FRONTEND = process.env.ROUTE_CHECK_REQUIRE_FRONTEND === '1';

// The authoritative frontend API layer scanned by this gate.
const FRONTEND_API_FILES = [
    path.join(FRONTEND_ROOT, 'src', 'lib', 'api.js'),
    path.join(FRONTEND_ROOT, 'src', 'lib', 'marketplaceApi.js'),
];

// ── 1. Parse route mounts from server.js ────────────────────────────────────

function parseRouteMounts() {
    // Route mounts now live in the central registry src/routes/index.js
    // (mountRoutes) as well as server.js; scan both.
    const sources = ['server.js', path.join('src', 'routes', 'index.js')];
    const mounts = [];
    const serverCode = sources
        .map((f) => {
            const p = path.join(BACKEND_ROOT, f);
            return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        })
        .join('\n');

    // Map variable → file: const fooRoutes = require('./routes/fooRoutes')
    const requireMap = {};
    const requireRegex = /(?:const|let|var)\s+(\w+Routes)\s*=\s*require\(['"](?:\.\.\/)*(?:routes\/)?([^'"]+)['"]\)/g;
    let m;
    while ((m = requireRegex.exec(serverCode)) !== null) {
        requireMap[m[1]] = m[2].replace(/\.js$/, '');
    }

    // Collect app.use('/api/prefix', ..., <routes>)
    const useRegex = /app\.use\(\s*['"]([^'"]+)['"][^)]*?require\(\s*['"](?:\.\.\/)*(?:routes\/)?([^'"]+)['"]\s*\)/g;
    while ((m = useRegex.exec(serverCode)) !== null) {
        const file = m[2] ? m[2].replace(/\.js$/, '') : requireMap[m[3]];
        if (file) mounts.push({ prefix: m[1], file });
    }

    return mounts;
}

// ── 2. Extract backend routes ───────────────────────────────────────────────

function extractBackendRoutes(mounts) {
    const routes = new Set();
    for (const { prefix, file } of mounts) {
        const filePath = path.join(BACKEND_ROOT, 'routes', file + '.js');
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, 'utf8');

        const routeRegex = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
        let m;
        while ((m = routeRegex.exec(code)) !== null) {
            const method = m[1].toUpperCase();
            const normalized = m[2].replace(/:[^/]+/g, '*');
            const fullPath = (prefix + normalized).replace(/\/+/g, '/');
            routes.add(`${method} ${fullPath}`);
        }
    }
    return routes;
}

// ── 3. Extract frontend request() calls ─────────────────────────────────────

/**
 * Extract the full argument string of a request( call by finding the matching
 * closing paren, tracking paren depth. Handles strings, backticks, and braces
 * inside template literals.
 */
function extractCallArgs(code, startIndex) {
    // startIndex points right after "request("
    let depth = 1;
    let i = startIndex;
    let inString = false;
    let stringChar = null;
    let inTemplate = false;
    let templateDepth = 0; // ${} nesting inside backticks

    while (i < code.length && depth > 0) {
        const ch = code[i];

        if (inString) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === stringChar) { inString = false; i++; continue; }
            i++; continue;
        }

        if (inTemplate) {
            if (ch === '`' && templateDepth === 0) { inTemplate = false; i++; continue; }
            if (ch === '$' && code[i + 1] === '{') { templateDepth++; i += 2; continue; }
            if (ch === '}' && templateDepth > 0) { templateDepth--; i++; continue; }
            if (ch === '`' && templateDepth > 0) { /* nested template - skip for now */ i++; continue; }
            i++; continue;
        }

        if (ch === "'" || ch === '"') { inString = true; stringChar = ch; i++; continue; }
        if (ch === '`') { inTemplate = true; i++; continue; }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        i++;
    }

    return code.substring(startIndex, i - 1); // exclude closing )
}

function extractFrontendCalls() {
    const calls = [];
    const seen = new Set();

    for (const filePath of FRONTEND_API_FILES) {
        if (!fs.existsSync(filePath)) continue;
        const code = fs.readFileSync(filePath, 'utf8');
        const relFile = path.relative(FRONTEND_ROOT, filePath);

        // Find all request( occurrences
        const requestRegex = /request\(/g;
        let m;
        while ((m = requestRegex.exec(code)) !== null) {
            const argsStr = extractCallArgs(code, m.index + m[0].length);

            // Extract the first argument (the path) — it's a string or template literal
            let rawPath = null;

            // Template literal: `...`
            const tmplMatch = argsStr.match(/^`([^`]+(?:\$\{[^}]*\}[^`]*)*)`/);
            if (tmplMatch) {
                // Get the full template literal by finding the matching backtick
                let pathStr = '';
                let i = 0;
                while (i < argsStr.length && argsStr[i] !== '`') i++;
                i++; // skip opening backtick
                let tmplDepth = 0;
                while (i < argsStr.length) {
                    if (argsStr[i] === '$' && argsStr[i + 1] === '{') { tmplDepth++; pathStr += '*'; i += 2; continue; }
                    if (argsStr[i] === '}' && tmplDepth > 0) { tmplDepth--; i++; continue; }
                    if (argsStr[i] === '`' && tmplDepth === 0) break;
                    if (tmplDepth > 0) { i++; continue; } // skip inside ${...}
                    pathStr += argsStr[i]; i++;
                }
                rawPath = pathStr;
            } else {
                // Regular string: '...' or "..."
                const strMatch = argsStr.match(/^['"]([^'"]+)['"]/);
                if (strMatch) rawPath = strMatch[1];
            }

            if (!rawPath || !rawPath.startsWith('/api/')) continue;

            // Strip query strings
            rawPath = rawPath.replace(/\?.*$/, '').replace(/\*+/g, '*');
            // Strip trailing * that directly follows a non-/ character
            // (query-string interpolation like /api/foo* from \${qs ? `?${qs}` : ''})
            // but keep /api/foo/* (path-segment wildcard from \${id})
            rawPath = rawPath.replace(/([^/])\*$/, '$1');

            // Detect method from options argument
            let method = 'GET';
            const methodMatch = argsStr.match(/method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
            if (methodMatch) method = methodMatch[1].toUpperCase();

            const key = `${method} ${rawPath}`;
            if (!seen.has(key)) {
                seen.add(key);
                calls.push({ method, path: rawPath, file: relFile });
            }
        }
    }

    return calls;
}

// ── 4. Compare ──────────────────────────────────────────────────────────────

function pathMatches(frontendPath, backendPath) {
    // Normalize: strip trailing slashes, but keep trailing /* as a segment
    let fp = frontendPath.replace(/\/+$/, '') || '/';
    let bp = backendPath.replace(/\/+$/, '') || '/';
    // If backend has a trailing /* from router.get('/:id'), it becomes a segment
    // If backend has '/' from router.get('/'), it becomes empty — normalize
    if (fp === '') fp = '/';
    if (bp === '') bp = '/';
    const fpParts = fp.split('/').filter(p => p !== '');
    const bpParts = bp.split('/').filter(p => p !== '');
    if (fpParts.length !== bpParts.length) return false;
    for (let i = 0; i < fpParts.length; i++) {
        if (fpParts[i] === '*' || bpParts[i] === '*') continue;
        if (fpParts[i] !== bpParts[i]) return false;
    }
    return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
    console.log('route-checker: verifying frontend API calls have backend routes\n');

    const mounts = parseRouteMounts();
    console.log(`  ${mounts.length} route mounts in server.js`);

    const backendRoutes = extractBackendRoutes(mounts);
    console.log(`  ${backendRoutes.size} backend route handlers`);

    // Gate integrity: the expected frontend sources must actually be present.
    const missingFiles = FRONTEND_API_FILES.filter((f) => !fs.existsSync(f));
    if (missingFiles.length > 0) {
        if (REQUIRE_FRONTEND) {
            console.error('FAIL: route-check is running as a frontend/backend compatibility gate,');
            console.error('but the expected authoritative frontend sources are ABSENT:');
            for (const f of missingFiles) console.error(`  ${f}`);
            console.error(`FRONTEND_ROOT resolved to: ${FRONTEND_ROOT}`);
            console.error('Supply the AZM-businessPortal checkout via ROUTE_CHECK_FRONTEND_ROOT');
            console.error('(CI checks the repository out explicitly for this step).');
            console.error('This failure is deliberate: an absent frontend must never yield a vacuous PASS.');
            process.exit(1);
        }
        console.log('  WARNING: expected frontend sources are ABSENT — 0 frontend calls scanned.');
        console.log(`  FRONTEND_ROOT resolved to: ${FRONTEND_ROOT}`);
        console.log('  This run verified backend route extraction only. It is NOT a');
        console.log('  frontend/backend compatibility proof. Set ROUTE_CHECK_REQUIRE_FRONTEND=1');
        console.log('  in CI to make absent frontend sources fail the gate.');
    }

    const frontendCalls = extractFrontendCalls();
    console.log(`  ${frontendCalls.length} frontend API calls\n`);

    if (REQUIRE_FRONTEND && frontendCalls.length === 0) {
        console.error('FAIL: gate mode requires a NONZERO frontend call set, but 0 frontend API');
        console.error('calls were extracted from the supplied frontend sources. A vacuous scan');
        console.error('must never report PASS — check that the frontend checkout contains');
        console.error('src/lib/api.js and src/lib/marketplaceApi.js with request(...) calls.');
        process.exit(1);
    }

    const unmatched = [];
    for (const call of frontendCalls) {
        let found = false;
        for (const route of backendRoutes) {
            const [method, bpath] = route.split(' ');
            if (method === call.method && pathMatches(call.path, bpath)) {
                found = true;
                break;
            }
        }
        if (!found) unmatched.push(call);
    }

    if (unmatched.length === 0) {
        console.log('PASS: All frontend API calls have matching backend routes.');
        process.exit(0);
    } else {
        console.log(`FAIL: ${unmatched.length} frontend call(s) have no matching backend route:\n`);
        for (const call of unmatched) {
            console.log(`  ${call.method} ${call.path}`);
            console.log(`    in ${call.file}\n`);
        }
        process.exit(1);
    }
}

main();
