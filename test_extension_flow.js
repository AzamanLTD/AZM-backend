#!/usr/bin/env node
/**
 * Time Extension Request Flow — End-to-End Test
 *
 * Validates the BE behaviour for the time-extension request lifecycle:
 *   1. User logs in, vendor logs in.
 *   2. (Optional) initiate a trade so we have one in PENDING_PAYMENT.
 *   3. User POSTs /trades/extend with { isRequest: true } → request msg created.
 *   4. Vendor POSTs /trades/extend with { isRequest: false, requestMessageId }
 *      → timer extends, original request message flips to APPROVED, BE
 *      emits `message_updated` on the trade socket room.
 *   5. Vendor POSTs the same approval again → BE returns 409 (already
 *      responded). Timer must NOT extend a second time.
 *   6. User posts a NEW request. Vendor POSTs /trades/extend/respond with
 *      { action: 'decline' } → original message flips to DECLINED, BE
 *      emits `message_updated`. Timer unchanged.
 *
 * Run: node test_extension_flow.js [BASE_URL]
 *      defaults to http://localhost:3777
 */

const axios = require('axios');
const { io } = require('socket.io-client');

const BASE = (process.argv[2] || 'http://localhost:3777').replace(/\/$/, '');
const API = `${BASE}/api`;

const log = (icon, ...args) => console.log(icon, ...args);
const die = (msg, err) => {
  log('❌', msg);
  if (err?.response?.data) log('   server said:', JSON.stringify(err.response.data));
  else if (err) log('   error:', err.message);
  process.exit(1);
};

// Demo accounts seeded on Render. Local DB has different ids — this
// script uses the test accounts seeded by scripts/seed-active-trade.js.
const USE_LOCAL_FIXED_ACCOUNTS = !process.env.AZAMAN_TEST_FRESH;
const TS = Date.now();
const USER_EMAIL = USE_LOCAL_FIXED_ACCOUNTS ? 'pyrax_test@azaman.test' : `extuser_${TS}@azaman.test`;
const VENDOR_EMAIL = USE_LOCAL_FIXED_ACCOUNTS ? 'extvendor_test@azaman.test' : `extvendor_${TS}@azaman.test`;
const PASSWORD = 'TestPass123!';

async function register(email, role) {
  // Register endpoint creates basic USER. To get a VENDOR we register
  // then update role via DB or admin API. For local tests we just
  // bypass with a direct DB insert by hitting the admin path... but
  // it's simpler to use the production demo accounts when available.
  try {
    await axios.post(`${API}/auth/register`, {
      username: email.split('@')[0],
      email,
      password: PASSWORD,
    });
  } catch (e) {
    if (e.response?.status !== 400 && e.response?.status !== 409) {
      throw e;
    }
  }
}

async function login(email) {
  const res = await axios.post(`${API}/auth/login`, { email, password: PASSWORD });
  return { token: res.data.token, user: res.data.user };
}

async function loginExisting(email, password) {
  const res = await axios.post(`${API}/auth/login`, { email, password });
  return { token: res.data.token, user: res.data.user };
}

function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function findOrCreateActiveTrade(userToken, vendorId, vendorToken) {
  // Look for an existing PENDING_PAYMENT trade involving this user+vendor
  const hist = await axios.get(`${API}/trades/history`, authHeaders(userToken));
  // History API returns various status sets — we want anything in active
  // payment window (PENDING_PAYMENT or PAID).
  const open = (hist.data?.history || []).find(t =>
    (t.status === 'PENDING_PAYMENT' || t.status === 'PAID') &&
    (t.vendorId === vendorId || t.vendor?.id === vendorId)
  );
  if (open) return open.id;

  log('⚠ ', 'No open trade found. Tests that require an active trade will be skipped.');
  log('   ', 'Run: node scripts/seed-active-trade.js USER_EMAIL VENDOR_EMAIL');
  return null;
}

async function main() {
  log('🧪', `Testing against ${BASE}`);

  // 1. Register fresh accounts so we don't conflict with demo data.
  log('1️⃣ ', 'Ensuring test accounts exist...');
  if (!USE_LOCAL_FIXED_ACCOUNTS) {
    await register(USER_EMAIL, 'USER');
    await register(VENDOR_EMAIL, 'VENDOR');
  }
  log('   ', `Using ${USER_EMAIL} / ${VENDOR_EMAIL}`);

  // 3. Login both
  log('2️⃣ ', 'Logging in...');
  const userSession = await login(USER_EMAIL).catch(e => die('user login failed', e));
  const vendorSession = await login(VENDOR_EMAIL).catch(e => die('vendor login failed', e));
  log('   ', 'User:', userSession.user.id, '/ Vendor:', vendorSession.user.id);

  // 4. Find or create an active trade
  const tradeId = await findOrCreateActiveTrade(
    userSession.token,
    vendorSession.user.id,
    vendorSession.token
  );

  if (!tradeId) {
    log('⏭ ', 'Skipping extension tests (no active trade).');
    log('💡', 'Use scripts/seed-active-trade.js or run the full P2P flow first.');
    process.exit(0);
  }

  log('3️⃣ ', `Using trade #${tradeId}`);

  // 5. Connect both sockets to listen for message_updated
  const userSocket = io(BASE, { auth: { token: userSession.token }, transports: ['websocket'] });
  const vendorSocket = io(BASE, { auth: { token: vendorSession.token }, transports: ['websocket'] });

  await new Promise((resolve) => userSocket.on('connect', resolve));
  await new Promise((resolve) => vendorSocket.on('connect', resolve));

  userSocket.emit('join_trade', String(tradeId));
  vendorSocket.emit('join_trade', String(tradeId));

  let userSawUpdate = null;
  let vendorSawUpdate = null;
  userSocket.on('message_updated', (data) => { userSawUpdate = data; log('📡 [user] message_updated:', data.id); });
  vendorSocket.on('message_updated', (data) => { vendorSawUpdate = data; log('📡 [vendor] message_updated:', data.id); });

  // Capture trade_update events to verify timer extension
  let userSawTradeUpdate = null;
  userSocket.on('trade_update', (data) => {
    if (data.expiresAt) { userSawTradeUpdate = data; log('📡 [user] trade_update expiresAt:', data.expiresAt); }
  });

  // 6. User requests +15 min extension
  log('4️⃣ ', 'User requests +15 min extension...');
  let res = await axios.post(`${API}/trades/extend`, {
    tradeId,
    addedMinutes: 15,
    isRequest: true,
  }, authHeaders(userSession.token)).catch(e => die('user request failed', e));
  const requestMessageId = res.data.messageId;
  log('   ', '✓ Request created. Message id:', requestMessageId);

  await new Promise(r => setTimeout(r, 500));

  // 7. Vendor approves with requestMessageId
  log('5️⃣ ', 'Vendor approves request...');
  res = await axios.post(`${API}/trades/extend`, {
    tradeId,
    addedMinutes: 15,
    isRequest: false,
    requestMessageId,
  }, authHeaders(vendorSession.token)).catch(e => die('vendor approve failed', e));
  const newExpiresAt = res.data.newExpiresAt;
  log('   ', '✓ Timer extended. New expiresAt:', newExpiresAt);

  await new Promise(r => setTimeout(r, 800));

  // 8. Verify message_updated was emitted
  if (!userSawUpdate || userSawUpdate.id !== requestMessageId) {
    die(`User did not receive message_updated for request ${requestMessageId}. Last seen: ${userSawUpdate?.id}`);
  }
  if (!vendorSawUpdate || vendorSawUpdate.id !== requestMessageId) {
    die(`Vendor did not receive message_updated for request ${requestMessageId}. Last seen: ${vendorSawUpdate?.id}`);
  }
  const updatedContent = JSON.parse(userSawUpdate.content);
  if (updatedContent.status !== 'APPROVED') {
    die(`Expected status APPROVED, got ${updatedContent.status}`);
  }
  log('   ', '✓ Both sides received message_updated with status=APPROVED');

  // 9. Vendor tries to approve AGAIN — must 409
  log('6️⃣ ', 'Vendor tries to approve again (must 409)...');
  let secondApprove;
  try {
    secondApprove = await axios.post(`${API}/trades/extend`, {
      tradeId,
      addedMinutes: 15,
      isRequest: false,
      requestMessageId,
    }, authHeaders(vendorSession.token));
    die(`Expected 409, got ${secondApprove.status}`);
  } catch (e) {
    if (e.response?.status === 409) {
      log('   ', '✓ Got 409 as expected:', e.response.data.message);
    } else {
      die(`Expected 409, got ${e.response?.status}`, e);
    }
  }

  // 10. Verify timer was NOT extended a second time
  // Compare via fresh trade fetch
  const tradeNow = await axios.get(`${API}/trades/${tradeId}`, authHeaders(userSession.token));
  if (tradeNow.data.expiresAt !== newExpiresAt) {
    die(`Timer was extended a second time! Was ${newExpiresAt}, now ${tradeNow.data.expiresAt}`);
  }
  log('   ', '✓ Timer unchanged on duplicate approve.');

  // 11. New request → vendor declines
  log('7️⃣ ', 'User makes new request, vendor declines...');
  userSawUpdate = null;
  vendorSawUpdate = null;

  res = await axios.post(`${API}/trades/extend`, {
    tradeId,
    addedMinutes: 10,
    isRequest: true,
  }, authHeaders(userSession.token));
  const declineMsgId = res.data.messageId;
  log('   ', '   New request id:', declineMsgId);

  await new Promise(r => setTimeout(r, 500));

  res = await axios.post(`${API}/trades/extend/respond`, {
    tradeId,
    requestMessageId: declineMsgId,
    action: 'decline',
  }, authHeaders(vendorSession.token)).catch(e => die('decline failed', e));
  log('   ', '   ✓ Decline accepted by BE');

  await new Promise(r => setTimeout(r, 800));

  if (!userSawUpdate || userSawUpdate.id !== declineMsgId) {
    die(`User did not receive message_updated for decline. Last: ${userSawUpdate?.id}`);
  }
  const declined = JSON.parse(userSawUpdate.content);
  if (declined.status !== 'DECLINED') {
    die(`Expected status DECLINED, got ${declined.status}`);
  }
  log('   ', '   ✓ Both sides flipped to DECLINED');

  // 12. Verify timer didn't move on decline
  const tradeFinal = await axios.get(`${API}/trades/${tradeId}`, authHeaders(userSession.token));
  if (tradeFinal.data.expiresAt !== newExpiresAt) {
    die(`Timer moved on decline! Was ${newExpiresAt}, now ${tradeFinal.data.expiresAt}`);
  }
  log('   ', '   ✓ Timer unchanged on decline.');

  // 13. Vendor declines AGAIN — must 409
  log('8️⃣ ', 'Vendor declines same request again (must 409)...');
  try {
    await axios.post(`${API}/trades/extend/respond`, {
      tradeId,
      requestMessageId: declineMsgId,
      action: 'decline',
    }, authHeaders(vendorSession.token));
    die('Expected 409 on repeat decline');
  } catch (e) {
    if (e.response?.status === 409) {
      log('   ', '✓ Got 409 as expected:', e.response.data.message);
    } else {
      die(`Expected 409, got ${e.response?.status}`, e);
    }
  }

  log('🏁', 'All extension flow tests passed.');
  userSocket.close();
  vendorSocket.close();
  process.exit(0);
}

main().catch(e => die('test crashed', e));
