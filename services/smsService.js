/**
 * SMS Service - Placeholder Implementation
 * 
 * This service provides mock SMS functionality that can be easily replaced
 * with real SMS providers like Twilio, AWS SNS, or local providers.
 */

const crypto = require('crypto');

class SMSService {
    constructor() {
        this.apiKey = process.env.SMS_API_KEY || 'mock_sms_api_key';
        this.provider = process.env.SMS_PROVIDER || 'mock';
        this.isTestMode = process.env.NODE_ENV !== 'production';
        
        // Store OTP codes in memory for testing (use Redis in production)
        this.otpStore = new Map();
    }

    /**
     * Send SMS to a phone number
     * @param {string} phoneNumber - Recipient phone number (e.g., "+233241234567")
     * @param {string} message - SMS message content
     * @param {string} sender - Sender ID (optional)
     * @returns {Promise<Object>} SMS sending result
     */
    async sendSMS(phoneNumber, message, sender = 'AZAMAN') {
        console.log(`📱 SMS Service: Sending SMS to ${phoneNumber}`);
        console.log(`📝 Message: ${message}`);
        
        if (this.isTestMode || this.provider === 'mock') {
            // Mock implementation - log to console and return success
            const messageId = this._generateMessageId();
            
            console.log(`✅ [MOCK SMS] Sent to ${phoneNumber}: ${message}`);
            console.log(`📋 Message ID: ${messageId}`);
            
            return {
                success: true,
                messageId: messageId,
                provider: 'mock',
                cost: 0.0,
                status: 'delivered',
                timestamp: new Date().toISOString()
            };
        }

        // Real SMS provider integration would go here
        switch (this.provider.toLowerCase()) {
            case 'twilio':
                return await this._sendViaTwilio(phoneNumber, message, sender);
            case 'aws_sns':
                return await this._sendViaAWS(phoneNumber, message);
            case 'hubtel':
                return await this._sendViaHubtel(phoneNumber, message, sender);
            case 'arkesel':
                return await this._sendViaArkesel(phoneNumber, message, sender);
            default:
                throw new Error(`Unsupported SMS provider: ${this.provider}`);
        }
    }

    /**
     * Send OTP (One-Time Password) via SMS
     * @param {string} phoneNumber - Recipient phone number
     * @param {number} length - OTP length (default: 6)
     * @param {number} expiryMinutes - OTP expiry in minutes (default: 5)
     * @returns {Promise<Object>} OTP sending result
     */
    async sendOTP(phoneNumber, length = 6, expiryMinutes = 5) {
        const otp = this._generateOTP(length);
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        
        // Store OTP for verification
        this.otpStore.set(phoneNumber, {
            code: otp,
            expiresAt: expiresAt,
            attempts: 0,
            maxAttempts: 3
        });

        const message = `Your Azaman verification code is: ${otp}. Valid for ${expiryMinutes} minutes. Do not share this code.`;
        
        const result = await this.sendSMS(phoneNumber, message);
        
        return {
            ...result,
            otp: this.isTestMode ? otp : undefined, // Only return OTP in test mode
            expiresAt: expiresAt.toISOString()
        };
    }

    /**
     * Verify OTP code
     * @param {string} phoneNumber - Phone number that received OTP
     * @param {string} code - OTP code to verify
     * @returns {Object} Verification result
     */
    verifyOTP(phoneNumber, code) {
        const otpData = this.otpStore.get(phoneNumber);
        
        if (!otpData) {
            return {
                success: false,
                message: 'No OTP found for this phone number'
            };
        }

        if (new Date() > otpData.expiresAt) {
            this.otpStore.delete(phoneNumber);
            return {
                success: false,
                message: 'OTP has expired'
            };
        }

        if (otpData.attempts >= otpData.maxAttempts) {
            this.otpStore.delete(phoneNumber);
            return {
                success: false,
                message: 'Maximum verification attempts exceeded'
            };
        }

        otpData.attempts++;

        if (otpData.code !== code) {
            this.otpStore.set(phoneNumber, otpData);
            return {
                success: false,
                message: 'Invalid OTP code',
                attemptsLeft: otpData.maxAttempts - otpData.attempts
            };
        }

        // OTP verified successfully
        this.otpStore.delete(phoneNumber);
        return {
            success: true,
            message: 'OTP verified successfully'
        };
    }

    /**
     * Send withdrawal confirmation SMS for large withdrawals.
     * Fire-and-forget — catches all errors internally so callers are never disrupted.
     *
     * @param {string} phoneNumber - Verified phone number
     * @param {Object} opts - Withdrawal details
     * @param {string} opts.kind - 'fiat_dispatched' | 'fiat_settled' | 'fiat_refunded' | 'crypto_sent' | 'crypto_refunded'
     * @param {number} opts.amount - USDC amount
     * @param {string} [opts.destination] - MoMo phone or wallet address
     * @param {string} [opts.reference] - Idempotency / tracking reference
     * @param {string} [opts.txHash] - On-chain tx hash (crypto only)
     * @param {string} [opts.reason] - Failure/refund reason
     * @returns {Promise<Object>} SMS result (never throws)
     */
    async sendWithdrawalConfirmation(phoneNumber, opts = {}) {
        try {
            const { kind, amount, destination, reference, txHash, reason } = opts;
            const amt = typeof amount === 'number' ? amount.toFixed(2) : String(amount);
            let message;

            switch (kind) {
                case 'fiat_dispatched':
                    message = `Azaman: Your withdrawal of $${amt} USDC has been dispatched to ${destination || 'your MoMo wallet'}. Ref: ${(reference || '').slice(0, 8)}. Settlement is typically instant.`;
                    break;
                case 'fiat_settled':
                    message = `Azaman: Your $${amt} USDC withdrawal has settled successfully. Ref: ${(reference || '').slice(0, 8)}.`;
                    break;
                case 'fiat_refunded':
                    message = `Azaman: Your $${amt} USDC withdrawal could not be completed and has been refunded to your balance. ${reason ? `Reason: ${reason.slice(0, 60)}` : ''}`;
                    break;
                case 'crypto_sent':
                    message = `Azaman: Your $${amt} USDC withdrawal to ${(destination || '').slice(0, 10)}... on Polygon is confirmed. Tx: ${(txHash || '').slice(0, 12)}...`;
                    break;
                case 'crypto_refunded':
                    message = `Azaman: Your $${amt} USDC crypto withdrawal could not be broadcast and has been refunded. ${reason ? `Reason: ${reason.slice(0, 60)}` : ''}`;
                    break;
                default:
                    message = `Azaman: Withdrawal update — $${amt} USDC. Check the app for details.`;
            }

            return await this.sendSMS(phoneNumber, message);
        } catch (err) {
            console.error('[SMSService] sendWithdrawalConfirmation error (swallowed):', err.message);
            return { success: false, error: err.message, provider: this.provider };
        }
    }

    /**
     * Send trade notification SMS
     * @param {string} phoneNumber - Recipient phone number
     * @param {Object} tradeData - Trade information
     * @returns {Promise<Object>} SMS result
     */
    async sendTradeNotification(phoneNumber, tradeData) {
        const { tradeId, amount, type, status } = tradeData;
        let message;

        switch (status.toLowerCase()) {
            case 'initiated':
                message = `Azaman: New ${type} trade #${tradeId} for ${amount} USDT initiated. Check app for details.`;
                break;
            case 'payment_received':
                message = `Azaman: Payment received for trade #${tradeId}. Please release assets if verified.`;
                break;
            case 'completed':
                message = `Azaman: Trade #${tradeId} completed successfully. Assets have been released.`;
                break;
            case 'disputed':
                message = `Azaman: Trade #${tradeId} has been disputed. Admin will review within 24 hours.`;
                break;
            default:
                message = `Azaman: Update on your trade #${tradeId}. Status: ${status}. Check app for details.`;
        }

        return await this.sendSMS(phoneNumber, message);
    }

    // Private helper methods

    _generateOTP(length) {
        const digits = '0123456789';
        let otp = '';
        for (let i = 0; i < length; i++) {
            otp += digits[Math.floor(Math.random() * digits.length)];
        }
        return otp;
    }

    _generateMessageId() {
        return 'msg_' + crypto.randomUUID();
    }

    // Placeholder methods for real SMS providers
    // Replace these with actual API calls

    async _sendViaTwilio(phoneNumber, message, sender) {
        // TODO: Implement Twilio SMS API integration
        // const twilio = require('twilio');
        // const client = twilio(accountSid, authToken);
        
        console.log('🔧 [PLACEHOLDER] Twilio SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'twilio_placeholder',
            cost: 0.05, // Estimated cost
            status: 'queued'
        };
    }

    async _sendViaAWS(phoneNumber, message) {
        // TODO: Implement AWS SNS SMS integration
        console.log('🔧 [PLACEHOLDER] AWS SNS SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'aws_sns_placeholder',
            cost: 0.008,
            status: 'sent'
        };
    }

    async _sendViaHubtel(phoneNumber, message, sender) {
        // TODO: Implement Hubtel SMS API (Ghana)
        console.log('🔧 [PLACEHOLDER] Hubtel SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'hubtel_placeholder',
            cost: 0.02,
            status: 'delivered'
        };
    }

    async _sendViaArkesel(phoneNumber, message, sender) {
        // Arkesel SMS API v2 — https://developers.arkesel.com/#tag/SMS-V2
        // Uses the HTTP API with API key authentication.
        const apiKey = process.env.ARKESEL_API_KEY || this.apiKey;
        const senderId = process.env.ARKESEL_SENDER_ID || sender || 'AZAMAN';

        try {
            const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
                method: 'POST',
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sender: senderId,
                    message: message,
                    recipients: [phoneNumber.replace(/^\+/, '')] // Arkesel expects no leading +
                })
            });

            const data = await response.json();

            if (response.ok && data.status === 'success') {
                const messageId = data.data?.[0]?.id || this._generateMessageId();
                console.log(`✅ [Arkesel] SMS sent to ${phoneNumber} (id: ${messageId})`);
                return {
                    success: true,
                    messageId,
                    provider: 'arkesel',
                    cost: data.data?.[0]?.cost || 0,
                    status: 'sent'
                };
            }

            console.error(`❌ [Arkesel] Failed (${response.status}): ${JSON.stringify(data)}`);
            return {
                success: false,
                provider: 'arkesel',
                status: 'failed',
                error: data.message || 'Unknown Arkesel error'
            };
        } catch (error) {
            console.error(`❌ [Arkesel] Network error: ${error.message}`);
            return { success: false, provider: 'arkesel', status: 'error', error: error.message };
        }
    }
}

module.exports = SMSService;

// Example usage:
/*
const smsService = new SMSService();

// Send regular SMS
await smsService.sendSMS('+233241234567', 'Hello from Azaman!');

// Send OTP
const otpResult = await smsService.sendOTP('+233241234567');

// Verify OTP
const verification = smsService.verifyOTP('+233241234567', '123456');

// Send trade notification
await smsService.sendTradeNotification('+233241234567', {
    tradeId: 123,
    amount: 100,
    type: 'BUY',
    status: 'initiated'
});
*/