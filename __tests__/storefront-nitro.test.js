'use strict';

// ── Storefront Nitro Tier Logic Tests ───────────────────────────────────────
// Tests the tier mapping + enforcement logic without needing a DB connection.

describe('Storefront Nitro Tier Logic', () => {
  const TIER_THRESHOLDS = {
    FREE: 0,
    NITRO_BRONZE: 500,
    NITRO_SILVER: 1500,
    NITRO_GOLD: 5000,
  };

  function getTierForStake(stakedBalance) {
    if (stakedBalance >= TIER_THRESHOLDS.NITRO_GOLD) return 'NITRO_GOLD';
    if (stakedBalance >= TIER_THRESHOLDS.NITRO_SILVER) return 'NITRO_SILVER';
    if (stakedBalance >= TIER_THRESHOLDS.NITRO_BRONZE) return 'NITRO_BRONZE';
    return 'FREE';
  }

  function getAvailableWidgets(tier) {
    const base = ['hero_header', 'category_grid', 'product_list', 'business_info', 'hours_card', 'contact_card', 'photo_gallery', 'reviews_carousel'];
    const bronzeExtras = ['video_header', 'announcement_bar', 'social_proof'];
    const silverExtras = ['live_rate_ticker', 'glass_card'];
    const goldExtras = ['custom_embed', 'loyalty_program'];

    switch (tier) {
      case 'NITRO_GOLD': return [...base, ...bronzeExtras, ...silverExtras, ...goldExtras];
      case 'NITRO_SILVER': return [...base, ...bronzeExtras, ...silverExtras];
      case 'NITRO_BRONZE': return [...base, ...bronzeExtras];
      default: return base;
    }
  }

  function getAvailableThemes(tier) {
    const base = ['aurora', 'midnight', 'sunset', 'ocean'];
    const bronzeExtras = ['ember', 'forest'];
    const silverExtras = ['neon', 'glass'];
    const goldExtras = ['royal'];

    switch (tier) {
      case 'NITRO_GOLD': return [...base, ...bronzeExtras, ...silverExtras, ...goldExtras];
      case 'NITRO_SILVER': return [...base, ...bronzeExtras, ...silverExtras];
      case 'NITRO_BRONZE': return [...base, ...bronzeExtras];
      default: return base;
    }
  }

  function validateNitroEligibility(layout, tier) {
    const availableWidgets = getAvailableWidgets(tier);
    const availableThemes = getAvailableThemes(tier);
    const violations = [];

    // Check widget references
    if (layout.widgets) {
      for (const widget of layout.widgets) {
        if (!availableWidgets.includes(widget.type)) {
          violations.push({ type: 'widget', key: widget.type, requiredTier: _getRequiredTier('widget', widget.type) });
        }
      }
    }

    // Check theme reference
    if (layout.themeKey && !availableThemes.includes(layout.themeKey)) {
      violations.push({ type: 'theme', key: layout.themeKey, requiredTier: _getRequiredTier('theme', layout.themeKey) });
    }

    return { eligible: violations.length === 0, violations };
  }

  function _getRequiredTier(category, key) {
    const bronzeWidgets = ['video_header', 'announcement_bar', 'social_proof'];
    const silverWidgets = ['live_rate_ticker', 'glass_card'];
    const goldWidgets = ['custom_embed', 'loyalty_program'];
    const bronzeThemes = ['ember', 'forest'];
    const silverThemes = ['neon', 'glass'];
    const goldThemes = ['royal'];

    if (category === 'widget') {
      if (goldWidgets.includes(key)) return 'NITRO_GOLD';
      if (silverWidgets.includes(key)) return 'NITRO_SILVER';
      if (bronzeWidgets.includes(key)) return 'NITRO_BRONZE';
    }
    if (category === 'theme') {
      if (goldThemes.includes(key)) return 'NITRO_GOLD';
      if (silverThemes.includes(key)) return 'NITRO_SILVER';
      if (bronzeThemes.includes(key)) return 'NITRO_BRONZE';
    }
    return 'FREE';
  }

  // ── Tests ──

  test('FREE tier has 4 themes + 8 widgets', () => {
    expect(getAvailableThemes('FREE')).toHaveLength(4);
    expect(getAvailableWidgets('FREE')).toHaveLength(8);
  });

  test('BRONZE tier adds +2 themes +3 widgets', () => {
    expect(getAvailableThemes('NITRO_BRONZE')).toHaveLength(6);
    expect(getAvailableWidgets('NITRO_BRONZE')).toHaveLength(11);
  });

  test('SILVER tier adds +2 more themes +2 more widgets', () => {
    expect(getAvailableThemes('NITRO_SILVER')).toHaveLength(8);
    expect(getAvailableWidgets('NITRO_SILVER')).toHaveLength(13);
  });

  test('GOLD tier adds +1 more theme +2 more widgets', () => {
    expect(getAvailableThemes('NITRO_GOLD')).toHaveLength(9);
    expect(getAvailableWidgets('NITRO_GOLD')).toHaveLength(15);
  });

  test('Stake of 0 → FREE', () => {
    expect(getTierForStake(0)).toBe('FREE');
  });

  test('Stake of 500 → BRONZE', () => {
    expect(getTierForStake(500)).toBe('NITRO_BRONZE');
  });

  test('Stake of 1500 → SILVER', () => {
    expect(getTierForStake(1500)).toBe('NITRO_SILVER');
  });

  test('Stake of 5000 → GOLD', () => {
    expect(getTierForStake(5000)).toBe('NITRO_GOLD');
  });

  test('Stake of 499 → still FREE', () => {
    expect(getTierForStake(499)).toBe('FREE');
  });

  test('FREE tier cannot use premium widgets', () => {
    const layout = { widgets: [{ type: 'video_header' }], themeKey: 'aurora' };
    const result = validateNitroEligibility(layout, 'FREE');
    expect(result.eligible).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].key).toBe('video_header');
    expect(result.violations[0].requiredTier).toBe('NITRO_BRONZE');
  });

  test('BRONZE tier can use video_header but not glass_card', () => {
    const layout = { widgets: [{ type: 'video_header' }, { type: 'glass_card' }] };
    const result = validateNitroEligibility(layout, 'NITRO_BRONZE');
    expect(result.eligible).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].key).toBe('glass_card');
    expect(result.violations[0].requiredTier).toBe('NITRO_SILVER');
  });

  test('GOLD tier can use everything', () => {
    const layout = {
      widgets: [
        { type: 'hero_header' },
        { type: 'video_header' },
        { type: 'glass_card' },
        { type: 'loyalty_program' },
        { type: 'custom_embed' },
      ],
      themeKey: 'royal',
    };
    const result = validateNitroEligibility(layout, 'NITRO_GOLD');
    expect(result.eligible).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test('Premium theme requires correct tier', () => {
    const layout = { widgets: [], themeKey: 'neon' };
    const result = validateNitroEligibility(layout, 'NITRO_BRONZE');
    expect(result.eligible).toBe(false);
    expect(result.violations[0].requiredTier).toBe('NITRO_SILVER');
  });
});
