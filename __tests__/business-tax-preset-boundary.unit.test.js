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

    assert.ok(source.includes("req.method === 'PATCH'"));
    assert.ok(source.includes("/^\\/tax-presets\\/[^/]+$/"));
    assert.ok(source.includes('businessTaxPreset.findFirst'));
    assert.ok(source.includes('where: { id: req.params.id, businessProfileId }'));
    assert.ok(source.includes("message: 'Tax preset not found.'"));
  });
});
