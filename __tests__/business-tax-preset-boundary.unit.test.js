'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('BusinessTaxPreset tenant boundary contract', () => {
  test('the tax preset update route must scope the target preset to the caller business', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'businessOSRoutes.js'),
      'utf8',
    );

    const start = source.indexOf("router.patch('/tax-presets/:id'");
    const end = source.indexOf("router.delete('/tax-presets/:id'", start);
    assert.notEqual(start, -1, 'tax preset update route not found');
    assert.notEqual(end, -1, 'tax preset delete route not found');

    const route = source.slice(start, end);
    assert.match(
      route,
      /findFirst\(\{\s*where:\s*\{\s*id:\s*req\.params\.id,\s*businessProfileId:\s*bpId\s*\}/s,
      'update route must verify ownership before mutating a tax preset',
    );

    assert.match(
      route,
      /update\(\{\s*where:\s*\{\s*id:\s*req\.params\.id\s*\}/s,
      'the target update should remain keyed by the verified preset id',
    );
  });
});
