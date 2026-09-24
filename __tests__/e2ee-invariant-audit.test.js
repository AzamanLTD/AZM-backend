'use strict';
// =============================================================================
// §r40.2 audit finding 1 — proof that the static E2EE invariant audit
// actually inspects the real Prisma models and rejects private material.
//
// The original audit's model matcher was case-sensitive (^model E2EE\w+) and
// the real models are E2eeDevice/E2eeOneTimePreKey — so check #1 was vacuous:
// it stayed green while inspecting NOTHING. These proofs pin both directions:
//   1. the REAL schema is detected, inspected, and passes;
//   2. a controlled mutation adding private/secret material MUST fail;
//   3. capitalization variants of the model name are still caught (no drift);
//   4. an empty/vacuous schema MUST fail (never a silent green);
//   5. explanatory comments mentioning "private" do NOT false-positive.
// Static only — no database, runs in every environment.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { auditPrismaE2eeModels } = require('../infra/audit-e2ee-invariants');

const realSchema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');

describe('E2EE invariant audit — schema inspection is non-vacuous (r40.2)', () => {
    test('the REAL schema is detected and inspected: both E2EE models are observed and pass', () => {
        const { models, failures } = auditPrismaE2eeModels(realSchema);
        expect(models.map((m) => m.toLowerCase()).sort()).toEqual(['e2eedevice', 'e2eeonetimeprekey']);
        expect(models.length).toBeGreaterThanOrEqual(2);
        expect(failures).toEqual([]);
    });

    test('a private column added to a real-cased model (E2eeDevice) MUST fail the audit', () => {
        const fixture = realSchema.replace(
            'model E2eeDevice {',
            'model E2eeDevice {\n  privateKey String @db.VarChar(100) // sneaked in',
        );
        const { models, failures } = auditPrismaE2eeModels(fixture);
        expect(models.map((m) => m.toLowerCase())).toContain('e2eedevice');
        expect(failures.length).toBeGreaterThan(0);
        expect(failures.join(' ')).toMatch(/private\/secret column material/);
    });

    test('a secret column under a DIFFERENT capitalization (E2EEDevice) is still caught — the matcher cannot drift again', () => {
        const fixture = `
model E2EEDevice {
  id        String  @id @default(uuid())
  userId    Int
  deviceSecret String @db.VarChar(100)
}

model E2EEOneTimePreKey {
  id      String  @id @default(uuid())
  userId  Int
  keyId   Int
  otpSecret   String @db.VarChar(100)
  isUsed  Boolean @default(false)
}
`;
        const { models, failures } = auditPrismaE2eeModels(fixture);
        expect(models.sort()).toEqual(['E2EEDevice', 'E2EEOneTimePreKey']);
        expect(failures.length).toBe(2); // BOTH mutated models are flagged
        expect(failures.join(' ')).toMatch(/private\/secret column material/);
    });

    test('a Bytes column (raw binary = the plausible private-key smuggling vector) MUST fail', () => {
        const fixture = `
model E2eeDevice {
  id        String  @id @default(uuid())
  userId    Int
  keyBlob   Bytes
}
`;
        const { models, failures } = auditPrismaE2eeModels(fixture);
        expect(models).toEqual(['E2eeDevice']);
        expect(failures.length).toBe(1);
        expect(failures[0]).toMatch(/Bytes column/);
    });

    test('a schema with NO E2EE models MUST fail — an audit that inspects nothing is a failed audit', () => {
        const fixture = `
model User {
  id        String  @id @default(uuid())
  username  String
  privateKey String @db.VarChar(100)
}
`;
        const { models, failures } = auditPrismaE2eeModels(fixture);
        expect(models).toEqual([]);
        expect(failures.length).toBe(1);
        expect(failures[0]).toMatch(/no E2EE model blocks were found/);
    });

    test('comments mentioning "private" do NOT false-positive — only field declarations are scanned', () => {
        const fixture = `
model E2eeOneTimePreKey {
  id        String  @id @default(uuid())
  userId    Int
  // PRIVATE KEY NEVER UPLOADED — the private half lives on the device only
  publicKey String  @db.VarChar(100)
  /* a block comment explaining that no secret material is stored */
  isUsed    Boolean @default(false)
}
`;
        const { models, failures } = auditPrismaE2eeModels(fixture);
        expect(models).toEqual(['E2eeOneTimePreKey']);
        expect(failures).toEqual([]);
    });
});
