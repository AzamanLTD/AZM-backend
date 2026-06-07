// services/adminAlertService.js
// =============================================================================
// AZAMAN — Admin alerting (B-11)
//
// Sends real-time operational alerts to admins for events that need a human
// looking *now*, as opposed to user-facing notifications. Two channels:
//   1. Socket: broadcast to the 'admin_spy_room' (the admin portal + embedded
//      mobile admin screens join this room) — instant in-dashboard banner.
//   2. Email: a single digest line to ADMIN_ALERT_EMAIL — survives nobody
//      being logged in at 3am. Email is fire-and-forget and mock-safe (the
//      emailService no-ops cleanly until EMAIL_PROVIDER is configured), so this
//      service is safe to run today and "lights up" once SendGrid is wired.
//
// Design notes:
//   - Every send is best-effort. An alert must NEVER throw into or slow down
//     the primary financial operation that triggered it. Callers should invoke
//     via setImmediate(() => adminAlertService.emit(...)) after the primary
//     write commits.
//   - Severity drives the dashboard banner color (LOW/MEDIUM/HIGH/CRITICAL).
//
// Wiring (left as explicit TODOs — see WIRING below): the trigger points live
// in financial controllers and are intentionally NOT edited here to keep this
// change additive and verifiable. Drop the documented one-liners in when ready.
// =============================================================================

const ALERT_DEFS = {
    LARGE_WITHDRAWAL_PENDING: { severity: 'HIGH',     title: 'Large withdrawal pending' },
    FIAT_POOL_LOW:            { severity: 'CRITICAL', title: 'Fiat pool below threshold' },
    SUSPICIOUS_TRADE_PATTERN: { severity: 'HIGH',     title: 'Suspicious trade pattern' },
    KYC_MANUAL_REVIEW_REQUIRED:{ severity: 'MEDIUM',  title: 'KYC needs manual review' },
    DISPUTE_FILED:            { severity: 'HIGH',     title: 'Trade dispute filed' },
};

const ADMIN_ROOM = 'admin_spy_room';

class AdminAlertService {
    /**
     * @param {object} deps
     * @param {object} deps.io           Socket.IO server instance
     * @param {object} deps.emailService instance with sendEmail(to, subject, html, text)
     */
    constructor({ io, emailService } = {}) {
        this.io = io || null;
        this.emailService = emailService || null;
        this.alertEmail = process.env.ADMIN_ALERT_EMAIL || null;
        // USD amount at/above which a pending withdrawal is "large". Read here so
        // callers don't each re-parse it.
        this.thresholdUsd = Number(process.env.ADMIN_ALERT_THRESHOLD_USD || '500');
    }

    /**
     * Emit an admin alert on all channels. Never throws.
     *
     * @param {keyof ALERT_DEFS} type
     * @param {object} payload  arbitrary event context (amounts, ids, etc.)
     */
    emit(type, payload = {}) {
        const def = ALERT_DEFS[type];
        if (!def) {
            console.warn(`[adminAlert] unknown alert type: ${type}`);
            return;
        }

        const alert = {
            type,
            severity: def.severity,
            title: def.title,
            message: payload.message || def.title,
            data: payload,
            timestamp: new Date().toISOString(),
        };

        // 1. Socket broadcast — wrapped so a socket hiccup can't bubble up.
        try {
            if (this.io) this.io.to(ADMIN_ROOM).emit('admin_alert', alert);
        } catch (e) {
            console.error('[adminAlert] socket emit failed:', e.message);
        }

        // 2. Email — fire-and-forget, mock-safe. Only attempt if configured.
        if (this.emailService && this.alertEmail) {
            const subject = `[Azaman ${def.severity}] ${def.title}`;
            const html = `<p><strong>${def.title}</strong> (${def.severity})</p>` +
                `<p>${alert.message}</p>` +
                `<pre>${JSON.stringify(payload, null, 2)}</pre>` +
                `<p style="color:#888">${alert.timestamp}</p>`;
            const text = `${def.title} (${def.severity})\n${alert.message}\n` +
                `${JSON.stringify(payload)}\n${alert.timestamp}`;
            Promise.resolve()
                .then(() => this.emailService.sendEmail(this.alertEmail, subject, html, text))
                .catch((e) => console.error('[adminAlert] email failed:', e.message));
        }
    }

    /** Convenience: returns true if a withdrawal amount crosses the alert bar. */
    isLargeWithdrawal(amountUsd) {
        return Number(amountUsd) >= this.thresholdUsd;
    }
}

module.exports = AdminAlertService;

// =============================================================================
// WIRING (apply when ready — each is a single fire-and-forget line after the
// primary operation has committed; alertService = req.app.get('adminAlertService')):
//
//   • controllers/withdrawalController.js — after a withdrawal row is created:
//       if (alertService.isLargeWithdrawal(amountUsd))
//         setImmediate(() => alertService.emit('LARGE_WITHDRAWAL_PENDING',
//           { withdrawalId, userId, amount: amountUsd }));
//
//   • services/finance.service.js / payoutBatchWorker — after debiting the
//     SystemFiatPool, if balance < GlobalSettings threshold:
//       setImmediate(() => alertService.emit('FIAT_POOL_LOW',
//         { currentBalance, threshold }));
//
//   • services/p2p.service.js (disputeTrade) — when a trade enters DISPUTED:
//       setImmediate(() => alertService.emit('DISPUTE_FILED', { tradeId, userId }));
//
//   • controllers/kycController.js (processWebhook) — when confidence lands
//     between auto-reject and auto-approve thresholds:
//       setImmediate(() => alertService.emit('KYC_MANUAL_REVIEW_REQUIRED',
//         { userId, score }));
//
//   • controllers/tradeController.js (initiate) — when a user opens >5 trades
//     in 1h (count check): emit('SUSPICIOUS_TRADE_PATTERN', { userId, count }).
// =============================================================================
