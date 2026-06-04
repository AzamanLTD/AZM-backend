/**
 * Email Service - Placeholder Implementation
 * 
 * This service provides mock email functionality that can be easily replaced
 * with real email providers like SendGrid, AWS SES, or Mailgun.
 */

const crypto = require('crypto');

class EmailService {
    constructor() {
        this.apiKey = process.env.EMAIL_API_KEY || 'mock_email_api_key';
        this.provider = process.env.EMAIL_PROVIDER || 'mock';
        this.isTestMode = process.env.NODE_ENV !== 'production';
        this.fromEmail = process.env.FROM_EMAIL || 'noreply@azaman.com';
        this.fromName = process.env.FROM_NAME || 'Azaman Platform';
        
        // Store verification tokens in memory for testing (use Redis in production)
        this.tokenStore = new Map();
    }

    /**
     * Send email
     * @param {string} to - Recipient email address
     * @param {string} subject - Email subject
     * @param {string} htmlContent - HTML email content
     * @param {string} textContent - Plain text content (optional)
     * @param {Object} attachments - Email attachments (optional)
     * @returns {Promise<Object>} Email sending result
     */
    async sendEmail(to, subject, htmlContent, textContent = null, attachments = []) {
        console.log(`📧 Email Service: Sending email to ${to}`);
        console.log(`📝 Subject: ${subject}`);
        
        if (this.isTestMode || this.provider === 'mock') {
            // Mock implementation - log to console and return success
            const messageId = this._generateMessageId();
            
            console.log(`✅ [MOCK EMAIL] Sent to ${to}`);
            console.log(`📋 Subject: ${subject}`);
            console.log(`📋 Message ID: ${messageId}`);
            console.log(`📄 Content Preview: ${htmlContent.substring(0, 100)}...`);
            
            return {
                success: true,
                messageId: messageId,
                provider: 'mock',
                status: 'delivered',
                timestamp: new Date().toISOString()
            };
        }

        // Real email provider integration would go here
        switch (this.provider.toLowerCase()) {
            case 'sendgrid':
                return await this._sendViaSendGrid(to, subject, htmlContent, textContent);
            case 'aws_ses':
                return await this._sendViaAWS(to, subject, htmlContent, textContent);
            case 'mailgun':
                return await this._sendViaMailgun(to, subject, htmlContent, textContent);
            case 'nodemailer':
                return await this._sendViaNodemailer(to, subject, htmlContent, textContent);
            default:
                throw new Error(`Unsupported email provider: ${this.provider}`);
        }
    }

    /**
     * Send welcome email to new users
     * @param {string} email - User email
     * @param {string} username - User's username
     * @returns {Promise<Object>} Email result
     */
    async sendWelcomeEmail(email, username) {
        const subject = 'Welcome to Azaman Platform! 🚀';
        
        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .button { background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
                .features { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Welcome to Azaman, ${username}! 🎉</h1>
                    <p>Your gateway to secure P2P cryptocurrency trading</p>
                </div>
                <div class="content">
                    <h2>Get Started with Your Account</h2>
                    <p>Thank you for joining Azaman Platform. You're now part of a secure and efficient P2P trading community.</p>
                    
                    <div class="features">
                        <h3>🛡️ What you can do:</h3>
                        <ul>
                            <li><strong>Trade Safely:</strong> Buy and sell USDT with built-in escrow protection</li>
                            <li><strong>Instant Transfers:</strong> Send money instantly across Ghana</li>
                            <li><strong>Low Fees:</strong> Enjoy competitive rates and minimal transaction costs</li>
                            <li><strong>24/7 Support:</strong> Get help whenever you need it</li>
                        </ul>
                    </div>
                    
                    <p><strong>Next Steps:</strong></p>
                    <ol>
                        <li>Complete your profile verification</li>
                        <li>Add your preferred payment methods</li>
                        <li>Start your first trade!</li>
                    </ol>
                    
                    <a href="https://app.azaman.com/dashboard" class="button">Open Dashboard</a>
                    
                    <p>Need help? Reply to this email or visit our help center.</p>
                    <p>Happy trading!<br>The Azaman Team</p>
                </div>
            </div>
        </body>
        </html>`;

        const textContent = `
        Welcome to Azaman Platform, ${username}!
        
        Thank you for joining our secure P2P trading community.
        
        What you can do:
        - Trade USDT safely with escrow protection
        - Send instant transfers across Ghana
        - Enjoy low fees and competitive rates
        - Get 24/7 customer support
        
        Next Steps:
        1. Complete your profile verification
        2. Add your preferred payment methods  
        3. Start your first trade!
        
        Visit: https://app.azaman.com/dashboard
        
        Need help? Reply to this email or visit our help center.
        
        Happy trading!
        The Azaman Team
        `;

        return await this.sendEmail(email, subject, htmlContent, textContent);
    }

    /**
     * Send email verification link
     * @param {string} email - User email
     * @param {string} username - User's username
     * @returns {Promise<Object>} Email result with verification token
     */
    async sendEmailVerification(email, username) {
        const token = this._generateVerificationToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
        
        // Store token for verification
        this.tokenStore.set(token, {
            email: email,
            expiresAt: expiresAt,
            used: false
        });

        const verificationUrl = `${process.env.FRONTEND_URL || 'https://app.azaman.com'}/verify-email?token=${token}`;
        const subject = 'Verify Your Azaman Account Email';
        
        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #667eea; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .button { background: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
                .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🔐 Verify Your Email</h1>
                </div>
                <div class="content">
                    <h2>Hello ${username},</h2>
                    <p>Please verify your email address to complete your Azaman account setup.</p>
                    
                    <p>Click the button below to verify your email:</p>
                    <a href="${verificationUrl}" class="button">Verify Email Address</a>
                    
                    <p>Or copy and paste this link in your browser:</p>
                    <p style="word-break: break-all; background: #eee; padding: 10px; border-radius: 3px;">${verificationUrl}</p>
                    
                    <div class="warning">
                        <strong>⚠️ Security Note:</strong> This link expires in 24 hours. If you didn't request this verification, please ignore this email.
                    </div>
                    
                    <p>Questions? Contact our support team.</p>
                </div>
            </div>
        </body>
        </html>`;

        const result = await this.sendEmail(email, subject, htmlContent);
        
        return {
            ...result,
            verificationToken: this.isTestMode ? token : undefined, // Only return token in test mode
            expiresAt: expiresAt.toISOString()
        };
    }

    /**
     * Send trade alert email
     * @param {string} email - Recipient email
     * @param {Object} tradeData - Trade information
     * @returns {Promise<Object>} Email result
     */
    async sendTradeAlert(email, tradeData) {
        const { tradeId, amount, type, status, vendorName } = tradeData;
        const subject = `Azaman Trade Alert: Trade #${tradeId} ${status}`;
        
        let statusColor = '#6c757d';
        let statusEmoji = '📋';
        
        switch (status.toLowerCase()) {
            case 'initiated':
                statusColor = '#007bff';
                statusEmoji = '🚀';
                break;
            case 'payment_received':
                statusColor = '#ffc107';
                statusEmoji = '💰';
                break;
            case 'completed':
                statusColor = '#28a745';
                statusEmoji = '✅';
                break;
            case 'disputed':
                statusColor = '#dc3545';
                statusEmoji = '⚠️';
                break;
        }

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: ${statusColor}; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .trade-info { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; }
                .button { background: ${statusColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${statusEmoji} Trade Update</h1>
                    <p>Trade #${tradeId} - ${status}</p>
                </div>
                <div class="content">
                    <div class="trade-info">
                        <h3>Trade Details:</h3>
                        <p><strong>Trade ID:</strong> #${tradeId}</p>
                        <p><strong>Type:</strong> ${type}</p>
                        <p><strong>Amount:</strong> ${amount} USDT</p>
                        <p><strong>Status:</strong> ${status}</p>
                        ${vendorName ? `<p><strong>Trading with:</strong> ${vendorName}</p>` : ''}
                    </div>
                    
                    <a href="https://app.azaman.com/trades/${tradeId}" class="button">View Trade</a>
                    
                    <p>This is an automated notification. Please check your Azaman app for complete details.</p>
                </div>
            </div>
        </body>
        </html>`;

        return await this.sendEmail(email, subject, htmlContent);
    }

    /**
     * Send password reset email
     * @param {string} email - User email
     * @param {string} username - User's username
     * @returns {Promise<Object>} Email result with reset token
     */
    async sendPasswordReset(email, username) {
        const token = this._generateVerificationToken();
        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
        
        this.tokenStore.set(token, {
            email: email,
            type: 'password_reset',
            expiresAt: expiresAt,
            used: false
        });

        const resetUrl = `${process.env.FRONTEND_URL || 'https://app.azaman.com'}/reset-password?token=${token}`;
        const subject = 'Reset Your Azaman Password';
        
        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #dc3545; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
                .button { background: #dc3545; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 20px 0; }
                .warning { background: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; border-radius: 5px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🔑 Password Reset Request</h1>
                </div>
                <div class="content">
                    <h2>Hello ${username},</h2>
                    <p>We received a request to reset your Azaman account password.</p>
                    
                    <p>Click the button below to reset your password:</p>
                    <a href="${resetUrl}" class="button">Reset Password</a>
                    
                    <div class="warning">
                        <strong>⚠️ Security Alert:</strong>
                        <ul>
                            <li>This link expires in 2 hours</li>
                            <li>If you didn't request this reset, please ignore this email</li>
                            <li>Your current password remains unchanged until you set a new one</li>
                        </ul>
                    </div>
                    
                    <p>For security reasons, please contact support if you need assistance.</p>
                </div>
            </div>
        </body>
        </html>`;

        const result = await this.sendEmail(email, subject, htmlContent);
        
        return {
            ...result,
            resetToken: this.isTestMode ? token : undefined,
            expiresAt: expiresAt.toISOString()
        };
    }

    /**
     * Verify email token
     * @param {string} token - Verification token
     * @returns {Object} Verification result
     */
    verifyToken(token) {
        const tokenData = this.tokenStore.get(token);
        
        if (!tokenData) {
            return {
                success: false,
                message: 'Invalid or expired token'
            };
        }

        if (new Date() > tokenData.expiresAt) {
            this.tokenStore.delete(token);
            return {
                success: false,
                message: 'Token has expired'
            };
        }

        if (tokenData.used) {
            return {
                success: false,
                message: 'Token has already been used'
            };
        }

        // Mark token as used
        tokenData.used = true;
        this.tokenStore.set(token, tokenData);

        return {
            success: true,
            message: 'Token verified successfully',
            email: tokenData.email,
            type: tokenData.type || 'email_verification'
        };
    }

    /**
     * Send transactional withdrawal receipt.
     *
     * Fire-and-forget contract: this method NEVER throws. All errors are
     * caught internally and returned as { success: false, ... } so the
     * caller (request handler / reconciliation worker) can schedule it
     * via setImmediate without risking a crash on a missing email or a
     * provider hiccup.
     *
     * @param {{ id: number, email: string, username?: string }} user
     * @param {{
     *   kind: 'fiat_success'|'fiat_failure'|'crypto_success'|'crypto_refund',
     *   amount: number,
     *   currency?: string,
     *   reference?: string,
     *   destination?: string,
     *   network?: string,
     *   txHash?: string,
     *   gasFeeUsdc?: number,
     *   netPayout?: number,
     *   refundedAmount?: number,
     *   reason?: string
     * }} opts
     */
    async sendWithdrawalReceipt(user, opts) {
        try {
            if (!user || !user.email) {
                console.warn('[emailService.sendWithdrawalReceipt] missing user.email — skipping.');
                return { success: false, skipped: true, reason: 'no_email' };
            }
            const kind = opts && opts.kind;
            let rendered;
            switch (kind) {
                case 'fiat_success':   rendered = this._renderFiatSuccess(user, opts);   break;
                case 'fiat_failure':   rendered = this._renderFiatFailure(user, opts);   break;
                case 'crypto_success': rendered = this._renderCryptoSuccess(user, opts); break;
                case 'crypto_refund':  rendered = this._renderCryptoRefund(user, opts);  break;
                default:
                    console.warn(`[emailService.sendWithdrawalReceipt] unknown kind "${kind}" — skipping.`);
                    return { success: false, skipped: true, reason: 'unknown_kind' };
            }
            return await this.sendEmail(user.email, rendered.subject, rendered.html, rendered.text);
        } catch (err) {
            // Defensive: sendEmail itself shouldn't throw in MOCK mode, but
            // a real provider integration could. Swallow + log so the
            // caller's main flow is never disrupted by an email failure.
            console.error('[emailService.sendWithdrawalReceipt] error:', err.message);
            return { success: false, error: err.message };
        }
    }

    // Private helper methods

    _generateVerificationToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    _generateMessageId() {
        return 'email_' + crypto.randomUUID();
    }

    // ── Withdrawal receipt renderers ────────────────────────────────────────
    // Each returns { subject, html, text }. The HTML matches the layout
    // already used by sendWelcomeEmail / sendEmailVerification / sendTradeAlert
    // (Arial, 600px container, gradient/solid header, "info card" white block).

    _formatAmount(value, currency) {
        if (value == null) return '—';
        const n = Number(value);
        if (!isFinite(n)) return String(value);
        // Always 2 decimals for fiat, up to 6 for crypto. Default 2.
        const decimals = (currency && currency.toUpperCase() === 'USDC') ? 6 : 2;
        return n.toFixed(decimals);
    }

    _shortHash(s, head = 10, tail = 8) {
        if (!s || typeof s !== 'string') return '—';
        if (s.length <= head + tail + 1) return s;
        return `${s.slice(0, head)}…${s.slice(-tail)}`;
    }

    _polygonScanUrl(txHash) {
        // Production-safe public explorer. Falls back to address page if hash missing.
        if (!txHash) return 'https://polygonscan.com';
        return `https://polygonscan.com/tx/${txHash}`;
    }

    _renderFiatSuccess(user, opts) {
        const username = user.username || 'there';
        const amount   = this._formatAmount(opts.amount, opts.currency);
        const currency = (opts.currency || 'USDC').toUpperCase();
        const dest     = opts.destination || '—';
        const ref      = opts.reference || '—';
        const subject  = `Your Azaman withdrawal landed (${amount} ${currency})`;
        const html = `<!DOCTYPE html><html><head><style>
            body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
            .c{max-width:600px;margin:0 auto;padding:20px}
            .h{background:#28a745;color:#fff;padding:24px;text-align:center;border-radius:10px 10px 0 0}
            .b{background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px}
            .card{background:#fff;padding:18px;border-radius:6px;margin:16px 0;border:1px solid #eee}
            .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f1f1}
            .row:last-child{border-bottom:0}
            .lbl{color:#666}.val{font-weight:600;color:#222}
            .ref{font-family:monospace;font-size:12px;color:#555;word-break:break-all}
        </style></head><body><div class="c">
        <div class="h"><h1 style="margin:0">✅ Withdrawal completed</h1><p style="margin:6px 0 0">Your money has landed.</p></div>
        <div class="b"><p>Hi ${username},</p><p>Your Azaman withdrawal settled successfully. Here are the details for your records:</p>
        <div class="card">
            <div class="row"><span class="lbl">Amount</span><span class="val">${amount} ${currency}</span></div>
            <div class="row"><span class="lbl">Destination</span><span class="val">${dest}</span></div>
            <div class="row"><span class="lbl">Reference</span><span class="val ref">${ref}</span></div>
            <div class="row"><span class="lbl">Settled</span><span class="val">${new Date().toUTCString()}</span></div>
        </div>
        <p>If you didn't request this withdrawal, contact support immediately.</p>
        <p style="color:#999;font-size:12px">— Azaman Platform</p></div></div></body></html>`;
        const text = `Hi ${username},\n\nYour Azaman withdrawal of ${amount} ${currency} to ${dest} has settled successfully.\nReference: ${ref}\nSettled: ${new Date().toUTCString()}\n\nIf you didn't request this, contact support immediately.\n\n— Azaman Platform`;
        return { subject, html, text };
    }

    _renderFiatFailure(user, opts) {
        const username = user.username || 'there';
        const refunded = this._formatAmount(opts.refundedAmount != null ? opts.refundedAmount : opts.amount, opts.currency);
        const currency = (opts.currency || 'USDC').toUpperCase();
        const ref      = opts.reference || '—';
        const reason   = opts.reason || 'The payout gateway rejected the disbursement.';
        const subject  = `Your Azaman withdrawal couldn't go through — refunded ${refunded} ${currency}`;
        const html = `<!DOCTYPE html><html><head><style>
            body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
            .c{max-width:600px;margin:0 auto;padding:20px}
            .h{background:#dc3545;color:#fff;padding:24px;text-align:center;border-radius:10px 10px 0 0}
            .b{background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px}
            .card{background:#fff;padding:18px;border-radius:6px;margin:16px 0;border:1px solid #eee}
            .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f1f1}
            .row:last-child{border-bottom:0}
            .lbl{color:#666}.val{font-weight:600;color:#222}
            .ref{font-family:monospace;font-size:12px;color:#555;word-break:break-all}
            .note{background:#fff3cd;border:1px solid #ffeaa7;padding:14px;border-radius:6px;margin:16px 0;font-size:14px}
        </style></head><body><div class="c">
        <div class="h"><h1 style="margin:0">⚠️ Withdrawal didn't complete</h1><p style="margin:6px 0 0">We've refunded your balance.</p></div>
        <div class="b"><p>Hi ${username},</p><p>Your Azaman withdrawal couldn't be settled. The full amount has been returned to your available balance.</p>
        <div class="card">
            <div class="row"><span class="lbl">Refunded amount</span><span class="val">${refunded} ${currency}</span></div>
            <div class="row"><span class="lbl">Reference</span><span class="val ref">${ref}</span></div>
            <div class="row"><span class="lbl">Reason</span><span class="val">${reason}</span></div>
            <div class="row"><span class="lbl">When</span><span class="val">${new Date().toUTCString()}</span></div>
        </div>
        <div class="note">No action required. You can retry the withdrawal at any time, or reach support if you'd like a hand.</div>
        <p style="color:#999;font-size:12px">— Azaman Platform</p></div></div></body></html>`;
        const text = `Hi ${username},\n\nYour Azaman withdrawal couldn't go through. ${refunded} ${currency} has been refunded to your available balance.\nReference: ${ref}\nReason: ${reason}\nWhen: ${new Date().toUTCString()}\n\nNo action required. Retry anytime or contact support.\n\n— Azaman Platform`;
        return { subject, html, text };
    }

    _renderCryptoSuccess(user, opts) {
        const username = user.username || 'there';
        const amount   = this._formatAmount(opts.amount, 'USDC');
        const gas      = this._formatAmount(opts.gasFeeUsdc, 'USDC');
        const net      = this._formatAmount(opts.netPayout != null ? opts.netPayout : (opts.amount - (opts.gasFeeUsdc || 0)), 'USDC');
        const dest     = opts.destination || '—';
        const network  = opts.network || 'Polygon';
        const txShort  = this._shortHash(opts.txHash);
        const txUrl    = this._polygonScanUrl(opts.txHash);
        const subject  = `Crypto withdrawal sent — ${net} USDC to ${this._shortHash(dest, 6, 6)}`;
        const html = `<!DOCTYPE html><html><head><style>
            body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
            .c{max-width:600px;margin:0 auto;padding:20px}
            .h{background:#28a745;color:#fff;padding:24px;text-align:center;border-radius:10px 10px 0 0}
            .b{background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px}
            .card{background:#fff;padding:18px;border-radius:6px;margin:16px 0;border:1px solid #eee}
            .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f1f1}
            .row:last-child{border-bottom:0}
            .lbl{color:#666}.val{font-weight:600;color:#222}
            .ref{font-family:monospace;font-size:12px;color:#555;word-break:break-all}
            .btn{background:#28a745;color:#fff !important;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;margin-top:10px;font-size:13px}
        </style></head><body><div class="c">
        <div class="h"><h1 style="margin:0">✅ Crypto withdrawal sent</h1><p style="margin:6px 0 0">Broadcast to ${network}.</p></div>
        <div class="b"><p>Hi ${username},</p><p>Your USDC withdrawal was broadcast on-chain. Use the explorer link below to confirm settlement at the network level.</p>
        <div class="card">
            <div class="row"><span class="lbl">Withdrawal amount</span><span class="val">${amount} USDC</span></div>
            <div class="row"><span class="lbl">Network gas fee</span><span class="val">${gas} USDC</span></div>
            <div class="row"><span class="lbl">Net payout</span><span class="val">${net} USDC</span></div>
            <div class="row"><span class="lbl">Network</span><span class="val">${network}</span></div>
            <div class="row"><span class="lbl">Destination</span><span class="val ref">${dest}</span></div>
            <div class="row"><span class="lbl">Tx hash</span><span class="val ref">${txShort}</span></div>
            <div class="row"><span class="lbl">Sent</span><span class="val">${new Date().toUTCString()}</span></div>
        </div>
        <a class="btn" href="${txUrl}">View on PolygonScan</a>
        <p style="color:#999;font-size:12px;margin-top:20px">— Azaman Platform</p></div></div></body></html>`;
        const text = `Hi ${username},\n\nYour Azaman crypto withdrawal was broadcast on ${network}.\n\nAmount: ${amount} USDC\nGas fee: ${gas} USDC (100% user-borne)\nNet payout: ${net} USDC\nDestination: ${dest}\nTx hash: ${opts.txHash || '—'}\nExplorer: ${txUrl}\nSent: ${new Date().toUTCString()}\n\n— Azaman Platform`;
        return { subject, html, text };
    }

    _renderCryptoRefund(user, opts) {
        const username = user.username || 'there';
        const refunded = this._formatAmount(opts.refundedAmount != null ? opts.refundedAmount : opts.amount, 'USDC');
        const dest     = opts.destination || '—';
        const network  = opts.network || 'Polygon';
        const reason   = opts.reason || 'On-chain broadcast was rejected by the gateway.';
        const subject  = `Crypto withdrawal couldn't broadcast — refunded ${refunded} USDC`;
        const html = `<!DOCTYPE html><html><head><style>
            body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
            .c{max-width:600px;margin:0 auto;padding:20px}
            .h{background:#dc3545;color:#fff;padding:24px;text-align:center;border-radius:10px 10px 0 0}
            .b{background:#f9f9f9;padding:28px;border-radius:0 0 10px 10px}
            .card{background:#fff;padding:18px;border-radius:6px;margin:16px 0;border:1px solid #eee}
            .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f1f1}
            .row:last-child{border-bottom:0}
            .lbl{color:#666}.val{font-weight:600;color:#222}
            .ref{font-family:monospace;font-size:12px;color:#555;word-break:break-all}
            .note{background:#fff3cd;border:1px solid #ffeaa7;padding:14px;border-radius:6px;margin:16px 0;font-size:14px}
        </style></head><body><div class="c">
        <div class="h"><h1 style="margin:0">⚠️ Crypto withdrawal failed</h1><p style="margin:6px 0 0">We've refunded your USDC.</p></div>
        <div class="b"><p>Hi ${username},</p><p>Your USDC withdrawal couldn't be broadcast on-chain. The full amount has been refunded to your available balance and the gas fee was un-charged.</p>
        <div class="card">
            <div class="row"><span class="lbl">Refunded amount</span><span class="val">${refunded} USDC</span></div>
            <div class="row"><span class="lbl">Intended destination</span><span class="val ref">${dest}</span></div>
            <div class="row"><span class="lbl">Network</span><span class="val">${network}</span></div>
            <div class="row"><span class="lbl">Reason</span><span class="val">${reason}</span></div>
            <div class="row"><span class="lbl">When</span><span class="val">${new Date().toUTCString()}</span></div>
        </div>
        <div class="note">No action required. You can retry the withdrawal at any time, or reach support if you'd like a hand.</div>
        <p style="color:#999;font-size:12px">— Azaman Platform</p></div></div></body></html>`;
        const text = `Hi ${username},\n\nYour Azaman crypto withdrawal couldn't broadcast on ${network}. ${refunded} USDC has been refunded to your available balance.\n\nIntended destination: ${dest}\nReason: ${reason}\nWhen: ${new Date().toUTCString()}\n\nNo action required. Retry anytime or contact support.\n\n— Azaman Platform`;
        return { subject, html, text };
    }

    // Placeholder methods for real email providers
    // Replace these with actual API calls

    async _sendViaSendGrid(to, subject, htmlContent, textContent) {
        // SendGrid Mail Send v3 API — https://docs.sendgrid.com/api-reference/mail-send/mail-send
        try {
            const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    personalizations: [{ to: [{ email: to }] }],
                    from: { email: this.fromEmail, name: this.fromName },
                    subject,
                    content: [
                        ...(textContent ? [{ type: 'text/plain', value: textContent }] : []),
                        { type: 'text/html', value: htmlContent }
                    ]
                })
            });

            // SendGrid returns 202 Accepted on success (no body)
            if (response.status === 202 || response.status === 200) {
                const messageId = response.headers.get('x-message-id') || this._generateMessageId();
                console.log(`✅ [SendGrid] Email sent to ${to} (msgId: ${messageId})`);
                return { success: true, messageId, provider: 'sendgrid', status: 'accepted' };
            }

            const errorBody = await response.text();
            console.error(`❌ [SendGrid] Failed (${response.status}): ${errorBody}`);
            return { success: false, provider: 'sendgrid', status: 'failed', error: errorBody };
        } catch (error) {
            console.error(`❌ [SendGrid] Network error: ${error.message}`);
            return { success: false, provider: 'sendgrid', status: 'error', error: error.message };
        }
    }

    async _sendViaAWS(to, subject, htmlContent, textContent) {
        // TODO: Implement AWS SES integration
        console.log('🔧 [PLACEHOLDER] AWS SES email integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'aws_ses_placeholder',
            status: 'sent'
        };
    }

    async _sendViaMailgun(to, subject, htmlContent, textContent) {
        // TODO: Implement Mailgun API integration
        console.log('🔧 [PLACEHOLDER] Mailgun email integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'mailgun_placeholder',
            status: 'delivered'
        };
    }

    async _sendViaNodemailer(to, subject, htmlContent, textContent) {
        // TODO: Implement Nodemailer SMTP integration
        console.log('🔧 [PLACEHOLDER] Nodemailer SMTP integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'nodemailer_placeholder',
            status: 'sent'
        };
    }
}

module.exports = EmailService;

// Example usage:
/*
const emailService = new EmailService();

// Send welcome email
await emailService.sendWelcomeEmail('user@example.com', 'John');

// Send email verification
const verificationResult = await emailService.sendEmailVerification('user@example.com', 'John');

// Verify token
const verification = emailService.verifyToken('abc123token');

// Send trade alert
await emailService.sendTradeAlert('user@example.com', {
    tradeId: 123,
    amount: 100,
    type: 'BUY',
    status: 'completed',
    vendorName: 'GoldVendor'
});
*/