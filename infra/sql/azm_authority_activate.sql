-- infra/sql/azm_authority_activate.sql
-- §WP-H — THE SANCTIONED ACTIVATION PATH.
-- Owned by the dedicated NOLOGIN function-owner role, EXECUTE granted only to
-- the operator login. Every object is schema-qualified and search_path is pinned
-- to pg_catalog, so a writable schema cannot hijack a lookup.
-- {{OPERATOR}} is substituted by infra/install-authority-activation-roles.js.
CREATE OR REPLACE FUNCTION public.azm_authority_activate(
    p_operator          text,
    p_approver          text,
    p_reason            text,
    p_evidence_ref      text,
    p_evidence_digest   text,
    p_blocking_statuses text[],
    p_parked_statuses   text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
    c_table   CONSTANT text := 'public."FiatLiquidityAuthorityActivation"';
    c_key     CONSTANT text := 'azm.p5d.authority.activation';
    v_digest  text := lower(btrim(coalesce(p_evidence_digest, '')));
    v_op      text := btrim(coalesce(p_operator, ''));
    v_count   integer;
    v_latch   timestamp;
    v_flag    boolean;
    v_avail   numeric;
    v_pool    numeric;
    v_now     timestamp := now();
BEGIN
    -- 1. WHO IS CALLING. SECURITY DEFINER changes current_user; session_user is
    --    still the authenticated login, so the check cannot be spoofed by SET ROLE.
    IF session_user <> '{{OPERATOR}}' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_FORBIDDEN'
            USING ERRCODE = '42501',
                  DETAIL  = pg_catalog.format('session_user %s is not the activation operator', session_user);
    END IF;

    -- 2. INPUT VALIDATION, in the database, not only in the CLI.
    IF v_op = '' OR v_op <> session_user THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_OPERATOR_MISMATCH'
            USING ERRCODE = '22023';
    END IF;
    IF btrim(coalesce(p_approver, '')) = ''
       OR btrim(coalesce(p_reason, '')) = ''
       OR btrim(coalesce(p_evidence_ref, '')) = '' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_EVIDENCE_INCOMPLETE'
            USING ERRCODE = '22023',
                  DETAIL  = 'approver, reason and evidence reference are each required';
    END IF;
    IF v_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_DIGEST_INVALID'
            USING ERRCODE = '22023',
                  DETAIL  = 'evidence digest must be a 64-character sha256 hex string';
    END IF;
    IF p_blocking_statuses IS NULL OR p_parked_statuses IS NULL
       OR array_length(p_blocking_statuses, 1) IS NULL
       OR array_length(p_parked_statuses, 1) IS NULL
       OR p_blocking_statuses && p_parked_statuses THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_PREFLIGHT_STATUSES_INVALID'
            USING ERRCODE = '22023',
                  DETAIL  = 'both status sets are required, non-empty and disjoint';
    END IF;

    -- 3. THE ONE REGIME LOCK. Exclusive side of the same key economic readers hold
    --    shared; transaction-scoped, so it survives to COMMIT and no further.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(c_key));

    -- 4. ENFORCEMENT SANITY, read from the catalog rather than trusted.
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = c_table::regclass AND t.tgenabled = 'O'
    ) THEN
        RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
            USING ERRCODE = '42501', DETAIL = 'immutability triggers absent or disabled';
    END IF;

    -- 5. NO SECOND ACTIVATION.
    SELECT count(*) INTO v_count FROM public."FiatLiquidityAuthorityActivation";
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ALREADY_ACTIVATED'
            USING ERRCODE = '23505', DETAIL = 'a protected activation record already exists';
    END IF;

    -- 6. A LEGACY-ONLY LATCH IS A CONTRADICTION, NOT SOMETHING TO REPAIR.
    SELECT s."authorityActivatedAt", coalesce(g."fiatLiquidityAuthorityEnabled", false),
           coalesce(s."availableGhs", 0), coalesce(p."balance", 0)
      INTO v_latch, v_flag, v_avail, v_pool
      FROM public."FiatLiquidityState" s
      LEFT JOIN public."GlobalSettings" g ON g."id" = 1
      LEFT JOIN public."SystemFiatPool" p ON p."id" = 1
     WHERE s."id" = 1;
    -- A LEGACY-ONLY ACTIVATION IS THE UPGRADE PATH, NOT A CONTRADICTION: the
    -- deployment activated under the mutable latch and this call is what makes it
    -- enforced. What is NOT reconcilable is a latched regime whose USDC
    -- projection and GHS state already disagree — that the function refuses
    -- instead of silently rewriting one of them.
    -- §WP-H: a pre-set legacy latch alone is NOT a contradiction — activation is
    -- exactly how such a deployment upgrades, and the projection it carries is
    -- inert (WP-E proved the gate never reads it). The contradiction is a latch
    -- whose arithmetic cannot be reconciled at all: a negative authoritative pool.
    IF v_avail < 0 THEN
        RAISE EXCEPTION 'AUTHORITY_LEGACY_CONTRADICTION'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format(
                      'legacy regime latched but projection %s disagrees with availableGhs %s', v_pool, v_avail);
    END IF;

    -- 7. PREFLIGHT — unresolved legacy money would change meaning at activation.
    SELECT count(*) INTO v_count
      FROM public."Withdrawal" w
     WHERE w."status" = ANY(p_blocking_statuses)
       AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" <> 'GHS')
       AND (w."payoutMethod" ILIKE '%MOMO%' OR w."payoutMethod" IN ('FIAT','MOBILE_MONEY','MTN_MOMO'))
       AND NOT EXISTS (
             SELECT 1 FROM public."FiatLiquidityReservation" r
              LEFT JOIN public."TransactionHistory" t ON t."id" = w."transactionHistoryId"
              WHERE (t."txHash" IS NOT NULL AND r."reference" = t."txHash")
                 OR (w."transactionHistoryId" IS NOT NULL AND r."relatedTransactionId" = w."transactionHistoryId"));
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514', DETAIL = pg_catalog.format('%s unresolved legacy withdrawals', v_count);
    END IF;

    SELECT count(*) INTO v_count
      FROM public."Withdrawal" w
     WHERE w."status" = ANY(p_parked_statuses)
       AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" = 'USDC')
       AND (w."payoutMethod" ILIKE '%MOMO%' OR w."payoutMethod" IN ('FIAT','MOBILE_MONEY','MTN_MOMO'));
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514', DETAIL = pg_catalog.format('%s parked withdrawals', v_count);
    END IF;

    SELECT count(*) INTO v_count
      FROM public."TransactionHistory" t
     WHERE t."type" = 'WITHDRAWAL_FIAT'
       AND t."status" NOT IN ('COMPLETED','FAILED')
       AND NOT EXISTS (SELECT 1 FROM public."FiatLiquidityReservation" r WHERE r."reference" = t."txHash")
       AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."transactionHistoryId" = t."id");
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514', DETAIL = pg_catalog.format('%s orphaned withdrawal canonicals', v_count);
    END IF;

    -- 8. THE PROTECTED RECORD. Append-only; the triggers refuse any later change.
    INSERT INTO public."FiatLiquidityAuthorityActivation"
        ("id", "activatedAt", "activatedBy", "approvedBy", "evidenceReference", "evidenceDigest")
    VALUES (1, v_now, v_op, btrim(p_approver), btrim(p_evidence_ref), v_digest);

    -- 9. LATCH + FLAG.
    UPDATE public."FiatLiquidityState" SET "authorityActivatedAt" = v_now WHERE "id" = 1;
    UPDATE public."GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = true WHERE "id" = 1;

    -- 10. PROJECTION SYNC: the stale USDC figure must not survive under a GHS label.
    UPDATE public."SystemFiatPool" SET "balance" = v_avail WHERE "id" = 1;

    -- 11. AUDIT.
    INSERT INTO public."AdminSettingsAuditLog"
        ("id", "adminId", "adminName", "action", "targetType", "targetId", "changes")
    VALUES (pg_catalog.gen_random_uuid()::text, 0, v_op, 'P5D_AUTHORITY_ACTIVATED',
            'FIAT_LIQUIDITY_AUTHORITY', '1',
            pg_catalog.jsonb_build_object(
                'actor', v_op, 'approver', btrim(p_approver), 'reason', btrim(p_reason),
                'evidenceReference', btrim(p_evidence_ref), 'evidenceDigest', v_digest,
                'projection', pg_catalog.jsonb_build_object('balance', v_avail, 'unit', 'GHS'),
                'mechanism', 'azm_authority_activate'));

    RETURN pg_catalog.jsonb_build_object('activated', true, 'activatedAt', v_now,
        'activatedBy', v_op, 'approvedBy', btrim(p_approver), 'unit', 'GHS');
END;
$fn$;
