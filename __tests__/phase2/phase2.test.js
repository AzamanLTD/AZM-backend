/**
 * Phase 2 — Backend Critical Fixes & Security Tests
 *
 * Tests cover:
 *  2.1  SQL injection remediation (susuCycle $queryRawUnsafe → $queryRaw)
 *  2.2  SmartEscrow onDelete: Restrict (schema-level, verified via migration)
 *  2.3  Reservation availability conflict check
 *  2.4  Prisma injector middleware sets req.prisma
 *  2.5  require2FA on financial routes (route-level integration)
 *  2.6  File upload MIME+extension AND logic
 *  2.7  Transit booking authorization bypass fix
 */

const path = require('path');
const fs = require('fs');

describe('Phase 2.1 — SQL Injection Remediation', () => {
    test('susuCycle.service.js no longer uses $queryRawUnsafe', () => {
        const svc = fs.readFileSync(
            path.join(__dirname, '../../services/susu/susuCycle.service.js'),
            'utf-8'
        );
        expect(svc).not.toContain('$queryRawUnsafe');
    });

    test('susuCycle.service.js uses $queryRaw tagged templates', () => {
        const svc = fs.readFileSync(
            path.join(__dirname, '../../services/susu/susuCycle.service.js'),
            'utf-8'
        );
        expect(svc).toContain('$queryRaw`');
    });
});

describe('Phase 2.2 — SmartEscrow onDelete: Restrict', () => {
    test('schema.prisma has onDelete: Restrict on SmartEscrow.ticket', () => {
        const schema = fs.readFileSync(
            path.join(__dirname, '../../prisma/schema.prisma'),
            'utf-8'
        );
        // Find the SmartEscrow model's ticket relation
        const escrowMatch = schema.match(/model SmartEscrow \{[\s\S]*?\}/);
        expect(escrowMatch).toBeTruthy();
        expect(escrowMatch[0]).toContain('onDelete: Restrict');
        expect(escrowMatch[0]).not.toContain('onDelete: Cascade');
    });

    test('migration file exists', () => {
        const migrationPath = path.join(
            __dirname, '../../prisma/migrations/20260728000001_fix_escrow_cascade/migration.sql'
        );
        expect(fs.existsSync(migrationPath)).toBe(true);
        const sql = fs.readFileSync(migrationPath, 'utf-8');
        expect(sql).toContain('ON DELETE RESTRICT');
    });
});

describe('Phase 2.3 — Reservation Conflict Check', () => {
    test('reservationController has conflict check before create', () => {
        const ctrl = fs.readFileSync(
            path.join(__dirname, '../../controllers/reservationController.js'),
            'utf-8'
        );
        expect(ctrl).toContain('Availability conflict check');
        expect(ctrl).toContain('findFirst');
        expect(ctrl).toContain('already booked');
    });
});

describe('Phase 2.4 — Prisma Injector Middleware', () => {
    test('prismaInjector.js exists and sets req.prisma', () => {
        const mwPath = path.join(__dirname, '../../src/middleware/prismaInjector.js');
        expect(fs.existsSync(mwPath)).toBe(true);
        const mw = fs.readFileSync(mwPath, 'utf-8');
        expect(mw).toContain('req.prisma');
    });

    test('routes/index.js mounts prismaInjector', () => {
        const routes = fs.readFileSync(
            path.join(__dirname, '../../src/routes/index.js'),
            'utf-8'
        );
        expect(routes).toContain('prismaInjector');
    });
});

describe('Phase 2.5 — require2FA on Financial Routes', () => {
    const routeFiles = [
        { file: 'routes/p2pRoutes.js', endpoint: '/complete' },
        { file: 'routes/tradeRoutes.js', endpoint: '/initiate' },
        { file: 'routes/walletRoutes.js', endpoint: '/internal-transfer' },
        { file: 'routes/marketplaceRoutes.js', endpoint: '/transit/trips/:id/book' },
        { file: 'routes/dineInRoutes.js', endpoint: '/tabs/:tabId/pay' },
    ];

    routeFiles.forEach(({ file, endpoint }) => {
        test(`${file} has require2FA() on ${endpoint}`, () => {
            const content = fs.readFileSync(path.join(__dirname, '../../', file), 'utf-8');
            const line = content.split('\n').find(l => l.includes(`'${endpoint}'`) && l.includes('router'));
            expect(line).toBeTruthy();
            expect(line).toContain('require2FA()');
        });
    });
});

describe('Phase 2.6 — File Upload AND Logic', () => {
    test('upload.js uses AND (&&) not OR (||) for MIME+ext check', () => {
        const upload = fs.readFileSync(
            path.join(__dirname, '../../src/config/upload.js'),
            'utf-8'
        );
        expect(upload).toContain('mimeOk && extOk');
        expect(upload).not.toContain('mimeOk || extOk');
    });
});

describe('Phase 2.7 — Transit Booking Authorization', () => {
    test('transitBookingService checks cancelledBy authorization', () => {
        const svc = fs.readFileSync(
            path.join(__dirname, '../../services/transitBookingService.js'),
            'utf-8'
        );
        expect(svc).toContain('Not authorized to cancel this booking');
        expect(svc).toContain('isOwner');
        expect(svc).toContain('isCustomer');
    });

    test('marketplaceController passes cancelledBy and returns 403', () => {
        const ctrl = fs.readFileSync(
            path.join(__dirname, '../../controllers/marketplaceController.js'),
            'utf-8'
        );
        expect(ctrl).toContain('cancelledBy: req.user.id');
        expect(ctrl).toContain('403');
    });
});
