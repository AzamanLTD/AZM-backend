// services/azmGiftService.js
// =============================================================================
// AZAMAN — AZM GIFT TRANSFER SERVICE (economic atomicity, 2026-09-17)
//
// The gift send used to be three INDEPENDENT commits (debitAzm tx, creditAzm
// tx, bare azmGift.create). A failure between them committed a torn economic
// state — a debited sender, an uncredited receiver, a gift row claiming
// success and an HTTP 200. creditAzm also swallowed non-P2002 failures, so
// the torn state was SILENT. This service makes the whole transfer ONE
// database transaction with a deterministic, DB-enforced operation identity.
//
// Invariants (proven in __tests__/azm-gift-economic-atomicity.test.js):
//   - debit + credit + gift record commit together or not at all;
//   - the Idempotency-Key is the logical operation identity — the same key
//     retried/raced converges to exactly ONE economic transfer and ONE gift
//     row, enforced by DB unique indexes (AzmSpendLog/AzmRewardLog composite
//     dedup uniques + AzmGift.dedupKey unique), NOT by middleware caching;
//   - concurrent different gifts cannot overdraw the sender (the debit leg's
//     conditional gte mutation is the only authorization);
//   - socket/side effects fire only AFTER the transaction commits.
//
// The generic idempotency() middleware response cache may short-circuit a
// sequential replay before it reaches this service — but it is OPTIONAL and
// fail-open; the DB uniqueness below is the authoritative guard if the cache
// is lost, the process restarts, or two same-key requests race.
// =============================================================================

const { AzmSpendService, AZM_SPEND_SOURCES } = require('./azmSpendService');
const { AzmRewardService } = require('./azmRewardService');

const GIFT_TYPES = ['GIFT', 'TIP', 'REWARD'];
const TIP_CONTEXTS = ['TRADE', 'CHAT', 'MARKETPLACE', 'SUSU', 'BUSINESS', 'GENERAL'];

// The client-supplied logical operation identity. UUIDs and nanoid-style keys
// pass; whitespace/control characters do not.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const REWARD_SOURCE = 'GIFT_TIP_RECEIVED';

class GiftValidationError extends Error {
    constructor(message) { super(message); this.name = 'GiftValidationError'; this.status = 400; }
}
class ReceiverNotFoundError extends Error {
    constructor(message) { super(message); this.name = 'ReceiverNotFoundError'; this.status = 404; }
}

/**
 * Deterministic leg keys for one logical gift operation. All derived from the
 * canonical identity `gift_<senderId>_<idempotencyKey>`:
 *   - spend leg   → the composite unique (userId, 'GIFT_TIP', dedupKey)
 *   - reward leg  → the composite unique (userId, 'GIFT_TIP_RECEIVED', dedupKey)
 *   - gift record → the AzmGift.dedupKey unique (single-column, already
 *                   namespaced by senderId, so cross-sender key collisions
 *                   cannot converge two different operations into one row)
 */
function _legKeys(senderId, idempotencyKey) {
    const op = `gift_${senderId}_${idempotencyKey}`;
    return { op, spend: op, reward: `gift_received_${senderId}_${idempotencyKey}` };
}

/**
 * ONE-transaction gift transfer:
 *   1. revalidate the receiver INSIDE the transaction;
 *   2. debit the sender via _debitAzmWithClient (conditional gte CAS);
 *   3. credit the receiver via _creditAzmWithClient (propagating primitive);
 *   4. create the AzmGift record (dedupKey = the operation identity).
 *
 * Any leg failure rolls the whole operation back. A same-key race that loses
 * the unique-index race gets P2002, aborts cleanly, and converges to the
 * winner's committed gift.
 *
 * @returns {Promise<{replay: boolean, gift: object, debited: boolean, credited: boolean,
 *                     senderNewBalance: number, receiverNewBalance: number}>}
 * @throws {GiftValidationError|ReceiverNotFoundError|Error} — insufficient balance
 *         keeps the historical `Insufficient AZM balance...` message contract.
 */
async function sendGiftTransfer(prisma, io, {
    senderId, receiverId, amount, type = 'GIFT',
    message = null, contextType = null, contextId = null,
    idempotencyKey,
}) {
    // ── request validation (no economic mutation past this point on failure) ──
    if (idempotencyKey == null || typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        throw new GiftValidationError('A valid Idempotency-Key header (8-128 chars, alphanumeric/._:-) is required.');
    }
    if (receiverId === undefined || receiverId === null || receiverId === '') {
        throw new GiftValidationError('Receiver is required.');
    }
    const receiverIdNum = parseInt(receiverId, 10);
    if (!Number.isInteger(receiverIdNum) || receiverIdNum <= 0) {
        throw new GiftValidationError('Receiver is invalid.');
    }
    if (senderId === receiverIdNum) {
        throw new GiftValidationError('Cannot send AZM to yourself.');
    }
    const giftAmount = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!Number.isFinite(giftAmount) || giftAmount <= 0) {
        throw new GiftValidationError('Amount must be positive.');
    }
    if (!GIFT_TYPES.includes(type)) {
        throw new GiftValidationError('Invalid gift type.');
    }
    if (contextType && !TIP_CONTEXTS.includes(contextType)) {
        throw new GiftValidationError('Invalid tip context.');
    }

    const { op, spend, reward } = _legKeys(senderId, idempotencyKey);
    const spendService = new AzmSpendService(prisma);
    const rewardService = new AzmRewardService(prisma);

    let outcome;
    try {
        outcome = await prisma.$transaction(async (tx) => {
            // Sequential-replay fast path: the gift row for this operation
            // already committed — converge WITHOUT touching any balance.
            const existing = await tx.azmGift.findUnique({
                where: { dedupKey: op },
                include: {
                    sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                    receiver: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                },
            });
            if (existing) {
                return { replay: true, gift: existing, debited: false, credited: false };
            }

            // Receiver revalidated inside the transaction (a user deleted or
            // hard-removed between the request and the commit cannot receive).
            const receiver = await tx.user.findUnique({
                where: { id: receiverIdNum },
                select: { id: true, username: true, isDeleted: true },
            });
            if (!receiver || receiver.isDeleted) {
                throw new ReceiverNotFoundError('Receiver not found.');
            }

            // Claim 1 — the gift record FIRST, in the SAME transaction. Its
            // dedupKey unique is the exactly-once row claim: under a same-key
            // race the loser blocks on this insert and, once the winner
            // commits, aborts with P2002 BEFORE any balance movement from
            // this transaction is possible (an aborted insert never reached
            // the debit). Ordering the claim ahead of the legs also means a
            // same-key loser NEVER reports "insufficient balance" for an
            // operation that actually succeeded — it converges instead.
            const gift = await tx.azmGift.create({
                data: {
                    senderId,
                    receiverId: receiverIdNum,
                    amount: giftAmount,
                    type,
                    message: message || null,
                    contextType: contextType || null,
                    contextId: contextId || null,
                    dedupKey: op,
                },
                include: {
                    sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                    receiver: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                },
            });

            // Claim 2 — sender debit (conditional gte CAS, throws
            // 'Insufficient AZM balance...' on loss; rolls the gift claim back).
            const debit = await spendService._debitAzmWithClient(tx, {
                userId: senderId,
                amount: giftAmount,
                source: AZM_SPEND_SOURCES.GIFT_TIP,
                reason: `${type === 'TIP' ? 'Tip' : 'Gift'} to @${receiver.username}`,
                metadata: { receiverId: receiverIdNum, type, contextType, contextId },
                dedupKey: spend,
            });

            // Claim 3 — receiver credit (propagating primitive; never
            // swallows; rolls the gift claim and debit back on failure).
            const credit = await rewardService._creditAzmWithClient(tx, {
                userId: receiverIdNum,
                amount: giftAmount,
                source: REWARD_SOURCE,
                reason: `${type === 'TIP' ? 'Tip' : 'Gift'} from user #${senderId}`,
                metadata: { senderId, type, contextType, contextId, message: message || null },
                dedupKey: reward,
            });

            return {
                replay: false,
                gift,
                debited: debit.debited,
                credited: credit.credited,
                senderNewBalance: debit.newBalance,
                receiverNewBalance: credit.newBalance,
            };
        });
    } catch (err) {
        // Same-key race lost a unique-index race (spend, reward or gift row)
        // → the winner committed the identical logical operation. Converge to
        // the exact idempotent result a sequential replay would have returned.
        if (err?.code === 'P2002') {
            const winner = await prisma.azmGift.findUnique({
                where: { dedupKey: op },
                include: {
                    sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                    receiver: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
                },
            });
            if (winner) {
                // Authoritative sender balance at the moment of the original
                // debit — the converged replay reports the original outcome.
                const spendLog = await prisma.azmSpendLog.findFirst({
                    where: { userId: senderId, source: AZM_SPEND_SOURCES.GIFT_TIP, dedupKey: spend },
                    select: { balanceAfter: true },
                });
                return {
                    replay: true,
                    gift: winner,
                    debited: false,
                    credited: false,
                    senderNewBalance: spendLog ? spendLog.balanceAfter : null,
                    receiverNewBalance: null,
                };
            }
        }
        throw err;
    }

    // ── POST-COMMIT side effects only (a rollback can never un-emit these) ──
    if (!outcome.replay && io) {
        try {
            io.to(`user_${senderId}`).emit('azm_spend', {
                azmBalance: outcome.senderNewBalance,
                spent: giftAmount,
                source: AZM_SPEND_SOURCES.GIFT_TIP,
                reason: `${type === 'TIP' ? 'Tip' : 'Gift'} to @${outcome.gift.receiver.username}`,
                timestamp: new Date().toISOString(),
            });
            if (outcome.credited) {
                io.to(`user_${receiverIdNum}`).emit('azm_reward', {
                    azmBalance: outcome.receiverNewBalance,
                    awarded: giftAmount,
                    source: REWARD_SOURCE,
                    reason: `${type === 'TIP' ? 'Tip' : 'Gift'} from user #${senderId}`,
                    timestamp: new Date().toISOString(),
                });
            }
            io.to(`user_${receiverIdNum}`).emit('azm_gift_received', {
                giftId: outcome.gift.id,
                sender: outcome.gift.sender,
                amount: giftAmount,
                type,
                message: message || null,
                newBalance: outcome.credited ? outcome.receiverNewBalance : null,
            });
        } catch (emitErr) {
            // Post-commit delivery failure must never surface as a failed
            // transfer — the economics are already committed and idempotent.
            const logger = require('../src/config/logger');
            logger.error({ err: emitErr }, '[azmGiftService] post-commit socket emission failed');
        }
    }

    return outcome;
}

module.exports = {
    sendGiftTransfer,
    GIFT_TYPES,
    TIP_CONTEXTS,
    IDEMPOTENCY_KEY_RE,
    GiftValidationError,
    ReceiverNotFoundError,
};
