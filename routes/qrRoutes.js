/**
 * QR Code Forge — routes (multi-campaign v2)
 *
 * Public:
 *   GET  /qr/go              — default redirect (backward compat)
 *   GET  /qr/go/:slug         — campaign-specific redirect
 *   GET  /qr/destination      — default { url, label } for widget
 *   GET  /qr/destination/:slug — campaign { url, label } for widget
 *
 * Admin-only:
 *   GET    /qr/campaigns      — list all campaigns
 *   POST   /qr/campaigns      — create campaign
 *   PATCH  /qr/campaigns/:id  — update campaign
 *   DELETE /qr/campaigns/:id  — delete campaign (soft: set isActive=false)
 *   GET    /qr/campaigns/:id/analytics — per-campaign analytics
 *   PATCH  /qr/destination     — update default redirect
 *   GET    /qr/analytics       — global scan analytics (existing, unchanged)
 */
const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect, adminOnly } = require('../middleware/authMiddleware');

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

// ── GET /qr/go (default redirect) ───────────────────────────────────────────
router.get('/go', async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 }, select: { qrRedirectUrl: true } });
    const dest = settings?.qrRedirectUrl || 'https://startup.moolre.com/leaderboard/118';

    prisma.qrScan.create({
      data: {
        ipAddress: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null,
        userAgent: (req.headers['user-agent'] || '').slice(0, 500) || null,
        referrer:  (req.headers['referer'] || '').slice(0, 500) || null,
      }
    }).catch(() => {});

    return res.redirect(302, dest);
  } catch (err) {
    return res.redirect(302, 'https://startup.moolre.com/leaderboard/118');
  }
});

// ── GET /qr/go/:slug (campaign redirect) ────────────────────────────────────
router.get('/go/:slug', async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const campaign = await prisma.qrCampaign.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, destinationUrl: true, isActive: true, totalScans: true },
    });
    if (!campaign || !campaign.isActive) {
      return res.redirect(302, '/qr/go');
    }

    // Log scan with campaignId
    prisma.qrScan.create({
      data: {
        campaignId: campaign.id,
        ipAddress: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null,
        userAgent: (req.headers['user-agent'] || '').slice(0, 500) || null,
        referrer:  (req.headers['referer'] || '').slice(0, 500) || null,
      }
    }).then(() => {
      return prisma.qrCampaign.update({
        where: { id: campaign.id },
        data: { totalScans: { increment: 1 } },
      }).catch(() => {});
    }).catch(() => {});

    return res.redirect(302, campaign.destinationUrl);
  } catch (err) {
    return res.redirect(302, '/qr/go');
  }
});

// ── GET /qr/destination (default) ───────────────────────────────────────────
router.get('/destination', async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const settings = await prisma.globalSettings.findUnique({
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

// ── GET /qr/destination/:slug (campaign) ────────────────────────────────────
router.get('/destination/:slug', async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const campaign = await prisma.qrCampaign.findUnique({
      where: { slug: req.params.slug },
      select: { destinationUrl: true, label: true, isActive: true },
    });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });
    res.json({
      success: true,
      url: campaign.destinationUrl,
      label: campaign.label,
      isActive: campaign.isActive,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /qr/destination (default, admin) ───────────────────────────────────
router.patch('/destination', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const { url, label } = req.body;
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'A valid URL is required.' });
    }
    const updated = await prisma.globalSettings.upsert({
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

// ── GET /qr/campaigns (admin) — list all campaigns ─────────────────────────
router.get('/campaigns', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const campaigns = await prisma.qrCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, slug: true, destinationUrl: true, label: true, isActive: true, totalScans: true, createdAt: true, updatedAt: true },
    });
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /qr/campaigns (admin) — create campaign ────────────────────────────
router.post('/campaigns', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const { name, destinationUrl, label } = req.body;
    if (!name || !destinationUrl) {
      return res.status(400).json({ success: false, message: 'Name and destinationUrl are required.' });
    }
    if (!destinationUrl.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'destinationUrl must be a valid URL.' });
    }
    let slug = slugify(name);
    // Ensure slug uniqueness
    let existing = await prisma.qrCampaign.findUnique({ where: { slug } });
    if (existing) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }
    const campaign = await prisma.qrCampaign.create({
      data: { name, slug, destinationUrl, label: label || name },
    });
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /qr/campaigns/:id (admin) — update campaign ───────────────────────
router.patch('/campaigns/:id', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const { name, destinationUrl, label, isActive } = req.body;
    const existing = await prisma.qrCampaign.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Campaign not found.' });

    const data = {};
    if (name !== undefined) data.name = name;
    if (destinationUrl !== undefined) {
      if (!destinationUrl.startsWith('http')) return res.status(400).json({ success: false, message: 'Invalid URL.' });
      data.destinationUrl = destinationUrl;
    }
    if (label !== undefined) data.label = label;
    if (isActive !== undefined) data.isActive = isActive;

    const updated = await prisma.qrCampaign.update({ where: { id: req.params.id }, data });
    res.json({ success: true, campaign: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /qr/campaigns/:id (admin) — delete campaign ──────────────────────
router.delete('/campaigns/:id', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const existing = await prisma.qrCampaign.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: 'Campaign not found.' });
    await prisma.qrCampaign.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Campaign deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /qr/campaigns/:id/analytics (admin) — per-campaign analytics ────────
router.get('/campaigns/:id/analytics', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const campaign = await prisma.qrCampaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found.' });

    const [totalScans, recentScans, dailyBreakdown, lastScans] = await Promise.all([
      prisma.qrScan.count({ where: { campaignId: req.params.id } }),
      prisma.qrScan.count({ where: { campaignId: req.params.id, createdAt: { gte: since } } }),
      prisma.qrScan.findMany({
        where: { campaignId: req.params.id, createdAt: { gte: since } },
        select: { createdAt: true, ipAddress: true },
      }),
      prisma.qrScan.findMany({
        where: { campaignId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, ipAddress: true, userAgent: true, referrer: true, createdAt: true },
      }),
    ]);

    const daily = {};
    for (const scan of dailyBreakdown) {
      const day = scan.createdAt.toISOString().slice(0, 10);
      daily[day] = (daily[day] || 0) + 1;
    }
    const uniqueIps = new Set(dailyBreakdown.map(s => s.ipAddress).filter(Boolean));

    res.json({
      success: true,
      campaign,
      totalScans,
      recentScans,
      uniqueVisitors: uniqueIps.size,
      daily: Object.entries(daily).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
      lastScans,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /qr/analytics (admin, existing) — global scan analytics ─────────────
router.get('/analytics', protect, adminOnly, async (req, res) => {
  try {
    const prisma = req.app.get('prisma');
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalScans, recentScans, dailyBreakdown, campaignStats, lastScans] = await Promise.all([
      prisma.qrScan.count(),
      prisma.qrScan.count({ where: { createdAt: { gte: since } } }),
      prisma.qrScan.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, ipAddress: true },
      }),
      prisma.qrCampaign.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true, totalScans: true, destinationUrl: true },
        orderBy: { totalScans: 'desc' },
      }),
      prisma.qrScan.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, ipAddress: true, userAgent: true, referrer: true, campaignId: true, createdAt: true },
      }),
    ]);

    const daily = {};
    for (const scan of dailyBreakdown) {
      const day = scan.createdAt.toISOString().slice(0, 10);
      daily[day] = (daily[day] || 0) + 1;
    }
    const uniqueIps = new Set(dailyBreakdown.map(s => s.ipAddress).filter(Boolean));

    res.json({
      success: true,
      totalScans,
      recentScans,
      uniqueVisitors: uniqueIps.size,
      daily: Object.entries(daily).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
      campaigns: campaignStats,
      lastScans,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
