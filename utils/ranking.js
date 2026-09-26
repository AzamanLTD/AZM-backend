// utils/ranking.js
// =============================================================================
// AZAMAN — WILSON-SCORE BLENDED RANKING (marketplace discovery audit finding)
// =============================================================================

const Z_95 = 1.96; // 95% confidence z-score, standard choice for this formula

/**
 * @param {number} averageRating - 0..5 star average
 * @param {number} reviewCount - number of reviews backing that average
 * @returns {number} Wilson lower-bound score, 0..1 (higher = rank higher)
 */
function wilsonScore(averageRating, reviewCount) {
    const n = Number(reviewCount) || 0;
    if (n === 0) return 0; // no reviews yet -- ranks below anything with even one
    const p = Math.min(Math.max(Number(averageRating) || 0, 0), 5) / 5; // 0..1 proportion
    const z = Z_95;
    const denominator = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return (centre - margin) / denominator;
}

/**
 * Blended discovery score: Wilson-score trust signal (dominant factor) plus
 * a small, capped boost from raw transaction volume.
 */
function discoveryScore({ averageRating, reviewCount, totalEscrows }) {
    const trust = wilsonScore(averageRating, reviewCount); // 0..1
    const volumeBoost = Math.log10((Number(totalEscrows) || 0) + 1) * 0.05;
    return trust + volumeBoost;
}

module.exports = { wilsonScore, discoveryScore };
