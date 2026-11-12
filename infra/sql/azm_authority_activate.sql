-- infra/sql/azm_authority_activate.sql
-- §WP-H — THE SANCTIONED ACTIVATION PATH.
--
-- Owned by a dedicated NOLOGIN function-owner role; EXECUTE granted only to the
-- operator login named at install time. SECURITY DEFINER with search_path pinned
-- to pg_catalog and every application object schema-qualified.
--
-- HARDENING (slice 5):
--   • the preflight status policy is CANONICAL and HARD-CODED here. The caller
--     cannot narrow it: there are no status parameters at all.
--   • all three immutability triggers must exist, be enabled, be BEFORE and
--     event-correct, invoke the immutable function, and that function must be
--     owned by the protected table's owner.
--   • the three singleton rows are required; a missing one refuses instead of
--     silently becoming zero.
--   • every write asserts exactly one affected row, so a partial or ambiguous
--     update aborts the whole activation.

CREATE OR REPLACE FUNCTION public.azm_authority_activate(
    p_operator          text,
    p_approver          text,
    p_reason            text,
    p_evidence_ref      text,
    p_evidence_digest   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
    c_key        constant text := 'azm.p5d.authority.activation';
    c_table      constant text := 'public."FiatLiquidityAuthorityActivation"';
    c_trigger_fn constant text := 'public.azm_authority_activation_immutable()';
    -- CANONICAL. Mirrors fiatLiquidityActivationService.js exactly; the drift is
    -- caught by __tests__/wp-h-authority-policy-drift.test.js.
    c_blocking   constant text[] := ARRAY['PENDING','APPROVED','PROCESSING','IN_TRANSIT','UNKNOWN','AWAITING_PROVIDER','PENDING_PROVIDER'];
    c_parked     constant text[] := ARRAY['NEEDS_MANUAL_REVIEW'];
    c_triggers   constant text[] := ARRAY[
        'FiatLiquidityAuthorityActivation_no_update',
        'FiatLiquidityAuthorityActivation_no_delete',
        'FiatLiquidityAuthorityActivation_no_truncate'
    ];
    v_digest     text;
    v_count      int;
    v_rows       int;
    v_names      text;
    v_enabled    "char";
    v_tgtype     smallint;
    v_tgfoid     oid;
    v_fn_owner   text;
    v_tbl_owner  text;
    v_latch      timestamptz;
    v_flag       boolean;
    v_avail      numeric;
    v_pool       numeric;
    v_now        timestamptz := pg_catalog.now();
BEGIN
    -- 1. CALLER. SECURITY DEFINER rewrites current_user, not session_user.
    IF session_user <> '{{OPERATOR}}' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_FORBIDDEN'
            USING ERRCODE = '42501',
                  DETAIL  = pg_catalog.format('caller %s is not the activation operator', session_user);
    END IF;

    -- 2. INPUT. Validated here, not only in the CLI.
    v_digest := pg_catalog.lower(pg_catalog.btrim(coalesce(p_evidence_digest, '')));
    IF pg_catalog.btrim(coalesce(p_operator, '')) = ''
       OR p_operator <> session_user THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_OPERATOR_INVALID'
            USING ERRCODE = '22023',
                  DETAIL  = 'operator must identify the authenticated activation login';
    END IF;
    IF pg_catalog.btrim(coalesce(p_approver, '')) = ''
       OR pg_catalog.btrim(coalesce(p_reason, '')) = ''
       OR pg_catalog.btrim(coalesce(p_evidence_ref, '')) = '' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_INPUT_INVALID'
            USING ERRCODE = '22023',
                  DETAIL  = 'approver, reason and evidence reference are each required';
    END IF;
    IF v_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_DIGEST_INVALID'
            USING ERRCODE = '22023',
                  DETAIL  = 'evidence digest must be a 64-character sha256 hex string';
    END IF;

    -- 3. THE ONE REGIME LOCK — exclusive side of the key economic readers hold
    --    shared. Transaction-scoped: it survives to COMMIT and no further.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(c_key));

    -- 4. IMMUTABILITY. All three triggers, verified individually.
    SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_tbl_owner
      FROM pg_catalog.pg_class c WHERE c.oid = c_table::regclass;
    IF v_tbl_owner IS NULL THEN
        RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
            USING ERRCODE = '42501', DETAIL = 'the protected activation table is absent';
    END IF;

    FOREACH v_names IN ARRAY c_triggers LOOP
        SELECT t.tgenabled, t.tgtype, t.tgfoid
          INTO v_enabled, v_tgtype, v_tgfoid
          FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = c_table::regclass AND t.tgname = v_names;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s is absent', v_names);
        END IF;
        IF v_enabled <> 'O' THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s is not enabled', v_names);
        END IF;
        IF (v_tgtype & 2) = 0 THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s is not a BEFORE trigger', v_names);
        END IF;
        IF v_names LIKE '%\_no\_update' AND (v_tgtype & 16) = 0 THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s does not fire on UPDATE', v_names);
        END IF;
        IF v_names LIKE '%\_no\_delete' AND (v_tgtype & 8) = 0 THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s does not fire on DELETE', v_names);
        END IF;
        IF v_names LIKE '%\_no\_truncate' AND (v_tgtype & 32) = 0 THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s does not fire on TRUNCATE', v_names);
        END IF;
        IF v_tgfoid <> c_trigger_fn::regprocedure THEN
            RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
                USING ERRCODE = '42501', DETAIL = pg_catalog.format('trigger %s invokes a substituted function', v_names);
        END IF;
    END LOOP;

    SELECT pg_catalog.pg_get_userbyid(p.proowner) INTO v_fn_owner
      FROM pg_catalog.pg_proc p WHERE p.oid = c_trigger_fn::regprocedure;
    IF v_fn_owner IS DISTINCT FROM v_tbl_owner THEN
        RAISE EXCEPTION 'AUTHORITY_ENFORCEMENT_NOT_ESTABLISHED'
            USING ERRCODE = '42501',
                  DETAIL  = pg_catalog.format('trigger function owner %s is not the protected table owner %s',
                                              v_fn_owner, v_tbl_owner);
    END IF;

    -- 5. REQUIRED SINGLETONS. Absence refuses; it never becomes zero.
    SELECT count(*) INTO v_count FROM public."FiatLiquidityState" WHERE "id" = 1;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_SINGLETON_MISSING'
            USING ERRCODE = '23514', DETAIL = 'FiatLiquidityState singleton row is required before activation';
    END IF;
    SELECT count(*) INTO v_count FROM public."GlobalSettings" WHERE "id" = 1;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_SINGLETON_MISSING'
            USING ERRCODE = '23514', DETAIL = 'GlobalSettings singleton row is required before activation';
    END IF;
    SELECT count(*) INTO v_count FROM public."SystemFiatPool" WHERE "id" = 1;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_SINGLETON_MISSING'
            USING ERRCODE = '23514', DETAIL = 'SystemFiatPool singleton row is required before activation';
    END IF;

    -- 6. NO SECOND ACTIVATION.
    SELECT count(*) INTO v_count FROM public."FiatLiquidityAuthorityActivation";
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ALREADY_ACTIVATED'
            USING ERRCODE = '23505', DETAIL = 'a protected activation record already exists';
    END IF;

    -- 7. READ THE AUTHORITATIVE STATE — all three rows are now known present.
    SELECT s."authorityActivatedAt", g."fiatLiquidityAuthorityEnabled",
           s."availableGhs", p."balance"
      INTO v_latch, v_flag, v_avail, v_pool
      FROM public."FiatLiquidityState" s
      JOIN public."GlobalSettings" g ON g."id" = 1
      JOIN public."SystemFiatPool" p ON p."id" = 1
     WHERE s."id" = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AUTHORITY_SINGLETON_MISSING'
            USING ERRCODE = '23514', DETAIL = 'authoritative state rows could not be read as one row';
    END IF;
    -- A pre-set legacy latch is the UPGRADE path, not a contradiction: WP-E
    -- proved the projection is inert and activation is what replaces it. Only an
    -- arithmetically impossible pool refuses.
    IF v_avail < 0 THEN
        RAISE EXCEPTION 'AUTHORITY_LEGACY_CONTRADICTION'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('availableGhs %s is negative', v_avail);
    END IF;

    -- 8. PREFLIGHT — canonical policy, not caller policy.
    SELECT count(*) INTO v_count
      FROM public."Withdrawal" w
     WHERE w."status"::text = ANY(c_blocking)
       AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" <> 'GHS')
       AND (w."payoutMethod" ILIKE '%MOMO%' OR w."payoutMethod" IN ('FIAT','MOBILE_MONEY','MTN_MOMO'))
       AND NOT EXISTS (
            SELECT 1 FROM public."FiatLiquidityReservation" r
              LEFT JOIN public."TransactionHistory" t ON t."id" = w."transactionHistoryId"
             WHERE (t."txHash" IS NOT NULL AND r."reference" = t."txHash")
                OR (w."transactionHistoryId" IS NOT NULL AND r."relatedTransactionId" = w."transactionHistoryId"));
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('%s unresolved legacy withdrawal(s) have no GHS reservation', v_count);
    END IF;

    SELECT count(*) INTO v_count
      FROM public."Withdrawal" w
     WHERE w."status"::text = ANY(c_parked)
       AND (w."settlementCurrency" IS NULL OR w."settlementCurrency" = 'USDC')
       AND (w."payoutMethod" ILIKE '%MOMO%' OR w."payoutMethod" IN ('FIAT','MOBILE_MONEY','MTN_MOMO'));
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('%s parked legacy withdrawal(s) must be resolved first', v_count);
    END IF;

    SELECT count(*) INTO v_count
      FROM public."TransactionHistory" t
     WHERE t."status"::text = ANY(c_blocking)
       AND t."type"::text IN ('FIAT_DEPOSIT','FIAT_WITHDRAWAL','MOMO_DEPOSIT','MOMO_WITHDRAWAL')
       AND NOT EXISTS (SELECT 1 FROM public."FiatLiquidityReservation" r WHERE r."reference" = t."txHash")
       AND NOT EXISTS (SELECT 1 FROM public."Withdrawal" w WHERE w."transactionHistoryId" = t."id");
    IF v_count > 0 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_BLOCKED'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('%s orphaned legacy ledger row(s) have no reservation', v_count);
    END IF;

    -- 9. WRITE. Every step asserts exactly one affected row.
    INSERT INTO public."FiatLiquidityAuthorityActivation"
        ("id","activatedAt","activatedBy","approvedBy","evidenceReference","evidenceDigest")
    VALUES (1, v_now, p_operator, p_approver, p_evidence_ref, v_digest);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_ROWCOUNT'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('activation record insert affected %s rows, expected 1', v_rows);
    END IF;

    UPDATE public."FiatLiquidityState" SET "authorityActivatedAt" = v_now WHERE "id" = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_ROWCOUNT'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('FiatLiquidityState update affected %s rows, expected 1', v_rows);
    END IF;

    UPDATE public."GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = true WHERE "id" = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_ROWCOUNT'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('GlobalSettings update affected %s rows, expected 1', v_rows);
    END IF;

    UPDATE public."SystemFiatPool" SET "balance" = v_avail WHERE "id" = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_ROWCOUNT'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('SystemFiatPool update affected %s rows, expected 1', v_rows);
    END IF;

    INSERT INTO public."AdminSettingsAuditLog"
        ("id","adminId","adminName","action","targetType","targetId","changes","createdAt")
    VALUES (pg_catalog.gen_random_uuid()::text, 0, p_operator,
            'P5D_AUTHORITY_ACTIVATED', 'FIAT_LIQUIDITY_AUTHORITY', '1',
            pg_catalog.jsonb_build_object(
                'approvedBy', p_approver,
                'reason', p_reason,
                'evidenceReference', p_evidence_ref,
                'evidenceDigest', v_digest,
                'projection', pg_catalog.jsonb_build_object('balance', v_avail, 'unit', 'GHS'),
                'note', 'the digest is a fingerprint of evidence reviewable elsewhere; it does not authenticate the approver'
            ), v_now);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'AUTHORITY_ACTIVATION_ROWCOUNT'
            USING ERRCODE = '23514',
                  DETAIL  = pg_catalog.format('audit insert affected %s rows, expected 1', v_rows);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'activated', true,
        'activatedAt', v_now,
        'activatedBy', p_operator,
        'approvedBy', p_approver,
        'authorityUnit', 'GHS',
        'projectionBalance', v_avail,
        'preflight', pg_catalog.jsonb_build_object('blocking', c_blocking, 'parked', c_parked)
    );
END;
$fn$;
