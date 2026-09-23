// services/conversationMoneyService.js
// =============================================================================
// r36/P0 — CANONICAL AUTHORITY for money-bearing conversation messages
// (/api/conversations).
//
// Replaces the legacy inline handlers, which had four structural flaws:
//   1. messageId was fetched GLOBALLY — a participant of conversation A could
//      act on a money/escrow message from conversation B through A's URL;
//   2. the transfer ran BEFORE the state claim (accept-money debited/credited
//      first and flipped the request to ACCEPTED last — concurrent accepts
//      both moved money);
//   3. the fund claim predicate `status: { not: 'ESCROW_FUNDED' }` matched
//      ESCROW_RELEASED/ESCROW_DISPUTED tickets — a live re-funding path;
//   4. amounts were parsed from message text with a regex, and the financial
//      counterparty came from client-supplied fields that were never checked.
//
// The canonical contract implemented here:
//   • Amounts live in a dedicated durable record (ConversationMoneyTicket,
//     Decimal(20,8), strict exact-decimal validation — no text parsing).
//   • The counterparty is DERIVED from conversation membership at creation
//     and stored on the ticket; client-supplied counterparty fields are
//     validated against it, never trusted.
//   • Every financial transition is an atomic conditional claim (CAS) whose
//     predicate includes the conversation id, the kind, the EXPECTED state,
//     and the EXPECTED actor — the successful claim is the sole authority for
//     the money movement, and both happen in ONE transaction.
//   • Explicit state machine:
//       MONEY_REQUEST: sent → ACCEPTED | DECLINED                 (terminal)
//       ESCROW_TICKET: sent → ESCROW_FUNDED → ESCROW_RELEASED     (terminal)
//       dispute:       sent | ESCROW_FUNDED → ESCROW_DISPUTED     (terminal)
//       MONEY_SEND:    ACCEPTED immediately (generic peer transfer)
//   • MONEY_REQUEST/ESCROW_TICKET are two-party PERSONAL-conversation flows;
//     TRADE/BUSINESS conversations are rejected rather than guessed at.
//   • MONEY_SEND is treated as a GENERIC peer transfer (the recipient may be
//     any user — the conversation is the message surface, not the authority),
//     with durable client-request idempotency: replay returns the original
//     outcome, a conflicting replay fails closed, and concurrent duplicates
//     converge on one transfer (unique clientRequestId index).
//   • Legacy messages created before this record exists fail closed with a
//     clear error — amounts that only exist in emoji text are not money.
// =============================================================================

'use strict';

const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const ledger = require('../services/ledgerService');

const fail = (status, code, message) => {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
};

// Strict positive exact-decimal: reuses the ledger's canonical parser (rejects
// negatives, NaN/Infinity, exponent form, arbitrary strings, >8dp) and adds
// the strictly-positive rule for money in conversations.
function parsePositiveAmount(value, label = 'amount') {
    let dec;
    try {
        dec = ledger.toExactDecimal(value, label);
    } catch (e) {
        throw fail(400, 'INVALID_AMOUNT', `${label}: must be a positive exact decimal (<= 8 decimals, no exponent).`);
    }
    if (dec.isZero()) throw fail(400, 'INVALID_AMOUNT', `${label}: must be positive.`);
    if (dec.gte(new Prisma.Decimal('1000000000000'))) throw fail(400, 'INVALID_AMOUNT', `${label}: exceeds the maximum supported value.`);
    return dec;
}

const _exact = (d) => (d instanceof Prisma.Decimal ? d.toFixed(8) : new Prisma.Decimal(d).toFixed(8));
const _roomHash = (uid1, uid2) =>
    crypto.createHash('sha256').update([String(uid1), String(uid2)].sort().join('_')).digest('hex').slice(0, 32);

class ConversationMoneyService {
    constructor({ prisma, io = null, emitBalanceUpdate = null, pushIfOffline = null }) {
        this.prisma = prisma;
        this.io = io;
        this.emitBalanceUpdate = emitBalanceUpdate || (() => {});
        this.pushIfOffline = pushIfOffline || (() => {});
    }

    // ── Creation ────────────────────────────────────────────────────────────

    // POST /:conversationId/messages — money branches.
    // Caller MUST already be a verified participant of conversationId.
    async sendMoney({ user, conv, type, moneyAmount, amount, recipientId, fromUserId, currency, note, itemName, counterpartyId, clientRequestId }) {
        if (type === 'MONEY_SEND') {
            return this._sendMoney({ user, conv, moneyAmount, recipientId, currency, note, clientRequestId });
        }
        if (type === 'MONEY_REQUEST') {
            return this._createMoneyRequest({ user, conv, moneyAmount, fromUserId, currency, note, clientRequestId });
        }
        if (type === 'ESCROW_TICKET') {
            return this._createEscrowTicket({ user, conv, amount, currency, note, itemName, counterpartyId, clientRequestId });
        }
        throw fail(400, 'UNKNOWN_TYPE', `Unknown message type: ${type}`);
    }

    // The two-party money flows only exist in PERSONAL conversations: the
    // handlers are a two-party personal flow, so unsupported conversation
    // types are REJECTED rather than guessed at.
    _requirePersonal(conv, feature) {
        if (conv.type !== 'PERSONAL') {
            throw fail(400, 'UNSUPPORTED_CONVERSATION_TYPE',
                `${feature} is only supported in personal conversations.`);
        }
    }

    // Generic peer transfer. The recipient is explicit (may be any user); the
    // conversation is where the transfer message lands, not the authority for
    // the recipient.
    async _sendMoney({ user, conv, moneyAmount, recipientId, currency, note, clientRequestId }) {
        const userId = user.id;
        const amt = parsePositiveAmount(moneyAmount, 'moneyAmount');
        const receiverId = Number.parseInt(recipientId, 10);
        if (!Number.isInteger(receiverId) || receiverId < 1) {
            throw fail(400, 'INVALID_INPUT', 'Valid recipientId and moneyAmount required.');
        }
        if (userId === receiverId) throw fail(400, 'INVALID_INPUT', 'Cannot send money to yourself.');

        if (!clientRequestId || typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
            throw fail(400, 'IDEMPOTENCY_REQUIRED',
                'clientRequestId is required for money sends (durable request identity).');
        }
        const requestId = clientRequestId.trim().slice(0, 200);

        // Idempotency: same key returns the original outcome; a conflicting
        // replay (different amount/recipient/conversation/sender) fails closed.
        const existing = await this.prisma.conversationMoneyTicket.findUnique({
            where: { clientRequestId: requestId },
        });
        if (existing) {
            if (existing.kind !== 'MONEY_SEND'
                || existing.conversationId !== conv.id
                || existing.requesterId !== userId
                || existing.counterpartyId !== receiverId
                || new Prisma.Decimal(existing.amount).toFixed(8) !== amt.toFixed(8)) {
                throw fail(409, 'IDEMPOTENCY_CONFLICT',
                    'This clientRequestId was already used with different transfer parameters.');
            }
            const message = await this.prisma.message.findUnique({
                where: { id: existing.messageId },
                include: { sender: { select: { id: true, username: true } } },
            });
            return { message, replay: true, ticket: existing };
        }

        const result = await this.prisma.$transaction(async (tx) => {
            const sender = await tx.user.findUnique({ where: { id: userId } });
            if (!sender) throw fail(400, 'SENDER_NOT_FOUND', 'Sender not found.');
            if (new Prisma.Decimal(sender.availableBalance).lt(amt)) {
                throw fail(400, 'INSUFFICIENT_BALANCE',
                    `Insufficient balance. Required: ${amt.toFixed(8)}, available: ${Number(sender.availableBalance).toFixed(6)}.`);
            }
            const receiver = await tx.user.findUnique({ where: { id: receiverId } });
            if (!receiver) throw fail(400, 'RECEIVER_NOT_FOUND', 'Receiver not found.');

            await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: amt } } });
            await tx.user.update({ where: { id: receiverId }, data: { availableBalance: { increment: amt } } });

            await tx.contact.upsert({
                where: { userId_savedUserId: { userId, savedUserId: receiverId } },
                update: {}, create: { userId, savedUserId: receiverId },
            });
            await tx.contact.upsert({
                where: { userId_savedUserId: { userId: receiverId, savedUserId: userId } },
                update: {}, create: { userId: receiverId, savedUserId: userId },
            });

            const content = note
                ? `💸 Sent ${amt.toFixed(2)} ${currency || 'GHS'} — "${note}"`
                : `💸 Sent ${amt.toFixed(2)} ${currency || 'GHS'}`;
            const message = await tx.message.create({
                data: {
                    conversationId: conv.id,
                    senderId: userId,
                    messageType: 'PAYMENT_TRANSFER',
                    content,
                    status: 'ACCEPTED',
                },
                include: { sender: { select: { id: true, username: true } } },
            });

            let ticket;
            try {
                ticket = await tx.conversationMoneyTicket.create({
                    data: {
                        messageId: message.id,
                        conversationId: conv.id,
                        kind: 'MONEY_SEND',
                        amount: amt,
                        currency: (currency || 'GHS').slice(0, 10),
                        requesterId: userId,
                        counterpartyId: receiverId,
                        status: 'ACCEPTED',
                        clientRequestId: requestId,
                    },
                });
            } catch (e) {
                // A concurrent duplicate with the same key slipped past the
                // pre-check: the unique clientRequestId index makes exactly one
                // writer win. The loser fails closed (whole tx rolls back,
                // including the balance moves) and retries into a replay.
                if (e.code === 'P2002') throw fail(409, 'DUPLICATE_REQUEST', 'A request with this clientRequestId is already in flight.');
                throw e;
            }

            await ledger.post(tx, {
                idempotencyKey: `ledger:transfer:conv-send:${message.id}`,
                entryType: 'TRANSFER',
                description: 'Chat money transfer — liability moved sender→receiver',
                userId,
                relatedEntity: 'message',
                relatedEntityId: message.id,
                metadata: { transferType: 'CONVERSATION_SEND', receiverId, amount: _exact(amt) },
                lines: [
                    { account: `user:${userId}:liability`, debit: _exact(amt) },
                    { account: `user:${receiverId}:liability`, credit: _exact(amt) },
                ],
            });

            await tx.transactionHistory.create({
                data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: amt.neg(), feeUsdc: 0, status: 'COMPLETED' },
            });
            await tx.transactionHistory.create({
                data: { userId: receiverId, type: 'INTERNAL_TRANSFER', amountUsdc: amt, feeUsdc: 0, status: 'COMPLETED' },
            });

            return { message, ticket, sender };
        });

        await this.emitBalanceUpdate(userId);
        await this.emitBalanceUpdate(receiverId);

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, receiverId)}`)
                .emit('new_personal_message', this._formatMessage(result.message, result.ticket));
            this.io.to(`user_${receiverId}`).emit('payment_received', {
                from: userId, amountUsdc: Number(amt), conversationId: conv.id, messageId: result.message.id,
            });
        }
        await this.pushIfOffline(receiverId, `💸 ${result.sender.username} sent you ${amt.toFixed(2)}`,
            note || `${amt.toFixed(2)} transferred to your account.`,
            { type: 'PAYMENT_TRANSFER', conversationId: conv.id, route: `/chat/${conv.id}` });

        return { message: result.message, replay: false, ticket: result.ticket };
    }

    async _createMoneyRequest({ user, conv, moneyAmount, fromUserId, currency, note, clientRequestId }) {
        const userId = user.id;
        this._requirePersonal(conv, 'Money requests');
        const other = conv.participants.find((p) => p.id !== userId);
        const amt = parsePositiveAmount(moneyAmount, 'moneyAmount');

        // fromUserId is client-supplied: it must AGREE with the durable
        // membership-derived counterparty, but is never itself authority.
        if (fromUserId !== undefined && fromUserId !== null) {
            const fromId = Number.parseInt(fromUserId, 10);
            if (!Number.isInteger(fromId) || fromId !== other.id) {
                throw fail(400, 'INVALID_INPUT', 'fromUserId must be the other participant of this conversation.');
            }
        }

        const result = await this._createTicketedMessage({
            conv, userId, kind: 'MONEY_REQUEST', amt, currency, clientRequestId,
            messageType: 'MONEY_REQUEST',
            content: `🤑 Requested ${amt.toFixed(2)} ${currency || 'GHS'}${note ? ` — "${note}"` : ''}`,
        });

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, other.id)}`)
                .emit('new_personal_message', this._formatMessage(result.message, result.ticket));
        }
        await this.pushIfOffline(other.id, `🤑 ${user.username} requested ${amt.toFixed(2)}`, note || '',
            { type: 'MONEY_REQUEST', conversationId: conv.id, messageId: result.message.id });

        return result;
    }

    async _createEscrowTicket({ user, conv, amount, currency, note, itemName, counterpartyId, clientRequestId }) {
        const userId = user.id;
        this._requirePersonal(conv, 'Escrow tickets');
        const other = conv.participants.find((p) => p.id !== userId);
        const amt = parsePositiveAmount(amount, 'amount');

        if (counterpartyId !== undefined && counterpartyId !== null) {
            const cpId = Number.parseInt(counterpartyId, 10);
            if (!Number.isInteger(cpId) || cpId !== other.id) {
                throw fail(400, 'INVALID_INPUT', 'counterpartyId must be the other participant of this conversation.');
            }
        }
        if (!itemName || typeof itemName !== 'string' || !itemName.trim()) {
            throw fail(400, 'INVALID_INPUT', 'Valid itemName and amount required.');
        }

        return this._createTicketedMessage({
            conv, userId, kind: 'ESCROW_TICKET', amt, currency, clientRequestId,
            messageType: 'ESCROW_TICKET',
            content: `🛡️ Escrow: ${itemName.trim().slice(0, 120)} — ${amt.toFixed(2)} ${currency || 'GHS'}${note ? ` — "${note}"` : ''}`,
        });
    }

    async _createTicketedMessage({ conv, userId, kind, amt, currency, clientRequestId, messageType, content }) {
        let requestId = null;
        if (clientRequestId !== undefined && clientRequestId !== null) {
            if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
                throw fail(400, 'INVALID_INPUT', 'clientRequestId must be a non-empty string.');
            }
            requestId = clientRequestId.trim().slice(0, 200);
            const existing = await this.prisma.conversationMoneyTicket.findUnique({
                where: { clientRequestId: requestId },
            });
            if (existing) {
                if (existing.kind !== kind
                    || existing.conversationId !== conv.id
                    || existing.requesterId !== userId
                    || new Prisma.Decimal(existing.amount).toFixed(8) !== amt.toFixed(8)) {
                    throw fail(409, 'IDEMPOTENCY_CONFLICT',
                        'This clientRequestId was already used with different parameters.');
                }
                const message = await this.prisma.message.findUnique({
                    where: { id: existing.messageId },
                    include: { sender: { select: { id: true, username: true } } },
                });
                return { message, ticket: existing, replay: true };
            }
        }

        return this.prisma.$transaction(async (tx) => {
            const message = await tx.message.create({
                data: {
                    conversationId: conv.id,
                    senderId: userId,
                    messageType,
                    content,
                    status: 'sent',
                },
                include: { sender: { select: { id: true, username: true } } },
            });
            let ticket;
            try {
                ticket = await tx.conversationMoneyTicket.create({
                    data: {
                        messageId: message.id,
                        conversationId: conv.id,
                        kind,
                        amount: amt,
                        currency: (currency || 'GHS').slice(0, 10),
                        requesterId: userId,
                        counterpartyId: conv.participants.find((p) => p.id !== userId).id,
                        status: 'sent',
                        ...(requestId ? { clientRequestId: requestId } : {}),
                    },
                });
            } catch (e) {
                if (e.code === 'P2002') throw fail(409, 'DUPLICATE_REQUEST', 'A request with this clientRequestId is already in flight.');
                throw e;
            }
            return { message, ticket, replay: false };
        });
    }

    // ── Ticket resolution: messageId is ALWAYS bound to the URL conversationId ─

    // The lookup predicate itself proves the binding — a foreign messageId is
    // indistinguishable from a nonexistent one for this caller.
    async _resolveTicket(tx, { conversationId, messageId, kind }) {
        const ticket = await tx.conversationMoneyTicket.findFirst({
            where: { messageId, conversationId, kind },
        });
        if (!ticket) {
            throw fail(404, 'TICKET_NOT_FOUND',
                `${kind === 'ESCROW_TICKET' ? 'Escrow ticket' : 'Money request'} not found in this conversation.`);
        }
        return ticket;
    }

    // Idempotent replay: return the durable outcome recorded on the ticket.
    async _outcomeMessage(ticketId, fallbackStatus) {
        const t = await this.prisma.conversationMoneyTicket.findUnique({ where: { id: ticketId } });
        if (t?.resultMessageId) {
            const message = await this.prisma.message.findUnique({
                where: { id: t.resultMessageId },
                include: { sender: { select: { id: true, username: true } } },
            });
            if (message) return { message, ticket: t, replay: true };
        }
        // No stored outcome message: report the CURRENT durable state honestly.
        throw fail(400, 'ALREADY_PROCESSED', `This request was already processed (${t?.status || fallbackStatus}).`);
    }

    // ── accept-money ──────────────────────────────────────────────────────────

    // The payer is the ticket's durable counterparty. The CAS predicate makes
    // the successful claim the sole authority for the transfer: a foreign
    // conversation, a foreign actor, or an already-terminal state all fail
    // closed with NO financial mutation.
    async acceptMoney({ user, conversationId, messageId }) {
        const userId = user.id;
        const requesterName = await this._requesterUsernameFor(messageId);

        const outcome = await this.prisma.$transaction(async (tx) => {
            const ticket = await this._resolveTicket(tx, { conversationId, messageId, kind: 'MONEY_REQUEST' });

            if (ticket.status !== 'sent') {
                if (ticket.status === 'ACCEPTED') return { replayTicket: ticket };
                if (ticket.status === 'DECLINED') throw fail(400, 'ALREADY_DECLINED', 'This money request was already declined.');
                throw fail(400, 'ALREADY_PROCESSED', `This money request is ${ticket.status}.`);
            }
            if (ticket.requesterId === userId) {
                throw fail(400, 'OWN_REQUEST', 'Cannot accept your own request.');
            }

            // THE claim: expected state + expected payer + exact conversation.
            const claim = await tx.conversationMoneyTicket.updateMany({
                where: { id: ticket.id, conversationId, kind: 'MONEY_REQUEST', status: 'sent', counterpartyId: userId },
                data: { status: 'ACCEPTED' },
            });
            if (claim.count !== 1) throw fail(409, 'CLAIM_LOST', 'This money request was just processed by someone else.');

            const amount = new Prisma.Decimal(ticket.amount);
            const payer = await tx.user.findUnique({ where: { id: userId } });
            if (!payer) throw fail(400, 'PAYER_NOT_FOUND', 'Payer not found.');
            if (new Prisma.Decimal(payer.availableBalance).lt(amount)) {
                throw fail(400, 'INSUFFICIENT_BALANCE',
                    `Insufficient balance. Required: ${amount.toFixed(8)}, available: ${Number(payer.availableBalance).toFixed(6)}.`);
            }
            await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: amount } } });
            await tx.user.update({ where: { id: ticket.requesterId }, data: { availableBalance: { increment: amount } } });

            await ledger.post(tx, {
                idempotencyKey: `ledger:transfer:money-request:${messageId}`,
                entryType: 'TRANSFER',
                description: 'Money request accepted — liability moved payer→payee',
                userId,
                relatedEntity: 'message',
                relatedEntityId: messageId,
                metadata: { transferType: 'MONEY_REQUEST_ACCEPT', payeeId: ticket.requesterId, amount: _exact(amount) },
                lines: [
                    { account: `user:${userId}:liability`, debit: _exact(amount) },
                    { account: `user:${ticket.requesterId}:liability`, credit: _exact(amount) },
                ],
            });

            const content = `✅ Accepted: ${amount.toFixed(2)} sent to ${requesterName}`;
            const msg = await tx.message.create({
                data: {
                    conversationId,
                    senderId: userId,
                    messageType: 'PAYMENT_TRANSFER',
                    content,
                },
                include: { sender: { select: { id: true, username: true } } },
            });

            await tx.transactionHistory.create({
                data: { userId, type: 'INTERNAL_TRANSFER', amountUsdc: amount.neg(), feeUsdc: 0, status: 'COMPLETED' },
            });
            await tx.transactionHistory.create({
                data: { userId: ticket.requesterId, type: 'INTERNAL_TRANSFER', amountUsdc: amount, feeUsdc: 0, status: 'COMPLETED' },
            });

            // Lockstep UI status on the request message + replay identity.
            await tx.message.update({ where: { id: messageId }, data: { status: 'ACCEPTED' } });
            const finalTicket = await tx.conversationMoneyTicket.update({
                where: { id: ticket.id },
                data: { status: 'ACCEPTED', resultMessageId: msg.id },
            });

            return { message: msg, ticket: finalTicket };
        });

        if (outcome.replayTicket) return this._outcomeMessage(outcome.replayTicket.id, 'accepted');

        await this.emitBalanceUpdate(userId);
        await this.emitBalanceUpdate(outcome.ticket.requesterId);

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, outcome.ticket.requesterId)}`)
                .emit('new_personal_message', this._formatMessage(outcome.message, outcome.ticket));
            this.io.to(`user_${outcome.ticket.requesterId}`).emit('payment_received', {
                from: userId, amountUsdc: Number(new Prisma.Decimal(outcome.ticket.amount)), conversationId, messageId: outcome.message.id,
            });
        }
        return outcome;
    }

    async _requesterUsernameFor(messageId) {
        const m = await this.prisma.message.findUnique({
            where: { id: messageId },
            include: { sender: { select: { id: true, username: true } } },
        });
        return m?.sender?.username || 'the requester';
    }

    // ── decline-money ─────────────────────────────────────────────────────────

    async declineMoney({ user, conversationId, messageId }) {
        const userId = user.id;
        const outcome = await this.prisma.$transaction(async (tx) => {
            const ticket = await this._resolveTicket(tx, { conversationId, messageId, kind: 'MONEY_REQUEST' });

            if (ticket.status !== 'sent') {
                if (ticket.status === 'DECLINED') return { replayTicket: ticket };
                if (ticket.status === 'ACCEPTED') throw fail(400, 'ALREADY_ACCEPTED', 'This money request was already accepted.');
                throw fail(400, 'ALREADY_PROCESSED', `This money request is ${ticket.status}.`);
            }
            if (ticket.requesterId === userId) {
                throw fail(400, 'OWN_REQUEST', 'Cannot decline your own request.');
            }

            const claim = await tx.conversationMoneyTicket.updateMany({
                where: { id: ticket.id, conversationId, kind: 'MONEY_REQUEST', status: 'sent', counterpartyId: userId },
                data: { status: 'DECLINED' },
            });
            if (claim.count !== 1) throw fail(409, 'CLAIM_LOST', 'This money request was just processed by someone else.');

            await tx.message.update({ where: { id: messageId }, data: { status: 'DECLINED' } });

            const msg = await tx.message.create({
                data: { conversationId, senderId: userId, messageType: 'TEXT', content: '❌ Money request declined' },
                include: { sender: { select: { id: true, username: true } } },
            });
            const finalTicket = await tx.conversationMoneyTicket.update({
                where: { id: ticket.id },
                data: { status: 'DECLINED', resultMessageId: msg.id },
            });
            return { message: msg, ticket: finalTicket };
        });

        if (outcome.replayTicket) return this._outcomeMessage(outcome.replayTicket.id, 'declined');

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, outcome.ticket.requesterId)}`)
                .emit('new_personal_message', this._formatMessage(outcome.message, outcome.ticket));
        }
        return outcome;
    }

    // ── fund-escrow ───────────────────────────────────────────────────────────
    // The ticket creator (the buyer) funds their own ticket; the money locks
    // into the escrow pool for the counterparty (the seller) to be paid on
    // release. The claim predicate includes kind+conversation+state+actor.
    async fundEscrow({ user, conversationId, messageId }) {
        const userId = user.id;
        const outcome = await this.prisma.$transaction(async (tx) => {
            const ticket = await this._resolveTicket(tx, { conversationId, messageId, kind: 'ESCROW_TICKET' });

            // Authorization BEFORE state: a non-owner learns nothing about
            // the ticket's state and can never act on it.
            if (ticket.requesterId !== userId) {
                throw fail(403, 'NOT_TICKET_OWNER', 'Only the escrow ticket creator may fund it.');
            }
            if (ticket.status === 'ESCROW_FUNDED') return { replayTicket: ticket };
            if (ticket.status === 'ESCROW_RELEASED') throw fail(400, 'ALREADY_RELEASED', 'This escrow was already released.');
            if (ticket.status === 'ESCROW_DISPUTED') throw fail(400, 'ALREADY_DISPUTED', 'This escrow is disputed.');
            if (ticket.status !== 'sent') throw fail(400, 'ALREADY_PROCESSED', `This escrow ticket is ${ticket.status}.`);

            // THE claim: exactly a `sent` ticket created by the caller in this
            // conversation can flip to ESCROW_FUNDED. (No `status: { not: ... }`
            // predicate — the expected state is explicit, so a released or
            // disputed ticket can NEVER be re-funded.)
            const claim = await tx.conversationMoneyTicket.updateMany({
                where: { id: ticket.id, conversationId, kind: 'ESCROW_TICKET', status: 'sent', requesterId: userId },
                data: { status: 'ESCROW_FUNDED' },
            });
            if (claim.count !== 1) throw fail(409, 'CLAIM_LOST', 'This escrow ticket was just funded.');

            const amount = new Prisma.Decimal(ticket.amount);
            const funder = await tx.user.findUnique({ where: { id: userId } });
            if (!funder) throw fail(400, 'FUNDER_NOT_FOUND', 'Funder not found.');
            if (new Prisma.Decimal(funder.availableBalance).lt(amount)) {
                throw fail(400, 'INSUFFICIENT_BALANCE',
                    `Insufficient balance. Required: ${amount.toFixed(8)}, available: ${Number(funder.availableBalance).toFixed(6)}.`);
            }
            await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: amount } } });

            await tx.transactionHistory.create({
                data: { userId, type: 'ESCROW_FUNDING', amountUsdc: amount.neg(), feeUsdc: 0, status: 'PENDING' },
            });

            await ledger.post(tx, {
                idempotencyKey: `ledger:escrow:chat-fund:${messageId}`,
                entryType: 'ESCROW_LOCK',
                description: 'Chat escrow ticket funded — funds locked pending release',
                relatedEntity: 'message',
                relatedEntityId: messageId,
                metadata: { funderId: userId, amount: _exact(amount) },
                lines: [
                    { account: `user:${userId}:liability`, debit: _exact(amount) },
                    { account: `escrow:chatmsg-${messageId}:locked`, credit: _exact(amount) },
                ],
            });

            await tx.message.update({ where: { id: messageId }, data: { status: 'ESCROW_FUNDED' } });
            return { ticket };
        });

        if (outcome.replayTicket) return this._outcomeMessage(outcome.replayTicket.id, 'funded');

        await this.emitBalanceUpdate(userId);

        // Outcome message (legacy behavior preserved) + replay identity.
        const amount = new Prisma.Decimal(outcome.ticket.amount);
        const msg = await this.prisma.message.create({
            data: { conversationId, senderId: userId, messageType: 'TEXT', content: `🔒 Escrow funded: ${amount.toFixed(2)}` },
            include: { sender: { select: { id: true, username: true } } },
        });
        const ticket = await this.prisma.conversationMoneyTicket.update({
            where: { id: outcome.ticket.id },
            data: { resultMessageId: msg.id },
        });

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, ticket.counterpartyId)}`)
                .emit('new_personal_message', this._formatMessage(msg, ticket));
        }
        return { message: msg, ticket };
    }

    // ── release-escrow ───────────────────────────────────────────────────────
    // Only the ticket creator (buyer) may release; the DURABLE counterparty
    // stored on the ticket is paid — never a participant derived at request
    // time, never a client-supplied id.
    async releaseEscrow({ user, conversationId, messageId }) {
        const userId = user.id;
        const outcome = await this.prisma.$transaction(async (tx) => {
            const ticket = await this._resolveTicket(tx, { conversationId, messageId, kind: 'ESCROW_TICKET' });

            // Authorization BEFORE state: a non-owner learns nothing about
            // the ticket's state and can never act on it.
            if (ticket.requesterId !== userId) {
                throw fail(403, 'NOT_TICKET_OWNER', 'Only the escrow ticket creator may release it.');
            }
            if (ticket.status === 'ESCROW_RELEASED') return { replayTicket: ticket };
            if (ticket.status === 'ESCROW_DISPUTED') throw fail(400, 'ALREADY_DISPUTED', 'This escrow is disputed — it cannot be released.');
            if (ticket.status !== 'ESCROW_FUNDED') throw fail(400, 'NOT_FUNDED', 'Escrow is not funded.');

            const claim = await tx.conversationMoneyTicket.updateMany({
                where: {
                    id: ticket.id, conversationId, kind: 'ESCROW_TICKET',
                    status: 'ESCROW_FUNDED', requesterId: userId,
                },
                data: { status: 'ESCROW_RELEASED' },
            });
            if (claim.count !== 1) throw fail(409, 'CLAIM_LOST', 'This escrow ticket was just released.');

            const amount = new Prisma.Decimal(ticket.amount);
            const recipientId = ticket.counterpartyId;

            await tx.user.update({ where: { id: recipientId }, data: { availableBalance: { increment: amount } } });

            await ledger.post(tx, {
                idempotencyKey: `ledger:escrow:chat-release:${messageId}`,
                entryType: 'ESCROW_RELEASE',
                description: 'Chat escrow released — ticket pool paid to recipient',
                relatedEntity: 'message',
                relatedEntityId: messageId,
                metadata: { recipientId, amount: _exact(amount) },
                lines: [
                    { account: `escrow:chatmsg-${messageId}:locked`, debit: _exact(amount) },
                    { account: `user:${recipientId}:liability`, credit: _exact(amount) },
                ],
            });
            await tx.transactionHistory.create({
                data: { userId: recipientId, type: 'ESCROW_RELEASE', amountUsdc: amount, feeUsdc: 0, status: 'COMPLETED' },
            });

            await tx.message.update({ where: { id: messageId }, data: { status: 'ESCROW_RELEASED' } });
            return { ticket };
        });

        if (outcome.replayTicket) return this._outcomeMessage(outcome.replayTicket.id, 'released');

        await this.emitBalanceUpdate(outcome.ticket.counterpartyId);

        const amount = new Prisma.Decimal(outcome.ticket.amount);
        const recipient = await this.prisma.user.findUnique({ where: { id: outcome.ticket.counterpartyId } });
        const msg = await this.prisma.message.create({
            data: {
                conversationId,
                senderId: userId,
                messageType: 'TEXT',
                content: `✅ Escrow released: ${amount.toFixed(2)} sent to ${recipient?.username || 'recipient'}`,
            },
            include: { sender: { select: { id: true, username: true } } },
        });
        const ticket = await this.prisma.conversationMoneyTicket.update({
            where: { id: outcome.ticket.id },
            data: { resultMessageId: msg.id },
        });

        if (this.io) {
            this.io.to(`personal_${_roomHash(userId, ticket.counterpartyId)}`)
                .emit('new_personal_message', this._formatMessage(msg, ticket));
        }
        return { message: msg, ticket };
    }

    // ── dispute-escrow ───────────────────────────────────────────────────────
    // Dispute is an EXPLICIT transition from sent | ESCROW_FUNDED only. A
    // terminal RELEASED ticket can never be disputed (the money has already
    // moved), and the claim is a conditional update, so concurrent disputes and
    // a racing release converge deterministically.
    async disputeEscrow({ user, conversationId, messageId, reason }) {
        const userId = user.id;
        const outcome = await this.prisma.$transaction(async (tx) => {
            const ticket = await this._resolveTicket(tx, { conversationId, messageId, kind: 'ESCROW_TICKET' });

            // Authorization BEFORE state: a non-participant learns nothing
            // about the ticket's state and can never act on it.
            if (ticket.requesterId !== userId && ticket.counterpartyId !== userId) {
                throw fail(403, 'NOT_PARTICIPANT', 'Only the ticket participants may dispute it.');
            }
            if (ticket.status === 'ESCROW_DISPUTED') return { replayTicket: ticket };
            if (ticket.status === 'ESCROW_RELEASED') {
                throw fail(400, 'ALREADY_RELEASED', 'This escrow was already released — it cannot be disputed.');
            }
            if (ticket.status !== 'sent' && ticket.status !== 'ESCROW_FUNDED') {
                throw fail(400, 'NOT_DISPUTABLE', `This escrow ticket is ${ticket.status}.`);
            }

            const claim = await tx.conversationMoneyTicket.updateMany({
                where: {
                    id: ticket.id, conversationId, kind: 'ESCROW_TICKET',
                    status: { in: ['sent', 'ESCROW_FUNDED'] },
                    OR: [{ requesterId: userId }, { counterpartyId: userId }],
                },
                data: { status: 'ESCROW_DISPUTED' },
            });
            if (claim.count !== 1) throw fail(409, 'CLAIM_LOST', 'This escrow ticket was just disputed or released.');

            await tx.message.update({ where: { id: messageId }, data: { status: 'ESCROW_DISPUTED' } });
            return { ticket };
        });

        if (outcome.replayTicket) return this._outcomeMessage(outcome.replayTicket.id, 'disputed');

        const msg = await this.prisma.message.create({
            data: {
                conversationId,
                senderId: userId,
                messageType: 'TEXT',
                content: `⚠️ Escrow disputed: ${reason || 'No reason provided'}`,
            },
            include: { sender: { select: { id: true, username: true } } },
        });
        const ticket = await this.prisma.conversationMoneyTicket.update({
            where: { id: outcome.ticket.id },
            data: { resultMessageId: msg.id },
        });

        if (this.io) {
            const otherId = ticket.requesterId === userId ? ticket.counterpartyId : ticket.requesterId;
            this.io.to(`personal_${_roomHash(userId, otherId)}`)
                .emit('new_personal_message', this._formatMessage(msg, ticket));
            this.io.to('admin_spy_room').emit('escrow_disputed', {
                conversationId, messageId, userId, reason: reason || 'No reason provided',
            });
        }
        return { message: msg, ticket };
    }

    // ── Formatting (legacy envelope, now backed by real structured data) ──────

    _formatMessage(msg, ticket) {
        return {
            id: msg.id,
            conversationId: msg.conversationId,
            senderId: msg.sender?.id || msg.senderId,
            senderName: msg.sender?.username || 'Unknown',
            text: msg.content,
            type: msg.messageType,
            status: ticket?.status || msg.status || 'sent',
            createdAt: msg.createdAt,
            moneyAmount: ticket ? new Prisma.Decimal(ticket.amount).toFixed(2) : null,
            moneyDirection: null,
            moneyStatus: ticket ? ticket.status : null,
            escrowTicket: ticket && ticket.kind === 'ESCROW_TICKET'
                ? { amount: new Prisma.Decimal(ticket.amount).toFixed(2), currency: ticket.currency, status: ticket.status }
                : null,
        };
    }
}

module.exports = { ConversationMoneyService, parsePositiveAmount };
