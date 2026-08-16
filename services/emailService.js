// services/emailService.js
// =============================================================================
// AZAMAN V2 — EMAIL SERVICE
//
// Transactional email delivery for invoice notifications, receipt emails,
// and business-customer communications. Uses a pluggable provider interface:
//   • Resend (preferred if RESEND_API_KEY is set)
//   • SendGrid (fallback if SENDGRID_API_KEY is set)
//   • Mock/log mode (development — logs email to console + audit log)
//
// All emails are fire-and-forget from the caller's perspective — errors
// are logged but never block the main transaction.
// =============================================================================

const logger = require('../src/config/logger');

class EmailService {
    constructor() {
        this.provider = this._detectProvider();
    }

    _detectProvider() {
        if (process.env.RESEND_API_KEY) return 'resend';
        if (process.env.SENDGRID_API_KEY) return 'sendgrid';
        return 'mock';
    }

    /**
     * Send an email.
     * @param {{ to, subject, html, text?, from?, replyTo? }} params
     * @returns {Promise<{ success: boolean, provider: string, messageId?: string }>}
     */
    async send({ to, subject, html, text, from, replyTo }) {
        if (!to || !subject) {
            throw new Error('to and subject are required');
        }

        const sender = from || process.env.EMAIL_FROM || 'Azaman <no-reply@azaman.app>';

        try {
            switch (this.provider) {
                case 'resend':
                    return await this._sendResend({ to, subject, html, text, from: sender, replyTo });
                case 'sendgrid':
                    return await this._sendSendGrid({ to, subject, html, text, from: sender, replyTo });
                default:
                    return this._sendMock({ to, subject, html, text, from: sender, replyTo });
            }
        } catch (err) {
            logger.error({ err, to, subject }, '[emailService] send failed');
            // Re-throw so caller can handle, but most callers will catch
            throw err;
        }
    }

    async _sendResend({ to, subject, html, text, from, replyTo }) {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to,
                subject,
                html,
                text: text || html?.replace(/<[^>]*>/g, ''),
                ...(replyTo && { reply_to: replyTo }),
            }),
        });
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Resend API error ${res.status}: ${errBody}`);
        }
        const data = await res.json();
        logger.info({ to, subject, messageId: data.id }, '[emailService] sent via Resend');
        return { success: true, provider: 'resend', messageId: data.id };
    }

    async _sendSendGrid({ to, subject, html, text, from, replyTo }) {
        const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: from },
                subject,
                content: [
                    { type: 'text/plain', value: text || html?.replace(/<[^>]*>/g, '') },
                    { type: 'text/html', value: html },
                ],
                ...(replyTo && { reply_to: { email: replyTo } }),
            }),
        });
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`SendGrid API error ${res.status}: ${errBody}`);
        }
        logger.info({ to, subject }, '[emailService] sent via SendGrid');
        return { success: true, provider: 'sendgrid' };
    }

    _sendMock({ to, subject, html, text, from }) {
        logger.info({ to, subject, from, preview: (text || html || '').slice(0, 200) }, '[emailService] MOCK email (no provider configured)');
        return { success: true, provider: 'mock' };
    }

    /**
     * Build an invoice email template.
     */
    buildInvoiceEmail({ businessName, customerName, invoiceRef, billTotal, lineItems, dueDate, invoiceUrl }) {
        const itemRows = (lineItems || []).map(item => `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${item.description || item.name || ''}</td>
            <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #eee;">${item.quantity || 1}</td>
            <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #eee;">$${Number(item.amount || item.price || 0).toFixed(2)}</td>
          </tr>
        `).join('');

        const html = `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;">
          <div style="max-width:560px;margin:0 auto;padding:24px;">
            <div style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
              <div style="background:#0a0a0f;padding:24px 32px;">
                <h1 style="color:#fff;font-size:20px;margin:0;">🧾 Invoice from ${businessName}</h1>
                <p style="color:#7b7b9a;font-size:13px;margin:4px 0 0;">Invoice #${invoiceRef}</p>
              </div>
              <div style="padding:32px;">
                <p style="color:#1a1a2e;font-size:16px;margin:0 0 16px;">Hi ${customerName || 'there'},</p>
                <p style="color:#4a4a6a;font-size:14px;margin:0 0 24px;">
                  ${businessName} has sent you a bill for <strong style="color:#10b981;">$${Number(billTotal).toFixed(2)} USDC</strong>.
                  ${dueDate ? ` Due by ${new Date(dueDate).toLocaleDateString()}.` : ''}
                </p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                  <thead>
                    <tr style="background:#f8f8fa;">
                      <th style="padding:10px 12px;text-align:left;font-size:12px;color:#7b7b9a;text-transform:uppercase;">Item</th>
                      <th style="padding:10px 12px;text-align:center;font-size:12px;color:#7b7b9a;text-transform:uppercase;">Qty</th>
                      <th style="padding:10px 12px;text-align:right;font-size:12px;color:#7b7b9a;text-transform:uppercase;">Amount</th>
                    </tr>
                  </thead>
                  <tbody>${itemRows}</tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2" style="padding:12px;text-align:right;font-weight:600;color:#1a1a2e;">Total</td>
                      <td style="padding:12px;text-align:right;font-size:18px;font-weight:700;color:#10b981;">$${Number(billTotal).toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
                <a href="${invoiceUrl}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;margin:8px 0 24px;">
                  Pay Invoice
                </a>
                <p style="color:#7b7b9a;font-size:12px;margin:24px 0 0;">
                  Powered by Azaman · This invoice was sent via the Azaman platform.
                </p>
              </div>
            </div>
          </div>
        </body>
        </html>`;

        const text = `Invoice from ${businessName} (#${invoiceRef})\n\nHi ${customerName || 'there'},\n\n${businessName} has sent you a bill for $${Number(billTotal).toFixed(2)} USDC.\n${dueDate ? `Due by ${new Date(dueDate).toLocaleDateString()}.\n` : ''}Pay here: ${invoiceUrl}\n\nPowered by Azaman`;

        return { html, text };
    }
}

module.exports = new EmailService();
