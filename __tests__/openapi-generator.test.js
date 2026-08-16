const express = require('express');
const { generateOpenAPISpec, captureMountPaths } = require('../src/config/openapiGenerator');

function createTestApp() {
    const app = express();
    captureMountPaths(app);

    // Simple public route
    app.get('/api/public/health', (req, res) => res.json({ ok: true }));

    // Auth-protected route with openapi annotation
    const getUserHandler = (req, res) => res.json({ id: '123' });
    getUserHandler.openapi = {
        summary: 'Get current user profile',
        description: "Returns the authenticated user's profile data",
        tags: ['users', 'profile'],
    };
    app.get('/api/users/me', function protect(req, res, next) { next(); }, getUserHandler);

    // POST with path params
    app.post('/api/users/:id/follow', function protect(req, res, next) { next(); }, (req, res) => {
        res.json({ ok: true });
    });

    // Sub-router test
    const adminRouter = express.Router();
    adminRouter.get('/users', function protect(req, res, next) { next(); }, function isAdmin(req, res, next) { next(); }, (req, res) => {
        res.json([]);
    });
    app.use('/api/admin', adminRouter);

    // Financial sub-router
    const walletRouter = express.Router();
    walletRouter.post('/transfer', function protect(req, res, next) { next(); }, (req, res) => {
        res.json({ ok: true });
    });
    app.use('/api/wallet', walletRouter);

    // Deprecated route
    const legacyHandler = (req, res) => res.json({ old: true });
    legacyHandler.openapi = { deprecated: true, summary: 'Legacy endpoint', tags: ['legacy'] };
    app.get('/api/legacy/old', legacyHandler);

    return app;
}

describe('OpenAPI Generator', () => {
    let app, spec;

    beforeAll(() => {
        app = createTestApp();
        spec = generateOpenAPISpec(app);
    });

    test('generates valid OpenAPI 3.0.3 structure', () => {
        expect(spec.openapi).toBe('3.0.3');
        expect(spec.info.title).toBe('AZAMAN API');
        expect(spec.info.version).toBe('1.0.0');
        expect(spec.paths).toBeDefined();
        expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
        expect(spec.components.securitySchemes.adminAuth).toBeDefined();
    });

    test('discovers GET routes', () => {
        expect(spec.paths['/api/public/health']).toBeDefined();
        expect(spec.paths['/api/public/health'].get).toBeDefined();
        expect(spec.paths['/api/users/me'].get).toBeDefined();
    });

    test('discovers POST routes', () => {
        expect(spec.paths['/api/wallet/transfer'].post).toBeDefined();
    });

    test('discovers routes in sub-routers', () => {
        expect(spec.paths['/api/admin/users']).toBeDefined();
        expect(spec.paths['/api/admin/users'].get).toBeDefined();
    });

    test('converts Express :param to OpenAPI {param}', () => {
        expect(spec.paths['/api/users/{id}/follow']).toBeDefined();
        expect(spec.paths['/api/users/{id}/follow'].post.parameters).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'id', in: 'path', required: true })
            ])
        );
    });

    test('adds requestBody for POST/PUT/PATCH', () => {
        expect(spec.paths['/api/wallet/transfer'].post.requestBody).toBeDefined();
        expect(spec.paths['/api/wallet/transfer'].post.requestBody.content['application/json']).toBeDefined();
    });

    test('infers bearerAuth from protect middleware', () => {
        expect(spec.paths['/api/users/me'].get.security).toEqual(
            expect.arrayContaining([expect.objectContaining({ bearerAuth: [] })])
        );
    });

    test('infers adminAuth from admin middleware', () => {
        const adminOp = spec.paths['/api/admin/users'].get;
        expect(adminOp.security).toEqual(
            expect.arrayContaining([expect.objectContaining({ adminAuth: [] })])
        );
    });

    test('extracts openapi.summary and openapi.description', () => {
        const op = spec.paths['/api/users/me'].get;
        expect(op.summary).toBe('Get current user profile');
        expect(op.description).toBe("Returns the authenticated user's profile data");
    });

    test('extracts openapi.tags', () => {
        const op = spec.paths['/api/users/me'].get;
        expect(op.tags).toEqual(expect.arrayContaining(['users', 'profile']));
    });

    test('extracts openapi.deprecated flag', () => {
        expect(spec.paths['/api/legacy/old'].get.deprecated).toBe(true);
    });

    test('infers financial rate-limit for wallet routes', () => {
        expect(spec.paths['/api/wallet/transfer'].post['x-rate-limit']).toBe('financial');
    });

    test('infers general rate-limit for public routes', () => {
        expect(spec.paths['/api/public/health'].get['x-rate-limit']).toBe('general');
    });

    test('generates standard error responses', () => {
        const responses = spec.paths['/api/users/me'].get.responses;
        expect(responses[400]).toBeDefined();
        expect(responses[401]).toBeDefined();
        expect(responses[403]).toBeDefined();
        expect(responses[500]).toBeDefined();
    });

    test('generates tags from discovered paths', () => {
        expect(spec.tags).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'users' }),
                expect.objectContaining({ name: 'admin' }),
                expect.objectContaining({ name: 'wallet' }),
            ])
        );
    });

    test('handles empty app gracefully', () => {
        const emptyApp = express();
        captureMountPaths(emptyApp);
        const emptySpec = generateOpenAPISpec(emptyApp);
        expect(emptySpec.openapi).toBe('3.0.3');
        expect(Object.keys(emptySpec.paths)).toHaveLength(0);
    });
});
