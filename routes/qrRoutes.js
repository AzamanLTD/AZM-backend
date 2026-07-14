/**
 * QR Code Forge — routes
 *
 * Public:
 *   GET  /qr/go           — permanent redirect to the current destination URL
 *   GET  /qr/destination  — returns { url, label } for the preview widget
 *
 * Admin-only:
 *   PATCH /qr/destination — update the redirect destination
 */
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');

// ── GET /qr/go ──────────────────────────────────────────────────────────────
// The URL baked into every printed QR code — forwards to wherever the admin
// has programmed it. 302 so browsers/CDN don't cache it permanently.
router.get('/go', async (req, res) => {
  try {
    const settings = await req.prisma.globalSettings.findUnique({ where: { id: 1 }, select: { qrRedirectUrl: true } });
    const dest = settings?.qrRedirectUrl || 'https://startup.moolre.com/leaderboard/118';
    return res.redirect(302, dest);
  } catch (err) {
    return res.redirect(302, 'https://startup.moolre.com/leaderboard/118');
  }
});

// ── GET /qr/destination ─────────────────────────────────────────────────────
// Public — the admin portal QR Forge widget reads this so it always shows the
// live destination without needing auth.
router.get('/destination', async (req, res) => {
  try {
    const settings = await req.prisma.globalSettings.findUnique({
      where: { id: 1 },
      select: { qrRedirectUrl: true, qrLabel: true },
    });
    res.json({
      success: true,
      url:   settings?.qrRedirectUrl || 'https://startup.moolre.com/leaderboard/118',
      label: settings?.qrLabel       || 'Azaman Vote Page',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /qr/destination ───────────────────────────────────────────────────
// Admin-only — reprogramme where the permanent QR code points.
router.patch('/destination', protect, adminOnly, async (req, res) => {
  try {
    const { url, label } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'A valid URL is required.' });
    }
    const updated = await req.prisma.globalSettings.upsert({
      where: { id: 1 },
      create: { id: 1, qrRedirectUrl: url, qrLabel: label || 'Azaman QR' },
      update: { qrRedirectUrl: url, ...(label !== undefined && { qrLabel: label }) },
      select: { qrRedirectUrl: true, qrLabel: true },
    });
    res.json({ success: true, url: updated.qrRedirectUrl, label: updated.qrLabel });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
