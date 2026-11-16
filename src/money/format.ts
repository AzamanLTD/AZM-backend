/**
 * WP-MONEY — exact decimal rendering.
 *
 * Rendering is string arithmetic on the integer, never `Number.toFixed` (which
 * rounds through binary floating point and would quietly change a balance).
 */
export function formatMinor(minorUnits: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new TypeError(`decimals must be a non-negative integer, received ${String(decimals)}`);
  }
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const digits = magnitude.toString();

  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;

  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals);
  // A negative that rounds to zero is rendered as zero, not "-0.00".
  const sign = negative && magnitude !== 0n ? '-' : '';
  return `${sign}${whole}.${fraction}`;
}
