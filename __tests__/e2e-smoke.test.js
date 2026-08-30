// __tests__/e2e-smoke.test.js
// =============================================================================
// E2E Smoke Tests — Core flows per vertical.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[e2e-smoke] TEST_DATABASE_URL not set — skipping E2E smoke tests. Set it to a disposable Postgres URL to enable them.');

describeOrSkip('E2E Smoke Tests — Core Flows', () => {
    let request, app;
    let customerToken, customerRefresh;
    let businessToken, businessRefresh;
    let businessProfileId, bizId;
    let productId;
    let reservationId;
    const ts = Date.now();
    const customerCreds = { email: `cust_${ts}@azaman.test`, username: `cust_${ts}`, password: 'Str0ng!Pass#2026' };
    const businessCreds = { email: `biz_${ts}@azaman.test`, username: `biz_${ts}`, password: 'Str0ng!Pass#2026' };
    function authHeader(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }
    beforeAll(async () => { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx'; request = require('supertest'); app = require('../server'); });

    describe('1. Auth Flow', () => {
        test('register customer', async () => { const res = await request(app).post('/api/auth/register').send(customerCreds); expect([200, 201]).toContain(res.statusCode); expect(res.body.success).toBe(true); });
        test('register business owner', async () => { const res = await request(app).post('/api/auth/register').send(businessCreds); expect([200, 201]).toContain(res.statusCode); expect(res.body.success).toBe(true); });
        test('login as customer → get tokens', async () => { const res = await request(app).post('/api/auth/login').send({ email: customerCreds.email, password: customerCreds.password }); expect(res.statusCode).toBe(200); customerToken = res.body.accessToken || res.body.token; customerRefresh = res.body.refreshToken; expect(customerToken).toBeTruthy(); expect(customerRefresh).toBeTruthy(); });
        test('login as business owner → get tokens', async () => { const res = await request(app).post('/api/auth/login').send({ email: businessCreds.email, password: businessCreds.password }); expect(res.statusCode).toBe(200); businessToken = res.body.accessToken || res.body.token; businessRefresh = res.body.refreshToken; expect(businessToken).toBeTruthy(); expect(businessRefresh).toBeTruthy(); });
        test('protected route rejects without token (401)', async () => { const res = await request(app).get('/api/business/me'); expect(res.statusCode).toBe(401); });
        test('protected route accepts valid token', async () => { const res = await request(app).get('/api/notifications').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); });
        test('refresh token rotates successfully', async () => { const res = await request(app).post('/api/auth/refresh').send({ refreshToken: customerRefresh }); expect(res.statusCode).toBe(200); expect(res.body.accessToken || res.body.token).toBeTruthy(); });
    });

    describe('2. Business Flow', () => {
        test('register a business profile', async () => { const res = await request(app).post('/api/business/register').set(authHeader(businessToken)).send({ businessName: 'Test Restaurant', category: 'FOOD_BEVERAGE', description: 'E2E test restaurant', country: 'Ghana' }); expect(res.statusCode).toBe(201); expect(res.body.success).toBe(true); const profile = res.body.businessProfile || res.body.business; expect(profile).toBeTruthy(); businessProfileId = profile.id; bizId = profile.bizId; });
        test('get own business profile', async () => { const res = await request(app).get('/api/business/me').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); const profile = res.body.businessProfile || res.body.business; expect(profile.id).toBe(businessProfileId); });
        test('create a product', async () => { const res = await request(app).post('/api/business/products').set(authHeader(businessToken)).send({ name: 'Jollof Rice', description: 'Special jollof', priceUsdc: 15.0, category: 'FOOD_BEVERAGE' }); expect(res.statusCode).toBe(201); expect(res.body.success).toBe(true); productId = res.body.product?.id || res.body.id; expect(productId).toBeTruthy(); });
        test('list own products', async () => { const res = await request(app).get('/api/business/products').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); const products = res.body.products || res.body.data || []; expect(products.length).toBeGreaterThanOrEqual(1); });
        test('public search finds the business', async () => { const res = await request(app).get('/api/business/search?category=FOOD_BEVERAGE'); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); });
    });

    describe('3. Reservation Flow', () => {
        test('customer creates a reservation', async () => { const start = new Date(Date.now() + 86400000); const end = new Date(start.getTime() + 7200000); const res = await request(app).post('/api/reservations').set(authHeader(customerToken)).send({ bizId, startDatetime: start.toISOString(), endDatetime: end.toISOString(), partySize: 4, amountUsdc: 50.0, customerNotes: 'E2E test reservation' }); expect(res.statusCode).toBe(201); expect(res.body.success).toBe(true); reservationId = res.body.reservation.id; expect(reservationId).toBeTruthy(); });
        test('customer lists their reservations', async () => { const res = await request(app).get('/api/reservations/me').set(authHeader(customerToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); const reservations = res.body.reservations || res.body.data || []; expect(reservations.length).toBeGreaterThanOrEqual(1); });
        test('business confirms the reservation', async () => { const res = await request(app).patch(`/api/reservations/${reservationId}/confirm`).set(authHeader(businessToken)).send({ businessNotes: 'Confirmed for 4' }); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); expect(res.body.reservation.status).toBe('CONFIRMED'); });
        test('customer cancels the reservation', async () => { const res = await request(app).patch(`/api/reservations/${reservationId}/cancel`).set(authHeader(customerToken)); expect([200, 400, 409]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
    });

    describe('4. Security & Session Management', () => {
        test('list active sessions', async () => { const res = await request(app).get('/api/security/sessions').set(authHeader(customerToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); expect(Array.isArray(res.body.sessions)).toBe(true); });
        test('set a PIN', async () => { const res = await request(app).post('/api/security/pin/set').set(authHeader(customerToken)).send({ pin: '1234' }); expect([200, 201, 400]).toContain(res.statusCode); });
        test('data export returns user data', async () => { const res = await request(app).get('/api/security/data-export').set(authHeader(customerToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); expect(res.body.data).toBeTruthy(); expect(res.body.data.user).toBeTruthy(); });
    });

    describe('5. Wallet Flow', () => {
        test('list withdrawal history', async () => { const res = await request(app).get('/api/wallet/history').set(authHeader(customerToken)); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
        test('get finance transactions', async () => { const res = await request(app).get('/api/finance/transactions').set(authHeader(customerToken)); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
    });
    describe('6. Savings / Vault Flow', () => {
        test('get savings overview', async () => { const res = await request(app).get('/api/savings/overview').set(authHeader(customerToken)); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
        test('list vaults', async () => { const res = await request(app).get('/api/vaults').set(authHeader(customerToken)); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
    });
    describe('7. Marketplace Flow (public)', () => {
        test('discover storefronts', async () => { const res = await request(app).get('/api/storefront/discover'); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
        test('list storefront themes (public)', async () => { const res = await request(app).get('/api/storefront/themes'); expect([200, 404]).toContain(res.statusCode); if (res.statusCode === 200) expect(res.body.success).toBe(true); });
    });
    describe('8. Order Flow (business → customer)', () => {
        test('business lists own orders (empty OK)', async () => { const res = await request(app).get('/api/business/orders').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); });
        test('business gets order stats', async () => { const res = await request(app).get('/api/business/orders/stats').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); });
    });
    describe('9. Notifications Flow', () => {
        test('list business notifications', async () => { const res = await request(app).get('/api/business/notifications').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); });
        test('get unread count', async () => { const res = await request(app).get('/api/business/notifications/unread-count').set(authHeader(businessToken)); expect(res.statusCode).toBe(200); expect(res.body.success).toBe(true); });
    });
    describe('10. Health Check', () => {
        test('GET /health returns 200', async () => { const res = await request(app).get('/health'); expect(res.statusCode).toBe(200); });
        test('GET /api/public returns 200', async () => { const res = await request(app).get('/api/public'); expect([200, 404]).toContain(res.statusCode); });
    });
});
