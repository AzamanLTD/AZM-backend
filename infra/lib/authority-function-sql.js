// infra/lib/authority-function-sql.js
// §WP-H — ONE statement, therefore ONE transaction. The activation function is
// never observable to another session in an intermediate state: it cannot exist
// without its owner, without PUBLIC revoked, and without the operator's EXECUTE.
const fs = require('fs');
const path = require('path');

const { CANONICAL_TRIGGER_SOURCE } = require('../../src/services/authorityTriggerContract');

const dollarQuote = (tag, text) => {
    if (String(text).includes('$' + tag + '$')) {
        throw new Error('canonical trigger source collides with the ' + tag + ' quoting tag');
    }
    return '$' + tag + '$' + text + '$' + tag + '$';
};

const FN = 'public.azm_authority_activate(text,text,text,text,text)';
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const lit = (s) => String(s).replace(/'/g, "''");

function functionSql(operator, functionOwner) {
    const template = fs.readFileSync(path.join(__dirname, '..', 'sql', 'azm_authority_activate.sql'), 'utf8');
    const body = template
        .replace(/\{\{OPERATOR\}\}/g, lit(operator))
        // The canonical trigger body is injected, never hand-copied: one edit to
        // the contract module reaches the database-side comparison unchanged.
        .replace(/\{\{CANONICAL_TRIGGER_SOURCE\}\}/g, () => dollarQuote('canon', CANONICAL_TRIGGER_SOURCE));
    const owner = q(functionOwner);
    return `DO $ddl$ BEGIN
        EXECUTE $body$${body}$body$;
        EXECUTE $a$ALTER FUNCTION ${FN} OWNER TO ${owner}$a$;
        EXECUTE $b$REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC$b$;
        EXECUTE $c$GRANT EXECUTE ON FUNCTION ${FN} TO ${q(operator)}$c$;
        EXECUTE $d$REVOKE ALL ON FUNCTION ${FN} FROM ${q(operator)}$d$;
        EXECUTE $e$GRANT EXECUTE ON FUNCTION ${FN} TO ${q(operator)}$e$;
        -- Table/schema privileges are applied separately, one statement at a time,
        -- because they depend on which tables actually exist: a database mid-restore
        -- must still get a sound, correctly-owned function rather than none.
    END $ddl$;`;
}

module.exports = { functionSql, FN };
