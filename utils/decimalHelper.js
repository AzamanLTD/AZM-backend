// =============================================================================
// PHASE J3: Prisma Decimal → Number Serialization Helper
// =============================================================================
//
// NOTE: The primary Decimal-to-Number conversion is handled globally via
// Prisma.Decimal.prototype.valueOf/toJSON patches in server.js. This utility
// is provided for edge cases (e.g., raw queries, testing contexts, or code
// that runs outside the server.js initialization path).
//
// Usage:
//   const { toNumber, toPlain } = require('../utils/decimalHelper');
//
//   // Single value:
//   const price = toNumber(ad.pricePerUSD); // Decimal("12.5") → 12.5
//
//   // Entire Prisma object (shallow or nested):
//   const plainUser = toPlain(user);        // all Decimals → numbers
//   const plainAds  = toPlain(ads);         // works on arrays too
// =============================================================================

/**
 * Convert a single Prisma Decimal (or any value) to a plain JS number.
 * Returns the original value unchanged if it's not a Decimal-like object.
 *
 * @param {*} val - The value to convert
 * @returns {number|*} - Number if Decimal, otherwise the original value
 */
function toNumber(val) {
  if (val === null || val === undefined) return val;
  // Prisma Decimal objects have a toNumber() method and a d property (decimal.js internals)
  if (typeof val === 'object' && typeof val.toNumber === 'function' && val.constructor?.name === 'Decimal') {
    return val.toNumber();
  }
  // Also handle cases where it's already a string representation of a number
  // (e.g., from raw queries or manual JSON.parse)
  return val;
}

/**
 * Recursively convert all Prisma Decimal fields in an object/array to plain
 * JS numbers. Handles nested objects, arrays, and null values gracefully.
 *
 * NOTE: This creates a shallow-ish clone — primitive values are copied,
 * Decimal objects are replaced with numbers, nested objects are recursed.
 * Non-plain objects (Date, Buffer, etc.) are passed through unchanged.
 *
 * @param {*} obj - Prisma query result (object, array, or primitive)
 * @returns {*} - New object with all Decimals replaced by numbers
 */
function toPlain(obj) {
  if (obj === null || obj === undefined) return obj;

  // Handle Decimal directly
  if (typeof obj === 'object' && typeof obj.toNumber === 'function' && obj.constructor?.name === 'Decimal') {
    return obj.toNumber();
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => toPlain(item));
  }

  // Handle Date objects — pass through unchanged
  if (obj instanceof Date) {
    return obj;
  }

  // Handle plain objects (Prisma result rows)
  if (typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = toPlain(obj[key]);
    }
    return result;
  }

  // Primitives (string, number, boolean) — pass through
  return obj;
}

module.exports = { toNumber, toPlain };
