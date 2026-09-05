'use strict';

const router = require('express').Router();
const logger = require('../src/config/logger');

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, '[Storefront Discover]');
      res.status(err.statusCode || 400).json({
        success: false,
        message: err.message,
      });
    }
  };
}

function buildDiscoverWhere(query = {}) {
  const { q, category } = query;
  const businessProfile = {
    isSuspended: false,
    isPausedByOwner: false,
  };

  if (category) businessProfile.category = String(category).trim();
  if (q && String(q).trim()) {
    businessProfile.businessName = {
      contains: String(q).trim(),
      mode: 'insensitive',
    };
  }

  return {
    status: 'PUBLISHED',
    businessProfile,
  };
}

router.get('/discover', wrap(async (req, res) => {
  const prisma = req.app.get('prisma');
  const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const skip = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = buildDiscoverWhere(req.query);

  const [layouts, total] = await Promise.all([
    prisma.businessStorefrontLayout.findMany({
      where,
      include: {
        businessProfile: {
          select: {
            id: true,
            bizId: true,
            businessName: true,
            category: true,
            logoUrl: true,
            coverPhotoUrl: true,
            averageRating: true,
            reviewCount: true,
            description: true,
            address: true,
            phoneNumber: true,
          },
        },
        theme: { select: { key: true, name: true, tokenSet: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take,
      skip,
    }),
    prisma.businessStorefrontLayout.count({ where }),
  ]);

  const results = layouts.map((layout) => ({
    businessProfileId: layout.businessProfileId,
    business: layout.businessProfile,
    theme: {
      key: layout.theme.key,
      name: layout.theme.name,
      accent: layout.theme.tokenSet?.accent || '#6C4FD1',
    },
    publishedAt: layout.publishedAt,
    tileCount: layout.layoutJson?.tiles?.length || 0,
  }));

  res.json({
    success: true,
    data: {
      results,
      total,
      hasMore: skip + take < total,
    },
  });
}));

module.exports = { router, buildDiscoverWhere };