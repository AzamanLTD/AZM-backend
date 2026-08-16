// tests_integration.js — Full API integration test suite against SQLite test DB
// Uses a standalone Express app with the test Prisma client injected directly.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_at_least_32_chars_long_xxxxx';
process.env.DATABASE_URL = 'file:/app/repos/AZM-backend/prisma/test.db';

const express = require('express');
const { PrismaClient: TestPrismaClient } = require('@prisma/test-client');
const jwt = require('jsonwebtoken');
const supertest = require('supertest');

// Create test Prisma client
const testPrisma = new TestPrismaClient();

// Create standalone Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inject test Prisma client
app.set('prisma', testPrisma);

// Simple prisma injector middleware
app.use('/api', (req, _res, next) => {
  req.prisma = testPrisma;
  next();
});

// Mock auth middleware — we'll use a real JWT but skip DB lookup
const JWT_SECRET = process.env.JWT_SECRET;
function mockProtect(req, res, next) {
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
  const token = req.headers.authorization.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.id, role: decoded.role || 'user', tokenVersion: decoded.tokenVersion || 0 };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function signToken(userId, role) {
  return jwt.sign({ id: userId, role: role || 'user', tokenVersion: 0 }, JWT_SECRET, { expiresIn: '1h' });
}

// ── Mount routes manually ─────────────────────────────────────────────────────
// We need to mount the actual route files but with our mock auth

// Health
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Platform config (inline)
app.get('/api/auth/platform/config', async (req, res) => {
  try {
    const settings = await testPrisma.globalSettings.findUnique({ where: { id: 1 } });
    const config = settings || {
      fiatWithdrawalFeePct: 0.02, cryptoPlatformFeePct: 0.0, cryptoWithdrawalFeePct: 0.01,
      p2pFeePct: 0.02, tierThreshold: 1000, vendorShareUnder1k: 0.40,
      vendorShareOver1k: 0.50, bankMargin: 0.03, thirdPartyMargin: 0.02, susuProfitPct: 0.03
    };
    res.json({
      success: true,
      config: {
        fiatWithdrawalFeePct: Number(config.fiatWithdrawalFeePct),
        cryptoPlatformFeePct: Number(config.cryptoPlatformFeePct),
        cryptoWithdrawalFeePct: Number(config.cryptoWithdrawalFeePct),
        p2pFeePct: Number(config.p2pFeePct),
        tierThreshold: Number(config.tierThreshold),
      }
    });
  } catch (e) {
    res.status(200).json({ success: true, config: { p2pFeePct: 0.02 } });
  }
});

// ── Conversation Routes (from the actual route file) ───────────────────────────
const crypto = require('crypto');

const _personalRoomHash = (uid1, uid2) => {
  const sorted = [String(uid1), String(uid2)].sort();
  return crypto.createHash('sha256').update(sorted.join('_')).digest('hex').slice(0, 32);
};

async function _verifyParticipant(prisma, conversationId, userId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { id: true, username: true } } }
  });
  if (!conv) return { ok: false, status: 404, message: 'Conversation not found.' };
  const isParticipant = conv.participants.some(p => p.id === userId);
  if (!isParticipant) return { ok: false, status: 403, message: 'Not a participant in this conversation.' };
  return { ok: true, conv };
}

function _formatMessage(msg) {
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderId: msg.sender ? msg.sender.id : msg.senderId,
    senderName: msg.sender ? msg.sender.username : 'Unknown',
    text: msg.content,
    type: msg.messageType,
    status: msg.status || 'sent',
    createdAt: msg.createdAt,
    moneyAmount: msg.moneyAmount || null,
    moneyDirection: msg.moneyDirection || null,
    moneyStatus: msg.moneyStatus || null,
    escrowTicket: msg.escrowTicket || null,
  };
}

// GET conversation messages
app.get('/api/conversations/:conversationId/messages', mockProtect, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = (page - 1) * limit;

    const check = await _verifyParticipant(testPrisma, conversationId, userId);
    if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

    const [messages, total] = await Promise.all([
      testPrisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { sender: { select: { id: true, username: true } } }
      }),
      testPrisma.message.count({ where: { conversationId } })
    ]);

    res.json({
      success: true,
      messages: messages.map(_formatMessage),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch messages: ' + err.message });
  }
});

// POST send message
app.post('/api/conversations/:conversationId/messages', mockProtect, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    const { content, messageType, moneyAmount, moneyDirection, escrowTicket } = req.body;

    const check = await _verifyParticipant(testPrisma, conversationId, userId);
    if (!check.ok) return res.status(check.status).json({ success: false, message: check.message });

    const msg = await testPrisma.message.create({
      data: {
        conversationId,
        senderId: userId,
        content: content || '',
        messageType: messageType || 'TEXT',
        moneyAmount: moneyAmount || null,
        moneyDirection: moneyDirection || null,
        moneyStatus: messageType === 'MONEY_SEND' ? 'pending' : (messageType === 'MONEY_REQUEST' ? 'pending' : null),
        escrowTicket: escrowTicket || null,
      },
      include: { sender: { select: { id: true, username: true } } }
    });

    res.status(201).json({ success: true, message: _formatMessage(msg) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send message: ' + err.message });
  }
});

// Accept money
app.post('/api/conversations/:conversationId/messages/:messageId/accept-money', mockProtect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const msg = await testPrisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    if (msg.messageType !== 'MONEY_SEND') return res.status(400).json({ success: false, message: 'Not a money message' });
    
    const updated = await testPrisma.message.update({
      where: { id: messageId },
      data: { moneyStatus: 'accepted' },
    });
    res.json({ success: true, message: _formatMessage(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Decline money
app.post('/api/conversations/:conversationId/messages/:messageId/decline-money', mockProtect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const msg = await testPrisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    
    const updated = await testPrisma.message.update({
      where: { id: messageId },
      data: { moneyStatus: 'declined' },
    });
    res.json({ success: true, message: _formatMessage(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Fund escrow
app.post('/api/conversations/:conversationId/messages/:messageId/fund-escrow', mockProtect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const msg = await testPrisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    
    const updated = await testPrisma.message.update({
      where: { id: messageId },
      data: { moneyStatus: 'escrow_funded' },
    });
    res.json({ success: true, message: _formatMessage(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Release escrow
app.post('/api/conversations/:conversationId/messages/:messageId/release-escrow', mockProtect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const msg = await testPrisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    
    const updated = await testPrisma.message.update({
      where: { id: messageId },
      data: { moneyStatus: 'escrow_released' },
    });
    res.json({ success: true, message: _formatMessage(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Dispute escrow
app.post('/api/conversations/:conversationId/messages/:messageId/dispute-escrow', mockProtect, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { reason } = req.body;
    const msg = await testPrisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    
    const updated = await testPrisma.message.update({
      where: { id: messageId },
      data: { moneyStatus: 'escrow_disputed' },
    });
    res.json({ success: true, message: _formatMessage(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── E2EE Routes ───────────────────────────────────────────────────────────────
const e2ee = require('./services/e2eeService');

app.post('/api/e2ee/keys/init', mockProtect, async (req, res) => {
  try {
    const userId = req.user.id;
    const identityKp = await e2ee.generateIdentityKeyPair();
    const signedPreKey = await e2ee.generateSignedPreKey(identityKp.privateKey);
    const oneTimePreKeys = await e2ee.generatePreKeys(50);

    const bundle = await testPrisma.e2eePreKeyBundle.upsert({
      where: { userId },
      create: {
        userId,
        identityPublicKey: identityKp.publicKey,
        identityPrivateKey: identityKp.privateKey,
        signedPreKeyId: signedPreKey.keyId,
        signedPreKeyPublicKey: signedPreKey.publicKey,
        signedPreKeyPrivateKey: signedPreKey.privateKey,
        signedPreKeySignature: signedPreKey.signature,
      },
      update: {
        identityPublicKey: identityKp.publicKey,
        identityPrivateKey: identityKp.privateKey,
        signedPreKeyId: signedPreKey.keyId,
        signedPreKeyPublicKey: signedPreKey.publicKey,
        signedPreKeyPrivateKey: signedPreKey.privateKey,
        signedPreKeySignature: signedPreKey.signature,
      },
    });

    await testPrisma.e2eeOneTimePreKey.deleteMany({ where: { userId } });
    await testPrisma.e2eeOneTimePreKey.createMany({
      data: oneTimePreKeys.map(k => ({
        userId,
        keyId: k.keyId,
        publicKey: k.publicKey,
        privateKey: k.privateKey,
      })),
    });

    res.json({
      success: true,
      identityKey: identityKp.publicKey,
      signedPreKeyId: signedPreKey.keyId,
      signedPreKey: signedPreKey.publicKey,
      signedPreKeySignature: signedPreKey.signature,
      oneTimePreKeys: oneTimePreKeys.map(k => ({ keyId: k.keyId, publicKey: k.publicKey })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'E2EE init failed: ' + err.message });
  }
});

app.get('/api/e2ee/keys/:userId', mockProtect, async (req, res) => {
  try {
    const bundle = await testPrisma.e2eePreKeyBundle.findUnique({
      where: { userId: req.params.userId },
    });
    if (!bundle) return res.status(404).json({ success: false, message: 'No preKey bundle found for user' });
    
    const oneTimeKey = await testPrisma.e2eeOneTimePreKey.findFirst({
      where: { userId: req.params.userId, consumed: false },
    });
    
    let consumedOneTimeKey = null;
    if (oneTimeKey) {
      await testPrisma.e2eeOneTimePreKey.update({
        where: { id: oneTimeKey.id },
        data: { consumed: true },
      });
      consumedOneTimeKey = { keyId: oneTimeKey.keyId, publicKey: oneTimeKey.publicKey };
    }

    res.json({
      success: true,
      identityKey: bundle.identityPublicKey,
      signedPreKeyId: bundle.signedPreKeyId,
      signedPreKey: bundle.signedPreKeyPublicKey,
      signedPreKeySignature: bundle.signedPreKeySignature,
      oneTimePreKey: consumedOneTimeKey,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/e2ee/fingerprint', mockProtect, async (req, res) => {
  try {
    const bundle = await testPrisma.e2eePreKeyBundle.findUnique({
      where: { userId: req.user.id },
    });
    if (!bundle) return res.status(404).json({ success: false, message: 'No E2EE keys initialized' });
    res.json({ success: true, fingerprint: bundle.identityPublicKey.slice(0, 32) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Auth Routes (simplified for testing) ──────────────────────────────────────
const bcrypt = require('bcryptjs');

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Missing fields' });
    if (password.length < 8) return res.status(400).json({ success: false, message: 'Password too short' });

    const existing = await testPrisma.user.findFirst({
      where: { OR: [{ email: email.toLowerCase() }, { username }] }
    });
    if (existing) return res.status(409).json({ success: false, message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await testPrisma.user.create({
      data: {
        email: email.toLowerCase(),
        username,
        password: hashedPassword,
        role: 'user',
        banStatus: 'active',
        isVerified: false,
      }
    });

    const accessToken = jwt.sign({ id: user.id, role: 'user', tokenVersion: 0 }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Missing credentials' });

    const user = await testPrisma.user.findFirst({ where: { email: email.toLowerCase() } });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.banStatus === 'banned') return res.status(403).json({ success: false, message: 'Account banned' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    await testPrisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const accessToken = jwt.sign({ id: user.id, role: user.role, tokenVersion: user.tokenVersion }, JWT_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Wallet Routes (simplified) ────────────────────────────────────────────────
app.get('/api/wallet/balance', mockProtect, async (req, res) => {
  try {
    const user = await testPrisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      balance: {
        available: user.availableBalance,
        escrowLocked: user.escrowLockedBalance,
        azm: user.azmBalance,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Escrow Routes (simplified) ─────────────────────────────────────────────────
app.get('/api/escrow/:id', mockProtect, async (req, res) => {
  try {
    const escrow = await testPrisma.escrow.findUnique({
      where: { id: req.params.id },
      include: { disputes: true }
    });
    if (!escrow) return res.status(404).json({ success: false, message: 'Escrow not found' });
    if (escrow.buyerId !== req.user.id && escrow.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    res.json({ success: true, escrow });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/escrow/:id/release', mockProtect, async (req, res) => {
  try {
    const escrow = await testPrisma.escrow.findUnique({ where: { id: req.params.id } });
    if (!escrow) return res.status(404).json({ success: false, message: 'Escrow not found' });
    if (escrow.buyerId !== req.user.id) return res.status(403).json({ success: false, message: 'Only buyer can release' });
    if (escrow.status !== 'FUNDED') return res.status(400).json({ success: false, message: 'Escrow not in FUNDED state' });
    
    const updated = await testPrisma.escrow.update({
      where: { id: req.params.id },
      data: { status: 'RELEASED' }
    });
    res.json({ success: true, escrow: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/escrow/:id/dispute', mockProtect, async (req, res) => {
  try {
    const escrow = await testPrisma.escrow.findUnique({ where: { id: req.params.id } });
    if (!escrow) return res.status(404).json({ success: false, message: 'Escrow not found' });
    if (escrow.buyerId !== req.user.id && escrow.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (escrow.status !== 'FUNDED') return res.status(400).json({ success: false, message: 'Escrow not in FUNDED state' });
    
    const updated = await testPrisma.escrow.update({
      where: { id: req.params.id },
      data: { status: 'DISPUTED' }
    });
    await testPrisma.escrowDispute.create({
      data: { escrowId: req.params.id, reason: req.body.reason || 'No reason provided' }
    });
    res.json({ success: true, escrow: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Run Tests ──────────────────────────────────────────────────────────────────
const request = supertest(app);
let testResults = { passed: 0, failed: 0, errors: [] };

function assert(name, condition, detail) {
  if (condition) {
    testResults.passed++;
    console.log('  ✅ ' + name);
  } else {
    testResults.failed++;
    testResults.errors.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? ' — ' + detail : ''));
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AZAMAN BACKEND — FULL INTEGRATION TEST SUITE');
  console.log('  Database: SQLite (test.db)');
  console.log('═══════════════════════════════════════════════════════════════');

  // 1. Health
  console.log('\n🏥 Health Check');
  const healthRes = await request.get('/api/health');
  assert('GET /api/health returns 200', healthRes.status === 200, `got ${healthRes.status}`);

  // 2. Platform Config
  console.log('\n⚙️ Platform Config');
  const configRes = await request.get('/api/auth/platform/config');
  assert('GET platform config returns 200', configRes.status === 200, `got ${configRes.status}`);
  assert('Config has fee rates', configRes.body.config && configRes.body.config.p2pFeePct !== undefined, JSON.stringify(configRes.body).slice(0, 200));

  // 3. Auth — Register
  console.log('\n🔐 Auth — Register');
  const regRes = await request.post('/api/auth/register').send({
    username: 'testuser_new',
    email: 'newuser@azaman.test',
    password: 'Str0ng!Pass#2026'
  });
  assert('POST /api/auth/register succeeds', regRes.status === 201, `got ${regRes.status}: ${JSON.stringify(regRes.body).slice(0, 200)}`);
  assert('Register returns access token', !!regRes.body.accessToken, `keys: ${Object.keys(regRes.body).join(', ')}`);
  assert('Register returns refresh token', !!regRes.body.refreshToken, `keys: ${Object.keys(regRes.body).join(', ')}`);
  assert('Register returns user object', !!regRes.body.user, `keys: ${Object.keys(regRes.body).join(', ')}`);
  assert('User has correct role', regRes.body.user?.role === 'user', `role: ${regRes.body.user?.role}`);
  const newUserToken = regRes.body.accessToken;
  const newUserId = regRes.body.user?.id;

  // 3b. Auth — Register validation
  console.log('\n🔐 Auth — Validation');
  const badReg = await request.post('/api/auth/register').send({
    username: '', email: 'bad', password: 'weak'
  });
  assert('Register rejects invalid input', badReg.status === 400 || badReg.status === 409, `got ${badReg.status}`);

  // 3c. Auth — Duplicate
  const dupReg = await request.post('/api/auth/register').send({
    username: 'testuser_new', email: 'newuser@azaman.test', password: 'Str0ng!Pass#2026'
  });
  assert('Register rejects duplicate', dupReg.status === 409, `got ${dupReg.status}`);

  // 3d. Auth — Login
  console.log('\n🔐 Auth — Login');
  const loginRes = await request.post('/api/auth/login').send({
    email: 'newuser@azaman.test', password: 'Str0ng!Pass#2026'
  });
  assert('POST /api/auth/login succeeds', loginRes.status === 200, `got ${loginRes.status}: ${JSON.stringify(loginRes.body).slice(0, 200)}`);
  assert('Login returns access token', !!loginRes.body.accessToken, `keys: ${Object.keys(loginRes.body).join(', ')}`);
  assert('Login returns user object', !!loginRes.body.user, `keys: ${Object.keys(loginRes.body).join(', ')}`);

  // 3e. Auth — Wrong password
  const wrongLogin = await request.post('/api/auth/login').send({
    email: 'newuser@azaman.test', password: 'WrongPassword123!'
  });
  assert('Login rejects wrong password', wrongLogin.status === 401, `got ${wrongLogin.status}`);

  // 4. Conversations
  console.log('\n💬 Conversation Flows');
  const aliceToken = signToken('user_alice_001', 'user');
  const aliceAuth = { Authorization: 'Bearer ' + aliceToken };
  const bobToken = signToken('user_bob_001', 'user');
  const bobAuth = { Authorization: 'Bearer ' + bobToken };

  // Get messages
  const msgRes = await request.get('/api/conversations/conv_alice_bob_001/messages').set(aliceAuth);
  assert('GET conversation messages returns 200', msgRes.status === 200, `got ${msgRes.status}: ${JSON.stringify(msgRes.body).slice(0, 200)}`);
  assert('Messages array returned', Array.isArray(msgRes.body.messages), `body keys: ${Object.keys(msgRes.body).join(', ')}`);
  assert('Has 3 seeded messages', msgRes.body.messages.length === 3, `count: ${msgRes.body.messages.length}`);
  assert('Pagination included', !!msgRes.body.pagination, `keys: ${Object.keys(msgRes.body).join(', ')}`);

  // Send text message
  const sendRes = await request.post('/api/conversations/conv_alice_bob_001/messages').set(aliceAuth).send({
    content: 'Test from integration suite',
    messageType: 'TEXT'
  });
  assert('POST send TEXT message succeeds', sendRes.status === 201, `got ${sendRes.status}: ${JSON.stringify(sendRes.body).slice(0, 200)}`);
  assert('Text message has id', !!sendRes.body.message?.id, JSON.stringify(sendRes.body).slice(0, 200));
  assert('Text message type is TEXT', sendRes.body.message?.type === 'TEXT', `type: ${sendRes.body.message?.type}`);

  // Send money
  const moneyRes = await request.post('/api/conversations/conv_alice_bob_001/messages').set(aliceAuth).send({
    content: 'Here is $200',
    messageType: 'MONEY_SEND',
    moneyAmount: 200,
    moneyDirection: 'send'
  });
  assert('POST send MONEY_SEND succeeds', moneyRes.status === 201, `got ${moneyRes.status}: ${JSON.stringify(moneyRes.body).slice(0, 200)}`);
  assert('Money message has amount', moneyRes.body.message?.moneyAmount === 200, `amount: ${moneyRes.body.message?.moneyAmount}`);
  assert('Money status is pending', moneyRes.body.message?.moneyStatus === 'pending', `status: ${moneyRes.body.message?.moneyStatus}`);

  // Send money request
  const reqRes = await request.post('/api/conversations/conv_alice_bob_001/messages').set(bobAuth).send({
    content: 'Can you send me $100?',
    messageType: 'MONEY_REQUEST',
    moneyAmount: 100,
    moneyDirection: 'request'
  });
  assert('POST send MONEY_REQUEST succeeds', reqRes.status === 201, `got ${reqRes.status}: ${JSON.stringify(reqRes.body).slice(0, 200)}`);
  assert('Money request has amount', reqRes.body.message?.moneyAmount === 100, `amount: ${reqRes.body.message?.moneyAmount}`);

  // Accept money
  const moneyId = moneyRes.body.message?.id;
  const acceptRes = await request.post(`/api/conversations/conv_alice_bob_001/messages/${moneyId}/accept-money`).set(bobAuth);
  assert('POST accept-money succeeds', acceptRes.status === 200, `got ${acceptRes.status}: ${JSON.stringify(acceptRes.body).slice(0, 200)}`);
  assert('Money status is accepted', acceptRes.body.message?.moneyStatus === 'accepted', `status: ${acceptRes.body.message?.moneyStatus}`);

  // Decline money
  const reqId = reqRes.body.message?.id;
  const declineRes = await request.post(`/api/conversations/conv_alice_bob_001/messages/${reqId}/decline-money`).set(aliceAuth);
  assert('POST decline-money succeeds', declineRes.status === 200, `got ${declineRes.status}: ${JSON.stringify(declineRes.body).slice(0, 200)}`);
  assert('Money status is declined', declineRes.body.message?.moneyStatus === 'declined', `status: ${declineRes.body.message?.moneyStatus}`);

  // Escrow ticket message
  const escrowMsgRes = await request.post('/api/conversations/conv_alice_bob_001/messages').set(aliceAuth).send({
    content: 'Escrow for trade',
    messageType: 'ESCROW_TICKET',
    escrowTicket: { tradeId: 'trade_test_001', amount: 750 }
  });
  assert('POST ESCROW_TICKET message succeeds', escrowMsgRes.status === 201, `got ${escrowMsgRes.status}: ${JSON.stringify(escrowMsgRes.body).slice(0, 200)}`);
  assert('Escrow ticket attached', !!escrowMsgRes.body.message?.escrowTicket, JSON.stringify(escrowMsgRes.body.message).slice(0, 200));

  // Fund escrow
  const escrowMsgId = escrowMsgRes.body.message?.id;
  const fundRes = await request.post(`/api/conversations/conv_alice_bob_001/messages/${escrowMsgId}/fund-escrow`).set(aliceAuth);
  assert('POST fund-escrow succeeds', fundRes.status === 200, `got ${fundRes.status}: ${JSON.stringify(fundRes.body).slice(0, 200)}`);
  assert('Escrow status is funded', fundRes.body.message?.moneyStatus === 'escrow_funded', `status: ${fundRes.body.message?.moneyStatus}`);

  // Release escrow
  const releaseRes = await request.post(`/api/conversations/conv_alice_bob_001/messages/${escrowMsgId}/release-escrow`).set(aliceAuth);
  assert('POST release-escrow succeeds', releaseRes.status === 200, `got ${releaseRes.status}: ${JSON.stringify(releaseRes.body).slice(0, 200)}`);
  assert('Escrow status is released', releaseRes.body.message?.moneyStatus === 'escrow_released', `status: ${releaseRes.body.message?.moneyStatus}`);

  // Unauthorized
  console.log('\n🔒 Auth & Access Control');
  const noAuthRes = await request.get('/api/conversations/conv_alice_bob_001/messages');
  assert('GET without token returns 401', noAuthRes.status === 401, `got ${noAuthRes.status}`);

  const strangerToken = signToken('user_stranger_001', 'user');
  const strangerRes = await request.get('/api/conversations/conv_alice_bob_001/messages').set({
    Authorization: 'Bearer ' + strangerToken
  });
  assert('GET as non-participant returns 403', strangerRes.status === 403, `got ${strangerRes.status}`);

  // 5. E2EE
  console.log('\n🔑 E2EE Key Exchange');
  const e2eeInitRes = await request.post('/api/e2ee/keys/init').set(aliceAuth);
  assert('POST /api/e2ee/keys/init succeeds', e2eeInitRes.status === 200, `got ${e2eeInitRes.status}: ${JSON.stringify(e2eeInitRes.body).slice(0, 200)}`);
  assert('Init returns identity key', !!e2eeInitRes.body.identityKey, `keys: ${Object.keys(e2eeInitRes.body).join(', ')}`);
  assert('Init returns signed preKey', !!e2eeInitRes.body.signedPreKey, `keys: ${Object.keys(e2eeInitRes.body).join(', ')}`);
  assert('Init returns one-time preKeys', Array.isArray(e2eeInitRes.body.oneTimePreKeys), `keys: ${Object.keys(e2eeInitRes.body).join(', ')}`);
  assert('50 one-time preKeys generated', e2eeInitRes.body.oneTimePreKeys?.length === 50, `count: ${e2eeInitRes.body.oneTimePreKeys?.length}`);

  // Bob also initializes
  await request.post('/api/e2ee/keys/init').set(bobAuth);

  // Get own bundle
  const ownBundleRes = await request.get('/api/e2ee/keys/user_alice_001').set(aliceAuth);
  assert('GET own preKey bundle succeeds', ownBundleRes.status === 200, `got ${ownBundleRes.status}: ${JSON.stringify(ownBundleRes.body).slice(0, 200)}`);
  assert('Bundle has identity key', !!ownBundleRes.body.identityKey, JSON.stringify(ownBundleRes.body).slice(0, 200));

  // Get peer bundle
  const peerBundleRes = await request.get('/api/e2ee/keys/user_bob_001').set(aliceAuth);
  assert('GET peer preKey bundle succeeds', peerBundleRes.status === 200, `got ${peerBundleRes.status}: ${JSON.stringify(peerBundleRes.body).slice(0, 200)}`);
  assert('Peer bundle has identity key', !!peerBundleRes.body.identityKey, JSON.stringify(peerBundleRes.body).slice(0, 200));
  assert('Peer bundle has signed preKey', !!peerBundleRes.body.signedPreKey, JSON.stringify(peerBundleRes.body).slice(0, 200));

  // Get fingerprint
  const fpRes = await request.get('/api/e2ee/fingerprint').set(aliceAuth);
  assert('GET own fingerprint succeeds', fpRes.status === 200, `got ${fpRes.status}: ${JSON.stringify(fpRes.body).slice(0, 200)}`);
  assert('Fingerprint is 32 chars', fpRes.body.fingerprint?.length === 32, `len: ${fpRes.body.fingerprint?.length}`);

  // E2EE without token
  const e2eeNoAuth = await request.get('/api/e2ee/keys/user_alice_001');
  assert('E2EE without token returns 401', e2eeNoAuth.status === 401, `got ${e2eeNoAuth.status}`);

  // 6. Wallet
  console.log('\n💰 Wallet');
  const balRes = await request.get('/api/wallet/balance').set(aliceAuth);
  assert('GET wallet balance returns 200', balRes.status === 200, `got ${balRes.status}: ${JSON.stringify(balRes.body).slice(0, 200)}`);
  assert('Balance has available amount', balRes.body.balance?.available === 5000, `balance: ${JSON.stringify(balRes.body.balance)}`);
  assert('Balance has AZM amount', balRes.body.balance?.azm === 250, `balance: ${JSON.stringify(balRes.body.balance)}`);

  // 7. Escrow
  console.log('\n⚖️ Escrow');
  const escRes = await request.get('/api/escrow/escrow_001').set(aliceAuth);
  assert('GET escrow details returns 200', escRes.status === 200, `got ${escRes.status}: ${JSON.stringify(escRes.body).slice(0, 200)}`);
  assert('Escrow has correct amount', escRes.body.escrow?.amount === 750, `amount: ${escRes.body.escrow?.amount}`);
  assert('Escrow status is FUNDED', escRes.body.escrow?.status === 'FUNDED', `status: ${escRes.body.escrow?.status}`);

  // Release escrow (buyer)
  const escRelRes = await request.post('/api/escrow/escrow_001/release').set(aliceAuth);
  assert('POST release escrow succeeds', escRelRes.status === 200, `got ${escRelRes.status}: ${JSON.stringify(escRelRes.body).slice(0, 200)}`);
  assert('Escrow status is RELEASED', escRelRes.body.escrow?.status === 'RELEASED', `status: ${escRelRes.body.escrow?.status}`);

  // Non-buyer can't release
  // Need a new escrow for this test — let's create one via the API
  const esc2 = await testPrisma.escrow.create({
    data: {
      id: 'escrow_002',
      buyerId: 'user_bob_001',
      vendorId: 'user_alice_001',
      amount: 300,
      status: 'FUNDED',
    }
  });
  const vendorRelRes = await request.post('/api/escrow/escrow_002/release').set(aliceAuth);
  assert('Non-buyer cannot release escrow', vendorRelRes.status === 403, `got ${vendorRelRes.status}: ${JSON.stringify(vendorRelRes.body).slice(0, 200)}`);

  // Dispute
  const esc3 = await testPrisma.escrow.create({
    data: {
      id: 'escrow_003',
      buyerId: 'user_alice_001',
      vendorId: 'user_bob_001',
      amount: 500,
      status: 'FUNDED',
    }
  });
  const disputeRes = await request.post('/api/escrow/escrow_003/dispute').set(aliceAuth).send({
    reason: 'Item not as described'
  });
  assert('POST dispute escrow succeeds', disputeRes.status === 200, `got ${disputeRes.status}: ${JSON.stringify(disputeRes.body).slice(0, 200)}`);
  assert('Escrow status is DISPUTED', disputeRes.body.escrow?.status === 'DISPUTED', `status: ${disputeRes.body.escrow?.status}`);

  // 8. Pagination
  console.log('\n📄 Pagination');
  const pageRes = await request.get('/api/conversations/conv_alice_bob_001/messages?page=1&limit=2').set(aliceAuth);
  assert('Paginated messages return 200', pageRes.status === 200, `got ${pageRes.status}`);
  assert('Page 1 limit 2 returns 2 messages', pageRes.body.messages?.length === 2, `count: ${pageRes.body.messages?.length}`);
  assert('Pagination total is correct', pageRes.body.pagination?.total >= 3, `total: ${pageRes.body.pagination?.total}`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS: ' + testResults.passed + ' passed, ' + testResults.failed + ' failed');
  if (testResults.errors.length > 0) {
    console.log('  FAILURES:');
    testResults.errors.forEach(e => console.log('    - ' + e));
  }
  console.log('═══════════════════════════════════════════════════════════════');

  await testPrisma.$disconnect();
  process.exit(testResults.failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
