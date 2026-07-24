// workers/keepAliveWorker.js
// =============================================================================
// AZAMAN V2 — KEEP-ALIVE WORKER
//
// Purpose: Pings external services hosted on Render's free/starter tier that
// would otherwise sleep after ~15 minutes of inactivity. This worker runs on
// the AZM backend (starter plan — never sleeps) and sends HTTP GET requests
// every 5 minutes to keep target services warm.
//
// Current targets:
//   - https://startup.moolre.com/leaderboard/118  (Moolre Startup Cup voting page)
//   - https://startup.moolre.com/                  (Moolre Startup Cup homepage)
//
// To add more targets, append URLs to the PING_URLS array below.
// =============================================================================

const logger = require('../src/config/logger');
const https = require('https');
const url = require('url');

// ── Configuration ───────────────────────────────────────────────────────────
const PING_URLS = [
  'https://startup.moolre.com/leaderboard/118',
  'https://startup.moolre.com/',
];

const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Worker ──────────────────────────────────────────────────────────────────

let intervalId = null;
let lastResults = {};

function ping(targetUrl) {
  return new Promise((resolve) => {
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'AZM-KeepAlive/1.0',
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      // Consume the body to free the socket
      res.resume();
      resolve({ url: targetUrl, status: res.statusCode, ok: res.statusCode < 500 });
    });

    req.on('error', (err) => {
      resolve({ url: targetUrl, status: 0, ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url: targetUrl, status: 0, ok: false, error: 'timeout' });
    });

    req.end();
  });
}

async function pingAll() {
  const timestamp = new Date().toISOString();
  logger.info(`📡 [KeepAlive] Pinging ${PING_URLS.length} target(s) at ${timestamp}`);

  const results = await Promise.all(PING_URLS.map(ping));

  for (const result of results) {
    lastResults[result.url] = { ...result, timestamp };
    if (result.ok) {
      logger.info(`  ✅ ${result.url} → ${result.status}`);
    } else {
      logger.info(`  ❌ ${result.url} → ${result.status} ${result.error || ''}`);
    }
  }
}

module.exports = {
  start() {
    if (intervalId) {
      logger.info('📡 [KeepAlive] Already running');
      return;
    }

    // Ping immediately on startup so the target is warm right away
    pingAll();

    // Schedule recurring pings
    intervalId = setInterval(pingAll, PING_INTERVAL_MS);

    logger.info(`📡 [KeepAlive] Started — pinging ${PING_URLS.length} URL(s) every 5 min`);
    logger.info(`📡 [KeepAlive] Targets: ${PING_URLS.join(', ')}`);
  },

  stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      logger.info('📡 [KeepAlive] Stopped');
    }
  },

  getStatus() {
    return {
      running: !!intervalId,
      intervalMinutes: 5,
      targets: PING_URLS,
      lastResults,
    };
  },
};
