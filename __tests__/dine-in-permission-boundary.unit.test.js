'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Dine-in business permission/tenant boundary', () => {
  test('business routes require the canonical dine-in permission', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dineInRoutes.js'), 'utf8');
    assert.match(source, /requirePermission\('restaurant\.dinein\.manage'\)/);
    assert.match(source, /router\.post\('\/tabs',\s*protect, kybGate, dineInManage, ctrl\.openTab\)/);
    assert.match(source, /router\.post\('\/tabs\/:tabId\/items',\s*protect, kybGate, dineInManage, ctrl\.addItem\)/);
    assert.match(source, /router\.post\('\/tabs\/:tabId\/finalize',\s*protect, kybGate, dineInManage, ctrl\.finalizeTab\)/);
    assert.match(source, /router\.get\('\/tabs',\s*protect, kybGate, dineInManage, ctrl\.getOpenTabs\)/);
    assert.match(source, /router\.get\('\/guests',\s*protect, kybGate, dineInManage, ctrl\.getGuests\)/);
    assert.match(source, /router\.get\('\/guests\/search',\s*protect, kybGate, dineInManage, ctrl\.searchGuests\)/);
  });

  test('business controllers derive tenant scope instead of trusting request identifiers', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'dineInController.js'), 'utf8');
    assert.match(source, /getEffectiveBusinessProfileId/);
    assert.doesNotMatch(source, /businessProfileId:\s*req\.body\.businessProfileId/);
    assert.doesNotMatch(source, /businessProfileId:\s*req\.query\.businessProfileId/);
    assert.match(source, /const businessProfileId = await getEffectiveBusinessProfileId/);
  });
});
