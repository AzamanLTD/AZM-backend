#!/usr/bin/env node
/**
 * Time Extension Flow — Production smoke test using DEMO accounts.
 *
 * Uses pyrax + vendor demo accounts on the live Render backend. Requires
 * an existing PENDING_PAYMENT trade between them. If no such trade
 * exists this script bails out — run the full P2P flow from the app
 * first, OR use the live admin endpoint to seed one.
 *
 * Run: node test_extension_flow_prod.js
 */
const axios = require('axios');
const { io } = require('socket.io-client');

const BASE = 'https://azaman-backend-9d3u.onrender.com';
const API = `${BASE}/api`;

const log = (icon, ...args) => console.log(icon, ...args);
const die = (msg, err) => {
  log('❌', msg);
  if (err?.response?.data) log('   server said:', JSON.stringify(err.response.data));
  else if (err) log('   error:', err.message);
  process.exit(1);
};

const USER_EMAIL = 'pyrax@azaman.com';
const VENDOR_EMAIL = 'vendor@azaman.com';
const PASSWORD = 'password123';

async function login(email) {
  const res = await axios.post(`${API}/auth/login`, { email, password: PASSWORD });
  return { token: res.data.token, user: res.data.user };
}

async function findActiveTrade(userToken, vendorId) {
  const hist = await axios.get(`${API}/trades/history`, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  // Sort newest first; pick first PENDING_PAYMENT or PAID with this vendor.
  const candidates = (hist.data?.history || [])
    .filter(t => (t.status === 'PENDING_PAYMENT' || t.status === 'PAID'))
    .filter(t => t.vendor?.id === vendorId || t.vendorId === vendorId);
  return candidates[0]?.id || null;
}

async function main() {
  log('🧪', `Testing against ${BASE}`);

  log('1️⃣ ', 'Logging in...');
  const userSession = await login(USER_EMAIL).catch(e => die('user login failed', e));
  const vendorSession = await login(VENDOR_EMAIL).catch(e => die('vendor login failed', e));
  log('   ', 'User:', userSession.user.id, '/ Vendor:', vendorSession.user.id);

  const tradeId = await findActiveTrade(userSession.token, vendorSession.user.id);
  if (!tradeId) {
    log('⏭ ', 'No active PENDING_PAYMENT/PAID trade between pyrax and vendor.');
    log('💡', 'Trigger one from the app or admin first, then re-run.');
    process.exit(0);
  }
  log('2️⃣ ', `Using trade #${tradeId}`);

  // Verify GET /trades/:id now returns expiresAt
  const tr = await axios.get(`${API}/trades/${tradeId}`, {
    headers: { Authorization: `Bearer ${userSession.token}` }
  });
  if (!tr.data.expiresAt) {
    die('GET /trades/:id did not return expiresAt — backend may not have the new code yet');
  }
  log('   ', '✓ GET /trades/:id returns expiresAt:', tr.data.expiresAt);

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

  log('3️⃣ ', 'User requests +5 min extension...');
  let res = await axios.post(`${API}/trades/extend`, {
    tradeId,
    addedMinutes: 5,
    isRequest: true,
  }, { headers: { Authorization: `Bearer ${userSession.token}` } }).catch(e => die('user request failed', e));
  const requestMessageId = res.data.messageId;
  log('   ', '✓ Request created. Message id:', requestMessageId);

  await new Promise(r => setTimeout(r, 800));

  log('4️⃣ ', 'Vendor approves request...');
  res = await axios.post(`${API}/trades/extend`, {
    tradeId,
    addedMinutes: 5,
    isRequest: false,
    requestMessageId,
  }, { headers: { Authorization: `Bearer ${vendorSession.token}` } }).catch(e => die('vendor approve failed', e));
  const newExpiresAt = res.data.newExpiresAt;
  log('   ', '✓ Timer extended. New expiresAt:', newExpiresAt);

  await new Promise(r => setTimeout(r, 1500));

  if (!userSawUpdate || userSawUpdate.id !== requestMessageId) {
    die(`User did not receive message_updated for ${requestMessageId}. Last: ${userSawUpdate?.id}`);
  }
  if (!vendorSawUpdate || vendorSawUpdate.id !== requestMessageId) {
    die(`Vendor did not receive message_updated for ${requestMessageId}. Last: ${vendorSawUpdate?.id}`);
  }
  const updated = JSON.parse(userSawUpdate.content);
  if (updated.status !== 'APPROVED') die(`Expected APPROVED, got ${updated.status}`);
  log('   ', '✓ Both sides flipped to APPROVED');

  log('5️⃣ ', 'Vendor tries to approve again (must 409)...');
  try {
    await axios.post(`${API}/trades/extend`, {
      tradeId, addedMinutes: 5, isRequest: false, requestMessageId,
    }, { headers: { Authorization: `Bearer ${vendorSession.token}` } });
    die('Expected 409');
  } catch (e) {
    if (e.response?.status === 409) {
      log('   ', '✓ 409:', e.response.data.message);
    } else {
      die(`Expected 409, got ${e.response?.status}`, e);
    }
  }

  // Verify timer didn't extend twice
  const after = await axios.get(`${API}/trades/${tradeId}`, {
    headers: { Authorization: `Bearer ${userSession.token}` }
  });
  if (after.data.expiresAt !== newExpiresAt) {
    die(`Timer extended twice! Was ${newExpiresAt}, now ${after.data.expiresAt}`);
  }
  log('   ', '✓ Timer unchanged on duplicate approve.');

  log('🏁', 'Production extension flow tests passed.');
  userSocket.close();
  vendorSocket.close();
  process.exit(0);
}

main().catch(e => die('test crashed', e));
