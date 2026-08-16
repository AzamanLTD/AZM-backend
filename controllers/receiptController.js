// controllers/receiptController.js
// =============================================================================
// AZAMAN — RECEIPT CONTROLLER (Phase Q11)
//
// Endpoints:
//   GET /api/receipts/trade/:tradeId      — Download PDF receipt for a trade
//   GET /api/receipts/withdrawal/:id      — Download PDF receipt for a withdrawal
//
// Both endpoints:
//   - Require authentication (protect middleware)
//   - Verify the requesting user is a party to the transaction
//   - Return a PDF binary with Content-Disposition: attachment
//   - Only generate receipts for COMPLETED trades / COMPLETED withdrawals
// =============================================================================

const logger = require('../src/config/logger');
const { generateTradeReceipt, generateWithdrawalReceipt, generateTransferReceipt } = require('../services/receiptService');

// =============================================================================
// 4. GET TRANSACTION RECEIPT (B-8)
//    GET /api/receipts/transaction/:id
//
// Returns data for a PDF receipt from a TransactionHistory row. Auth: caller
// must own the transaction. Only COMPLETED transactions get receipts.
// =============================================================================
exports.getTransactionReceipt = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ success: false, message: 'Invalid transaction ID' });
        }

        const tx = await prisma.transactionHistory.findUnique({
            where: { id },
            include: {
                user: { select: { id: true, username: true, email: true } }
            }
        });

        if (!tx) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        if (tx.userId !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this transaction' });
        }

        if (tx.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                message: `Receipts are only available for completed transactions. Current status: ${tx.status}`,
            });
        }

        const metadata = tx.metadata || {};

        return res.status(200).json({
            success: true,
            data: {
                id:              tx.id,
                type:            tx.type,
                amountUsdc:      parseFloat(tx.amountUsdc),
                feeUsdc:         parseFloat(tx.feeUsdc || 0),
                txHash:          tx.txHash,
                providerRef:     tx.providerRef,
                payerMsisdn:     tx.payerMsisdn,
                status:          tx.status,
                metadata:        metadata,
                createdAt:       tx.createdAt,
                user:            { username: tx.user.username, email: tx.user.email },
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[receipt.getTransactionReceipt] error');
        return res.status(500).json({ success: false, message: 'Failed to fetch receipt data' });
    }
};

// =============================================================================
// 1. GET TRADE RECEIPT
//    GET /api/receipts/trade/:tradeId
// =============================================================================
exports.getTradeReceipt = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const tradeId = parseInt(req.params.tradeId, 10);

        if (isNaN(tradeId)) {
            return res.status(400).json({ success: false, message: 'Invalid trade ID' });
        }

        // Fetch trade with both parties
        const trade = await prisma.trade.findUnique({
            where: { id: tradeId },
            include: {
                user: { select: { id: true, username: true } },
                vendor: { select: { id: true, username: true } },
            },
        });

        if (!trade) {
            return res.status(404).json({ success: false, message: 'Trade not found' });
        }

        // Authorization: only buyer or vendor can download
        if (trade.userId !== userId && trade.vendorId !== userId) {
            return res.status(403).json({ success: false, message: 'You are not a party to this trade' });
        }

        // Only completed trades get receipts
        if (trade.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                message: `Receipts are only available for completed trades. Current status: ${trade.status}`,
            });
        }

        // Generate PDF
        const requestingUser = { id: userId };
        const pdfBuffer = await generateTradeReceipt(trade, requestingUser);

        // Send as downloadable PDF
        const filename = `azaman-trade-receipt-${trade.id}.pdf`;
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': pdfBuffer.length,
            'Cache-Control': 'private, max-age=3600',
        });

        return res.send(pdfBuffer);

    } catch (error) {
        logger.error({ err: error }, '[receipt.getTradeReceipt] error');
        return res.status(500).json({ success: false, message: 'Failed to generate receipt' });
    }
};

// =============================================================================
// 2. GET WITHDRAWAL RECEIPT
//    GET /api/receipts/withdrawal/:id
// =============================================================================
exports.getWithdrawalReceipt = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const withdrawalId = parseInt(req.params.id, 10);

        if (isNaN(withdrawalId)) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal ID' });
        }

        // Fetch withdrawal with user
        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: withdrawalId },
            include: {
                user: { select: { id: true, username: true } },
            },
        });

        if (!withdrawal) {
            return res.status(404).json({ success: false, message: 'Withdrawal not found' });
        }

        // Authorization: only the withdrawal owner can download
        if (withdrawal.userId !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this withdrawal' });
        }

        // Only completed withdrawals get receipts
        if (withdrawal.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                message: `Receipts are only available for completed withdrawals. Current status: ${withdrawal.status}`,
            });
        }

        // Generate PDF
        const requestingUser = { id: userId };
        const pdfBuffer = await generateWithdrawalReceipt(withdrawal, requestingUser);

        // Send as downloadable PDF
        const filename = `azaman-withdrawal-receipt-${withdrawal.id}.pdf`;
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': pdfBuffer.length,
            'Cache-Control': 'private, max-age=3600',
        });

        return res.send(pdfBuffer);

    } catch (error) {
        logger.error({ err: error }, '[receipt.getWithdrawalReceipt] error');
        return res.status(500).json({ success: false, message: 'Failed to generate receipt' });
    }
};


// =============================================================================
// 3. GET TRANSFER RECEIPT (Phase UI-5, 2026-05-26)
//    GET /api/receipts/transfer/:id
//
// Receipts are immutable records of direct P2P off-ticket money transfers
// (the existing "send money with reason" PeerTransfer flow). Auth: caller
// must be either the sender or the receiver. Status must be COMPLETED.
// =============================================================================
exports.getTransferReceipt = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ success: false, message: 'Invalid transfer ID' });
        }

        const transfer = await prisma.peerTransfer.findUnique({
            where: { id },
            include: {
                sender:   { select: { id: true, username: true } },
                receiver: { select: { id: true, username: true } }
            }
        });

        if (!transfer) {
            return res.status(404).json({ success: false, message: 'Transfer not found' });
        }

        if (transfer.senderId !== userId && transfer.receiverId !== userId) {
            return res.status(403).json({ success: false, message: 'You are not a party to this transfer' });
        }

        if (transfer.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                message: `Receipts are only available for completed transfers. Current status: ${transfer.status}`
            });
        }

        const observer = { id: userId };
        const pdfBuffer = await generateTransferReceipt(transfer, observer);

        const filename = `azaman-transfer-receipt-${String(transfer.id).slice(0, 8)}.pdf`;
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': pdfBuffer.length,
            'Cache-Control': 'private, max-age=3600'
        });
        return res.send(pdfBuffer);
    } catch (error) {
        logger.error({ err: error }, '[receipt.getTransferReceipt] error');
        return res.status(500).json({ success: false, message: 'Failed to generate receipt' });
    }
};
