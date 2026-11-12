// infra/lib/authority-function-sql.js
// §WP-H — ONE statement, therefore ONE transaction. The activation function is
// never observable to another session in an intermediate state: it cannot exist
// without its owner, without PUBLIC revoked, and without the operator's EXECUTE.
const fs = require('fs');
const path = require('path');

const FN = 'public.azm_authority_activate(text,text,text,text,text)';
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const lit = (s) => String(s).replace(/'/g, "''");

function functionSql(operator, functionOwner) {
    const template = fs.readFileSync(path.join(__dirname, '..', 'sql', 'azm_authority_activate.sql'), 'utf8');
    const body = template.replace(/\{\{OPERATOR\}\}/g, lit(operator));
    const owner = q(functionOwner);
    return `DO $ddl$ BEGIN
        EXECUTE $body$${body}$body$;
        EXECUTE $a$ALTER FUNCTION ${FN} OWNER TO ${owner}$a$;
        EXECUTE $b$REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC$b$;
        EXECUTE $c$GRANT EXECUTE ON FUNCTION ${FN} TO ${q(operator)}$c$;
        EXECUTE $d$REVOKE ALL ON FUNCTION ${FN} FROM ${q(operator)}$d$;
        EXECUTE $e$GRANT EXECUTE ON FUNCTION ${FN} TO ${q(operator)}$e$;
        EXECUTE $f$GRANT USAGE ON SCHEMA public TO ${owner}$f$;
        EXECUTE $g$GRANT SELECT, INSERT ON TABLE public."FiatLiquidityAuthorityActivation" TO ${owner}$g$;
        EXECUTE $h$GRANT SELECT ON TABLE public."FiatLiquidityState" TO ${owner}$h$;
        EXECUTE $i$GRANT UPDATE ("authorityActivatedAt") ON TABLE public."FiatLiquidityState" TO ${owner}$i$;
        EXECUTE $j$GRANT SELECT ON TABLE public."GlobalSettings" TO ${owner}$j$;
        EXECUTE $k$GRANT UPDATE ("fiatLiquidityAuthorityEnabled") ON TABLE public."GlobalSettings" TO ${owner}$k$;
        EXECUTE $l$GRANT SELECT, UPDATE ("balance") ON TABLE public."SystemFiatPool" TO ${owner}$l$;
        EXECUTE $m$GRANT SELECT ON TABLE public."Withdrawal" TO ${owner}$m$;
        EXECUTE $n$GRANT SELECT ON TABLE public."TransactionHistory" TO ${owner}$n$;
        EXECUTE $o$GRANT SELECT ON TABLE public."FiatLiquidityReservation" TO ${owner}$o$;
        EXECUTE $p$GRANT INSERT ON TABLE public."AdminSettingsAuditLog" TO ${owner}$p$;
    END $ddl$;`;
}

module.exports = { functionSql, FN };
