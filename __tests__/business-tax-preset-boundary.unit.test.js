'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('BusinessTaxPreset tenant boundary contract', () => {
  test('permission middleware verifies tax preset ownership before PATCH handlers run', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'requirePermission.js'),
      'utf8',
    );

    assert.match(source, /req\.method === 'PATCH'/);
    assert.match(source, /\/\\\^\\\\\/tax-presets\\\\\/\[\\\^\\\\\/\]\+\\\$\/\./);
    assert.match(
      source,
      /businessTaxPreset\.findFirst\(\{\s*where:\s*\{\s*id:\s*req\.params\.id,\s*businessProfileId\s*\},/s,
    );
    assert.match(source, /Tax preset not found\./);
  });
});
