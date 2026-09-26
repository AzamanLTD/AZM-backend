// controllers/invoiceController.js
// =============================================================================
// AZAMAN — Invoice PDF Generation (Phase G.4)
// Generates professional A4 PDF invoices using pdfkit and streams them directly
// to the HTTP response.
// =============================================================================

const PDFDocument = require('pdfkit');
const logger = require('../src/config/logger');

// ── GET /api/business-os/invoices/:id/pdf ────────────────────────────────────
async function downloadInvoicePdf(req, res) {
  const { id } = req.params;
  const prisma = req.app.get('prisma');
  const userId = req.user.id;

  try {
    // Load invoice with all relations — ensure the caller owns the business
    const invoice = await prisma.businessInvoice.findFirst({
      where: { id, businessProfile: { userId } },
      include: {
        lineItems: true,
        taxLines: true,
        businessProfile: {
          select: { id: true, businessName: true, category: true, logoUrl: true },
        },
        customer: {
          select: { id: true, displayName: true, email: true, walletAddress: true },
        },
        location: {
          select: { name: true, address: true, city: true, phone: true },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Stream directly to response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceRef}.pdf"`);
    doc.pipe(res);

    // ── HEADER ──────────────────────────────────────────────────────────────
    const accentColor = '#6366f1'; // indigo-500

    // Business name (left)
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#111827').text(invoice.businessProfile.businessName, 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#6b7280');
    if (invoice.location?.address) doc.text(invoice.location.address, 50, 82);
    if (invoice.location?.city) doc.text(invoice.location.city, 50, 96);
    if (invoice.location?.phone) doc.text(invoice.location.phone, 50, 110);

    // INVOICE label (right)
    doc.fontSize(28).font('Helvetica-Bold').fillColor(accentColor).text('INVOICE', 400, 50, { align: 'right', width: 150 });
    doc.fontSize(10).font('Helvetica').fillColor('#6b7280');
    doc.text(`No: ${invoice.invoiceRef}`, 400, 88, { align: 'right', width: 150 });
    const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    doc.text(`Date: ${formatDate(invoice.createdAt)}`, 400, 102, { align: 'right', width: 150 });
    doc.text(`Status: ${invoice.status}`, 400, 116, { align: 'right', width: 150 });

    // ── BILL TO ─────────────────────────────────────────────────────────────
    doc.moveDown(3);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#9ca3af').text('BILL TO');
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#111827');
    doc.text(invoice.customer?.displayName || 'Customer');
    doc.fontSize(9).font('Helvetica').fillColor('#6b7280');
    if (invoice.customer?.email) doc.text(invoice.customer.email);
    if (invoice.businessNote) {
      doc.moveDown(1);
      doc.fillColor('#9ca3af').text('Note:', 50, doc.y);
      doc.fillColor('#6b7280').text(invoice.businessNote, 50, doc.y + 12, { width: 500 });
    }

    // ── LINE ITEMS TABLE ────────────────────────────────────────────────────
    const tableTop = Math.max(doc.y + 30, 220);

    // Table header background
    doc.rect(50, tableTop, 500, 24).fill('#f9fafb');
    doc.rect(50, tableTop, 500, 24).stroke('#e5e7eb');

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('DESCRIPTION', 60, tableTop + 7, { width: 270 });
    doc.text('QTY', 340, tableTop + 7, { width: 50, align: 'right' });
    doc.text('UNIT PRICE', 400, tableTop + 7, { width: 70, align: 'right' });
    doc.text('TOTAL', 480, tableTop + 7, { width: 60, align: 'right' });

    let y = tableTop + 28;
    doc.font('Helvetica').fillColor('#111827');

    const fmtUsdc = (val) => parseFloat(val.toString()).toFixed(2);

    for (const item of invoice.lineItems) {
      // Row separator
      doc.moveTo(50, y - 4).lineTo(550, y - 4).stroke('#f3f4f6');

      doc.fontSize(10).text(item.description, 60, y, { width: 270 });
      doc.text(item.quantity.toString(), 340, y, { width: 50, align: 'right' });
      doc.text(fmtUsdc(item.unitPrice), 400, y, { width: 70, align: 'right' });
      doc.text(fmtUsdc(item.lineTotal), 480, y, { width: 60, align: 'right' });
      y += 22;
    }

    // Bottom border
    doc.moveTo(50, y).lineTo(550, y).stroke('#e5e7eb');

    // ── TOTALS ──────────────────────────────────────────────────────────────
    y += 16;
    const subtotal = parseFloat(invoice.subtotalUsdc.toString());
    const taxTotal = parseFloat(invoice.taxTotalUsdc.toString());
    const grandTotal = parseFloat(invoice.billTotalUsdc.toString());

    doc.fontSize(10).font('Helvetica').fillColor('#6b7280');
    doc.text('Subtotal', 400, y, { width: 60, align: 'right' });
    doc.fillColor('#111827').text(fmtUsdc(subtotal), 480, y, { width: 60, align: 'right' });

    // Tax lines
    y += 18;
    if (invoice.taxLines.length > 0) {
      for (const tax of invoice.taxLines) {
        doc.fillColor('#6b7280').text(tax.name, 400, y, { width: 60, align: 'right' });
        doc.fillColor('#111827').text(fmtUsdc(tax.computedAmount), 480, y, { width: 60, align: 'right' });
        y += 16;
      }
    } else if (taxTotal > 0) {
      doc.fillColor('#6b7280').text('Tax', 400, y, { width: 60, align: 'right' });
      doc.fillColor('#111827').text(fmtUsdc(taxTotal), 480, y, { width: 60, align: 'right' });
      y += 16;
    }

    // Grand total line
    doc.moveTo(400, y).lineTo(550, y).stroke('#111827');
    doc.lineWidth(1.5);
    y += 8;
    doc.fontSize(13).font('Helvetica-Bold').fillColor(accentColor);
    doc.text('TOTAL', 400, y, { width: 60, align: 'right' });
    doc.fillColor('#111827').text(`${fmtUsdc(grandTotal)} USDC`, 480, y, { width: 70, align: 'right' });

    // ── STATUS BADGE ────────────────────────────────────────────────────────
    y += 30;
    const statusColors = {
      DRAFT: '#6b7280',
      SENT: '#3b82f6',
      PAID: '#22c55e',
      VOID: '#ef4444',
    };
    const statusColor = statusColors[invoice.status] || '#6b7280';
    doc.roundedRect(50, y, 120, 22, 4).fill(statusColor);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff').text(invoice.status, 50, y + 6, { width: 120, align: 'center' });

    if (invoice.paidAt) {
      doc.fontSize(9).font('Helvetica').fillColor('#6b7280');
      doc.text(`Paid on ${formatDate(invoice.paidAt)}`, 180, y + 6);
    }

    // ── FOOTER ──────────────────────────────────────────────────────────────
    doc.fontSize(8).fillColor('#9ca3af').font('Helvetica');
    doc.text('Generated by AZAMAN Platform · Payment terms as specified above.', 50, 780, { align: 'center', width: 500 });

    doc.end();
  } catch (err) {
    logger.error({ err: err }, '[invoice] PDF generation error');
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'PDF generation failed' });
    }
  }
}

module.exports = { downloadInvoicePdf };
