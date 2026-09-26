# Polygon USDC Integration — Admin Setup Guide

## Overview

Azaman uses Polygon (MATIC) network for USDC deposits. Each user gets a unique 
deposit address derived from a master HD wallet. When USDC lands on their address, 
a Tatum webhook fires and credits their Azaman balance automatically.

## Prerequisites

1. **Tatum API Key** — Sign up at https://tatum.io (free tier works for testing)
2. **HD Wallet** — Generated via Tatum's API for Polygon
3. **USDC Contract** — Polygon USDC: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`

## Step-by-Step Setup

### Step 1: Create Your Tatum Account

1. Go to https://dashboard.tatum.io
2. Sign up for a free developer account
3. Navigate to API Keys → Create a new key for Polygon Mainnet
4. Copy your API key

### Step 2: Generate HD Wallet

Run this once to create your platform's master wallet:

```bash
curl -X POST https://api.tatum.io/v3/polygon/wallet \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_TATUM_API_KEY"
```

Response:
```json
{
  "mnemonic": "SAVE THIS SECURELY — NEVER EXPOSE",
  "xpub": "xpub6E..."
}
```

**CRITICAL:** Store the mnemonic in a hardware wallet or vault. The `xpub` is used 
for address derivation (safe to store in env vars).

### Step 3: Set Environment Variables

Add to your `.env`:

```env
TATUM_API_KEY=your_tatum_api_key_here
TATUM_XPUB=xpub6E...your_xpub_here
TATUM_PROVIDER=LIVE
TATUM_WEBHOOK_SECRET=generate_a_strong_random_string
```

### Step 4: Set Up Webhook Subscription

Register your webhook URL with Tatum to receive deposit notifications:

```bash
curl -X POST https://api.tatum.io/v3/subscription \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_TATUM_API_KEY" \
  -d '{
    "type": "ADDRESS_TRANSACTION",
    "attr": {
      "address": "ALL_USER_ADDRESSES_AUTO_SUBSCRIBED",
      "chain": "MATIC",
      "url": "https://your-backend-domain.com/api/deposit/webhook/tatum"
    }
  }'
```

Note: The backend automatically subscribes new user addresses when they first 
request their deposit address via `GET /api/wallet/deposit-address/polygon`.

### Step 5: Configure HMAC Webhook Verification

Set your Tatum webhook HMAC secret:

```bash
curl -X PUT https://api.tatum.io/v3/subscription \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_TATUM_API_KEY" \
  -d '{
    "type": "HMAC_WEBHOOK",
    "attr": {
      "hmacSecret": "YOUR_TATUM_WEBHOOK_SECRET"
    }
  }'
```

This ensures webhook payloads are verified via the `x-payload-hash` header.

## How It Works (Flow)

1. **User opens Deposit screen** → App calls `GET /api/wallet/deposit-address/polygon`
2. **Backend derives address** → Uses `xpub + userId` as derivation index
3. **User sends USDC** → From any wallet to their unique Polygon address
4. **Tatum detects transfer** → Fires webhook to `POST /api/deposit/webhook/tatum`
5. **Backend verifies HMAC** → Checks `x-payload-hash` header against secret
6. **Credits user balance** → Atomic: credits `availableBalance`, writes `TransactionHistory`
7. **Real-time notification** → Socket emits `deposit_success` + push notification

## Testing (Mock Mode)

When `TATUM_PROVIDER=MOCK` (default), the system:
- Generates deterministic mock addresses based on userId
- Accepts webhook payloads without HMAC verification (non-production only)
- All crypto operations are simulated

## Supported Tokens

Currently only **USDC** on Polygon is supported. Other tokens (MATIC, USDT) 
that land on user addresses are acknowledged but NOT credited (the webhook 
returns `{ ignored: true }` for non-USDC assets).

## Fund Sweeping (Manual)

Tatum does NOT auto-sweep user deposit addresses. You must periodically sweep 
funds from individual user addresses to your hot wallet. This can be done via:

1. Tatum's Transfer API (programmatic)
2. Your hardware wallet interface (manual for larger amounts)

The swept funds are tracked in `SystemMasterCrypto` and `SystemHotWallet`.

## Security Considerations

- Never expose the HD wallet mnemonic
- The `xpub` allows address derivation but NOT spending
- Always verify webhook signatures in production
- Monitor for deposits of unsupported tokens (could be dusting attacks)
- Set up alerts for large deposits (> $10,000)
