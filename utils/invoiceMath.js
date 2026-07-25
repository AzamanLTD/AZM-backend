// utils/invoiceMath.js
// =============================================================================
// Pure functions for invoice line-item and tax-line arithmetic.
// Extracted from services/businessInvoiceService.js so both the service
// and the test suite share a single source of truth.
// =============================================================================

/**
 * Compute the subtotal from an array of line items.
 * Each item: { quantity, unitPrice }
 * Returns { subtotal, lineItems } where lineItems have lineTotal filled in.
 */
function computeLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0)
    throw new Error('At least one line item is required.');
  if (lineItems.length > 50)
    throw new Error('Maximum 50 line items per invoice.');

  let subtotal = 0;
  const clean = lineItems.map(item => {
    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    const unit = parseFloat(item.unitPrice);
    if (isNaN(unit) || unit < 0) throw new Error('Invalid unitPrice in line item.');
    const lineTotal = qty * unit;
    subtotal += lineTotal;
    return {
      description: String(item.description || '').trim().slice(0, 200),
      quantity: qty,
      unitPrice: unit,
      lineTotal,
    };
  });

  return { subtotal: parseFloat(subtotal.toFixed(6)), lineItems: clean };
}

/**
 * Compute tax lines from an array of tax specs against a subtotal.
 * Each spec: { name, type: 'FLAT' | 'PERCENTAGE', value }
 * Returns { taxTotal, taxLines } where taxLines have computedAmount filled in.
 */
function computeTaxLines(taxLines, subtotal) {
  let taxTotal = 0;
  const clean = (taxLines || []).map(t => {
    const name = String(t.name || '').trim().slice(0, 100);
    if (!name) throw new Error('Tax line name is required.');
    const type = t.type === 'FLAT' ? 'FLAT' : 'PERCENTAGE';
    const value = parseFloat(t.value);
    if (isNaN(value) || value < 0) throw new Error(`Invalid tax value for '${name}'.`);
    const computed = type === 'PERCENTAGE' ? subtotal * (value / 100) : value;
    taxTotal += computed;
    return { name, type, value, computedAmount: parseFloat(computed.toFixed(6)) };
  });

  return { taxTotal: parseFloat(taxTotal.toFixed(6)), taxLines: clean };
}

/**
 * Full invoice computation: line items + tax lines → bill total.
 */
function computeInvoiceTotals(lineItems, taxLines) {
  const { subtotal, lineItems: clean } = computeLineItems(lineItems);
  const { taxTotal, taxLines: cleanTax } = computeTaxLines(taxLines, subtotal);
  const billTotal = parseFloat((subtotal + taxTotal).toFixed(6));
  return { subtotal, taxTotal, billTotal, lineItems: clean, taxLines: cleanTax };
}

module.exports = { computeLineItems, computeTaxLines, computeInvoiceTotals };
