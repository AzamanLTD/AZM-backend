#!/usr/bin/env node
// scripts/generate-tatum-wallet.js
// =============================================================================
// AZAMAN PHASE C — TATUM POLYGON HD WALLET GENERATOR
//
// Standalone script that calls the Tatum REST API to generate a new Polygon
// HD wallet. Prints the xpub and mnemonic (seed phrase) to the console so
// the operator can save them offline in a secure vault.
//
// Usage:
//   TATUM_API_KEY=<your-key> node scripts/generate-tatum-wallet.js
//
// Environment:
//   TATUM_API_KEY  (required) — Your Tatum platform API key
//   TATUM_BASE_URL (optional) — Override base URL (default: https://api.tatum.io/v3)
//
// Output:
//   {
//     "xpub": "xpub6...",
//     "mnemonic": "word1 word2 ... word24"
//   }
//
// IMPORTANT: The mnemonic grants full control over all derived addresses.
//   • Store it OFFLINE in a hardware vault or encrypted cold storage.
//   • NEVER commit it to source control or expose it in logs.
//   • The xpub is safe to store in environment variables (read-only derivation).
// =============================================================================

const axios = require('axios');

const TATUM_API_KEY  = process.env.TATUM_API_KEY;
const TATUM_BASE_URL = process.env.TATUM_BASE_URL || 'https://api.tatum.io/v3';

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  AZAMAN — Tatum Polygon HD Wallet Generator');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    if (!TATUM_API_KEY) {
        console.error('❌ ERROR: TATUM_API_KEY environment variable is not set.');
        console.error('');
        console.error('   Usage:');
        console.error('     TATUM_API_KEY=<your-key> node scripts/generate-tatum-wallet.js');
        console.error('');
        process.exit(1);
    }

    console.log(`🔑 API Key: ${TATUM_API_KEY.slice(0, 8)}...${TATUM_API_KEY.slice(-4)}`);
    console.log(`🌐 Endpoint: GET ${TATUM_BASE_URL}/polygon/wallet`);
    console.log('');
    console.log('⏳ Generating Polygon HD wallet...');
    console.log('');

    try {
        const response = await axios.get(`${TATUM_BASE_URL}/polygon/wallet`, {
            headers: {
                'x-api-key': TATUM_API_KEY
            },
            timeout: 15000
        });

        const { xpub, mnemonic } = response.data;

        if (!xpub || !mnemonic) {
            console.error('❌ ERROR: Unexpected API response shape:');
            console.error(JSON.stringify(response.data, null, 2));
            process.exit(1);
        }

        console.log('✅ Polygon HD Wallet Generated Successfully!');
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  XPUB (safe for .env — use as TATUM_XPUB):');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log(xpub);
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  MNEMONIC (⚠️  STORE OFFLINE — NEVER COMMIT TO GIT):');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log(mnemonic);
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
        console.log('📋 Next Steps:');
        console.log('   1. Copy the XPUB above into your .env as TATUM_XPUB=<value>');
        console.log('   2. Store the MNEMONIC in a hardware vault / encrypted offline backup.');
        console.log('   3. Set TATUM_PROVIDER=LIVE in your .env to activate live derivation.');
        console.log('   4. Set TATUM_WEBHOOK_SECRET to a random 32+ char string for HMAC.');
        console.log('   5. Set TATUM_WEBHOOK_URL to your public endpoint:');
        console.log('      https://your-domain.com/api/finance/webhook/tatum');
        console.log('');

        // Also output as JSON for scripted consumption
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('  JSON (for automated tooling):');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(JSON.stringify({ xpub, mnemonic }, null, 2));
        console.log('');

    } catch (error) {
        const apiMessage = error.response?.data?.message || error.response?.data || error.message;
        const statusCode = error.response?.status || 'N/A';

        console.error('❌ ERROR: Tatum API call failed.');
        console.error(`   Status: ${statusCode}`);
        console.error(`   Message: ${apiMessage}`);
        console.error('');

        if (statusCode === 401 || statusCode === 403) {
            console.error('   → Your TATUM_API_KEY may be invalid or expired.');
        } else if (statusCode === 429) {
            console.error('   → Rate limited. Wait a moment and try again.');
        }

        process.exit(1);
    }
}

main();
