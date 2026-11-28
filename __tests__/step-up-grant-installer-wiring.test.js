// §WP-H G — the release path must create the grant table, and its DDL must not
// drift from the Prisma migration. Production runs overlay installers and never
// `prisma migrate deploy`, so a migration-only table simply does not exist there.
'use strict';
const fs = require('fs');
const path = require('path');

const MIGRATION = path.join(__dirname, '..', 'prisma', 'migrations',
  '20261115120000_action_step_up_grant', 'migration.sql');
const INSTALLER = path.join(__dirname, '..', 'infra', 'install-action-step-up-grant.js');
const RELEASE = path.join(__dirname, '..', 'package.json');

/** Strip SQL line comments and collapse whitespace so formatting alone never
 *  reads as drift, while real changes do. */
const norm = (sql) => sql
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const statementsOf = (sql) => sql
  .split(';')
  .map(norm)
  .filter((s) => s.length > 0);

describe('step-up grant installer wiring', () => {
  const migration = norm(fs.readFileSync(MIGRATION, 'utf8'));
  const installer = fs.readFileSync(INSTALLER, 'utf8');

  test('every migration statement is present verbatim in the installer', () => {
    const installerNorm = norm(installer.replace(/`/g, ''));
    const missing = statementsOf(migration).filter((s) => !installerNorm.includes(s));
    expect(missing).toEqual([]);
  });

  test('the release chain actually runs the installer', () => {
    const { scripts } = JSON.parse(fs.readFileSync(RELEASE, 'utf8'));
    expect(scripts.release).toContain('install-action-step-up-grant.js');
  });

  test('the installer is idempotent: no bare CREATE TABLE / CREATE INDEX', () => {
    // A non-idempotent statement would make the release fail on the second run.
    expect(installer).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(installer).not.toMatch(/CREATE INDEX (?!IF NOT EXISTS)/);
    expect(installer).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(installer).toMatch(/DROP TRIGGER IF EXISTS/);
  });
});
