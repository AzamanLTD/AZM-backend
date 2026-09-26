// scripts/testMoolreSandbox.js
// =============================================================================
// Moolre On-Ramp — Sandbox Smoke Test
// Run with: node scripts/testMoolreSandbox.js
//
// Before running:
//   1. Set MOOLRE_PROVIDER=LIVE in your .env
//   2. Set MOOLRE_ENV=sandbox
//   3. Fill in your real Moolre sandbox credentials:
//        MOOLRE_API_USER, MOOLRE_API_KEY, MOOLRE_API_PUBKEY, MOOLRE_ACCOUNT_NUMBER
//   4. Replace TEST_PHONE below with a real sandbox test number from your
//      Moolre sandbox dashboard.
// =============================================================================

require('dotenv').config();
const MoolreCollectionService = require('../services/moolreCollectionService');

const TEST_PHONE   = '0244000001'; // TODO: replace with a real Moolre sandbox test number
const TEST_NETWORK = 'MTN';        // MTN | VODAFONE_CASH | AIRTELTIGO

async function main() {
    console.log('\n[testMoolreSandbox] Starting...');
    const svc = new MoolreCollectionService();
    console.log(`[testMoolreSandbox] Mode: ${svc.providerMode}, Base URL: ${svc.baseUrl}\n`);

    // ── Test 1: validateName ─────────────────────────────────────────────────
    console.log('--- Test 1: validateName ---');
    try {
        const name = await svc.validateName({ payerPhone: TEST_PHONE, network: TEST_NETWORK });
        console.log('validateName result:', name ?? '(no account found)');
    } catch (err) {
        console.error('validateName ERROR:', err.message);
    }

    // ── Test 2: initiatePayment ──────────────────────────────────────────────
    console.log('\n--- Test 2: initiatePayment (GH₵ 1.00) ---');
    const externalRef = 'TEST_' + Date.now();
    try {
        const result = await svc.initiatePayment({
            externalRef,
            amountGhs:  1,
            payerPhone: TEST_PHONE,
            network:    TEST_NETWORK,
        });
        console.log('initiatePayment result:', JSON.stringify(result, null, 2));
        if (result.requiresOtp) {
            console.log('→ Network requires OTP. Use the /otp endpoint to confirm.');
        } else if (result.providerRef) {
            console.log(`→ PIN-push sent. providerRef: ${result.providerRef}`);
        }
    } catch (err) {
        if (err.isDuplicate) {
            console.error('initiatePayment ERROR: Duplicate reference (TP13). Change externalRef and retry.');
        } else {
            console.error('initiatePayment ERROR:', err.message, err.code ? `[${err.code}]` : '');
        }
    }

    console.log('\n[testMoolreSandbox] Done.');
}

main().catch(err => {
    console.error('[testMoolreSandbox] Fatal:', err.message);
    process.exit(1);
});
