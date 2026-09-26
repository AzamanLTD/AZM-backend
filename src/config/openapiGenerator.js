/**
 * OpenAPI Spec Generator for Express 5.x
 *
 * Walks the Express app's router stack to auto-generate an OpenAPI 3.0.3 spec.
 * Uses a monkey-patch on app.use to capture mount paths (Express 5.x doesn't
 * expose them on layer objects like 4.x did).
 *
 * Supports two annotation styles:
 * 1. handler.openapi = { summary, description, tags, deprecated } — explicit
 * 2. JSDoc @summary/@description/@tags/@deprecated inside the handler function
 *
 * Usage:
 *   const { captureMountPaths, generateOpenAPISpec } = require('./openapiGenerator');
 *   captureMountPaths(app);  // call BEFORE mounting routes
 *   // ... mount routes ...
 *   const spec = generateOpenAPISpec(app);
 */

const logger = require('./logger');

function expressToOpenAPIPath(path) {
    return path.replace(/:(\w+)/g, '{$1}');
}

// ── Extract metadata from handler ───────────────────────────────────────────
// Checks for handler.openapi property first, then JSDoc in function toString()
function extractMetadata(handler, routeStack) {
    // 1. Check explicit openapi property on handler
    if (handler?.openapi && typeof handler.openapi === 'object') {
        return { ...handler.openapi };
    }

    // 2. Check for JSDoc in handler function's toString()
    if (handler) {
        const fnStr = handler.toString();
        const match = fnStr.match(/\/\*\*[\s\S]*?\*\//);
        if (match) {
            return parseJSDocBlock(match[0]);
        }
    }

    // 3. Check all middleware in the route stack for JSDoc
    if (routeStack) {
        for (const layer of routeStack) {
            const fn = layer?.handle;
            if (fn?.openapi) return { ...fn.openapi };
            const fnStr = fn?.toString?.() || '';
            const match = fnStr.match(/\/\*\*[\s\S]*?\*\//);
            if (match) return parseJSDocBlock(match[0]);
        }
    }

    return null;
}

function parseJSDocBlock(block) {
    const result = {};
    const summary = block.match(/@summary\s+(.+)/);
    if (summary) result.summary = summary[1].trim();
    const desc = block.match(/@description\s+(.+)/);
    if (desc) result.description = desc[1].trim();
    const tags = block.match(/@tags?\s+(.+)/);
    if (tags) result.tags = tags[1].split(',').map(t => t.trim());
    if (block.includes('@deprecated')) result.deprecated = true;
    return Object.keys(result).length ? result : null;
}

// ── Infer auth requirement from middleware stack ────────────────────────────
function inferAuth(route) {
    const layerKeys = (route?.stack || []).map(l =>
        l?.name?.toLowerCase() || ''
    );
    const hasProtect = layerKeys.some(k => k.includes('protect') || k.includes('auth') || k.includes('verify') || k.includes('isadmin'));
    const hasAdmin = layerKeys.some(k => k.includes('admin') || k.includes('isadmin'));
    const security = [];
    if (hasProtect) security.push({ bearerAuth: [] });
    if (hasAdmin) security.push({ adminAuth: [] });
    return security;
}

// ── Infer rate-limiter from path ────────────────────────────────────────────
function inferRateLimit(mountPath) {
    if (mountPath.includes('/api/withdraw') || mountPath.includes('/api/trades') ||
        mountPath.includes('/api/wallet') || mountPath.includes('/api/finance') ||
        mountPath.includes('/api/p2p') || mountPath.includes('/api/escrow') ||
        mountPath.includes('/api/vaults') || mountPath.includes('/api/susu') ||
        mountPath.includes('/api/deposit') || mountPath.includes('/api/dine-in') ||
        mountPath.includes('/api/marketplace-finance')) {
        return 'financial';
    }
    if (mountPath.includes('/api/auth')) return 'auth';
    return 'general';
}

// ── Capture mount paths by patching app.use ─────────────────────────────────
function captureMountPaths(app) {
    const originalUse = app.use.bind(app);
    app.use = function (path, ...handlers) {
        if (typeof path === 'function' || (typeof path === 'string' && path[0] !== '/')) {
            handlers = [path, ...handlers];
            path = '/';
        }
        const result = originalUse(path, ...handlers);
        const stack = app.router?.stack || app._router?.stack || [];
        if (stack.length > 0) {
            const lastLayer = stack[stack.length - 1];
            if (lastLayer?.name === 'router' || lastLayer?.handle?.stack) {
                Object.defineProperty(lastLayer, '_mountPath', {
                    value: typeof path === 'string' ? path : '/',
                    enumerable: false,
                    writable: true,
                });
            }
        }
        return result;
    };
}

// ── Walk the Express router stack recursively ───────────────────────────────
function walkStack(stack, basePath, paths, tagMap) {
    for (const layer of stack) {
        if ((layer.name === 'router' || layer.handle?.stack) && !layer.route) {
            const mountPath = layer._mountPath || '/';
            const fullPath = basePath === '/' ? mountPath : basePath + mountPath;
            walkStack(layer.handle.stack, fullPath, paths, tagMap);
            continue;
        }

        if (layer.route) {
            const routePath = layer.route.path || '';
            const fullPath = (basePath === '/' ? '' : basePath) + routePath;
            const openapiPath = expressToOpenAPIPath(fullPath);

            for (const method of Object.keys(layer.route.methods || {})) {
                if (method === 'head' || method === 'options') continue;

                const handlerStack = layer.route.stack || [];
                const lastHandler = handlerStack[handlerStack.length - 1];
                const handler = lastHandler?.handle;

                const meta = extractMetadata(handler, handlerStack);

                const pathParts = fullPath.split('/').filter(Boolean);
                const tag = pathParts[1] || 'unknown';
                tagMap.add(tag);

                const operation = {
                    tags: meta?.tags || [tag],
                    summary: meta?.summary || '',
                    description: meta?.description || '',
                    deprecated: meta?.deprecated || false,
                    security: inferAuth(layer.route),
                    'x-rate-limit': inferRateLimit(fullPath),
                    responses: {
                        200: { description: 'Successful response' },
                        400: { description: 'Bad request' },
                        401: { description: 'Unauthorized' },
                        403: { description: 'Forbidden' },
                        404: { description: 'Not found' },
                        500: { description: 'Internal server error' },
                    },
                };

                if (['post', 'put', 'patch'].includes(method)) {
                    operation.requestBody = {
                        content: {
                            'application/json': { schema: { type: 'object' } },
                        },
                    };
                }

                const pathParams = (fullPath.match(/:(\w+)/g) || []).map(p => p.slice(1));
                if (pathParams.length) {
                    operation.parameters = pathParams.map(name => ({
                        name, in: 'path', required: true, schema: { type: 'string' },
                    }));
                }

                if (!paths[openapiPath]) paths[openapiPath] = {};
                paths[openapiPath][method] = operation;
            }
        }
    }
}

// ── Main generator function ─────────────────────────────────────────────────
function generateOpenAPISpec(app) {
    const paths = {};
    const tagMap = new Set();

    try {
        const stack = app.router?.stack || app._router?.stack || [];
        walkStack(stack, '', paths, tagMap);
    } catch (err) {
        logger.error({ err }, '[openapi] Failed to walk router stack');
    }

    const tags = [...tagMap]
        .filter(t => t && t !== 'undefined' && t !== 'unknown')
        .sort()
        .map(name => ({ name, description: `${name} endpoints` }));

    return {
        openapi: '3.0.3',
        info: {
            title: 'AZAMAN API',
            version: '1.0.0',
            description: 'Auto-generated OpenAPI specification for the AZAMAN platform API.',
            contact: { name: 'AZAMAN Team', email: 'support@azaman.app' },
        },
        servers: [{ url: '/api', description: 'API base path' }],
        components: {
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                adminAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Admin-only endpoints' },
            },
        },
        tags,
        paths,
    };
}

function serveSpec(app) {
    return (req, res) => {
        const spec = generateOpenAPISpec(app);
        res.setHeader('Content-Type', 'application/json');
        res.json(spec);
    };
}

module.exports = { generateOpenAPISpec, serveSpec, captureMountPaths };
