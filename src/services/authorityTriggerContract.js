// src/services/authorityTriggerContract.js
// =============================================================================
// §WP-H — THE CANONICAL IMMUTABILITY TRIGGER IMPLEMENTATION.
//
// WHY THIS FILE EXISTS
// The activation boundary is only as strong as the trigger FUNCTION BODY. An
// earlier revision verified trigger names, enabled state, event/timing, tgfoid
// and ownership — every one of which survives an attacker replacing the body of
// public.azm_authority_activation_immutable() in place, keeping its OID, name
// and owner. The triggers then still "exist" and still point at the same
// function, and an UPDATE against the protected record succeeds.
//
// WHAT IS COMPARED
// The exact source text PostgreSQL stores in pg_proc.prosrc, which is the text
// between the dollar quotes of the shipped CREATE FUNCTION. It is compared
// byte-for-byte on BOTH sides of the boundary:
//   • the runtime inspection (src/services/authorityActivationEnforcement.js)
//     turns any difference into TRIGGER_IMPLEMENTATION_DRIFT, which keeps the
//     authority state UNKNOWN;
//   • the sanctioned activation function carries the same text (substituted at
//     install time from this module, not copied by hand) and refuses before it
//     writes anything.
//
// No database-side digest function is assumed: no pgcrypto, no sha256() in SQL.
// The SQL side compares TEXT TO TEXT, so it works on a stock PostgreSQL.
//
// THIS CONSTANT IS NOT THE SOURCE OF TRUTH
// The shipped migration is. __tests__/wp-h-authority-policy-drift.test.js
// extracts the body from the migration file and fails if this copy drifts, so a
// migration edit cannot silently leave an obsolete implementation behind.
// =============================================================================
"use strict";

const crypto = require("crypto");

/** Exactly the body the shipped migration installs. */
const CANONICAL_TRIGGER_SOURCE = "\nBEGIN\n  RAISE EXCEPTION 'FiatLiquidityAuthorityActivation is append-only: % is refused', TG_OP\n    USING ERRCODE = 'insufficient_privilege',\n          HINT = 'Activation is a one-time control decision recorded under a separate database authority.';\nEND;\n";

/** sha256 of the canonical body, for diagnostics and for the runtime comparison. */
const TRIGGER_SOURCE_SHA256 = "4cf4c00fc9910b203f06443fcdd6b57f724f206b46199f0e4d2d0a3412a03862";

const TRIGGER_FUNCTION_SCHEMA = "public";
const TRIGGER_FUNCTION_NAME = "azm_authority_activation_immutable";
const TRIGGER_FUNCTION_REGPROCEDURE = "public.azm_authority_activation_immutable()";
const TRIGGER_FUNCTION_LANGUAGE = "plpgsql";

const digestOfTriggerSource = (source) =>
    crypto.createHash("sha256").update(String(source == null ? "" : source), "utf8").digest("hex");

/**
 * True only when the catalog text is the canonical implementation.
 * A null/absent body is a mismatch, never a pass.
 */
const isCanonicalTriggerSource = (source) =>
    typeof source === "string" && source === CANONICAL_TRIGGER_SOURCE;

module.exports = {
    CANONICAL_TRIGGER_SOURCE,
    TRIGGER_SOURCE_SHA256,
    TRIGGER_FUNCTION_SCHEMA,
    TRIGGER_FUNCTION_NAME,
    TRIGGER_FUNCTION_REGPROCEDURE,
    TRIGGER_FUNCTION_LANGUAGE,
    digestOfTriggerSource,
    isCanonicalTriggerSource,
};
