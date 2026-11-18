// infra/lib/authority-roles.js
// §WP-H — ONE authoritative resolver for the authority role identities.
//
// PRECEDENCE (highest first), identical for every entry point:
//   1. an explicit option (programmatic caller or CLI flag)
//   2. a configured environment value
//   3. the canonical default, with the function owner derived from the owner
//
// No entry point may invent its own default: a boundary whose two halves are
// named by different defaults is two boundaries.
const CANONICAL = {
    owner: 'azm_authority_owner',
    runtime: 'azm_app_runtime',
    operator: 'azm_authority_operator',
};

const ENV = {
    owner: 'AUTHORITY_OWNER_ROLE',
    runtime: 'AUTHORITY_RUNTIME_ROLE',
    operator: 'AUTHORITY_OPERATOR_ROLE',
    functionOwner: 'AUTHORITY_FN_OWNER_ROLE',
};

const pick = (explicit, envName, fallback, env) => {
    if (explicit !== undefined && explicit !== null && explicit !== '') return String(explicit);
    const configured = env && env[envName];
    if (configured !== undefined && configured !== null && configured !== '') return String(configured);
    return fallback;
};

/**
 * Resolve the four trusted identities.
 * @returns {{owner:string, runtime:string, operator:string, functionOwner:string, sources:object}}
 */
function resolveAuthorityRoles(options = {}, env = process.env) {
    const owner = pick(options.owner, ENV.owner, CANONICAL.owner, env);
    // Derived, not separately defaulted: the function owner belongs to THIS owner.
    const functionFallback = `${owner}_fn`;
    return {
        owner,
        runtime: pick(options.runtime, ENV.runtime, CANONICAL.runtime, env),
        operator: pick(options.operator, ENV.operator, CANONICAL.operator, env),
        functionOwner: pick(options.functionOwner, ENV.functionOwner, functionFallback, env),
        sources: {
            owner: options.owner ? 'option' : (env && env[ENV.owner] ? 'env' : 'default'),
            functionOwner: options.functionOwner ? 'option' : (env && env[ENV.functionOwner] ? 'env' : 'derived'),
        },
    };
}

/** Distinctness is a property of the boundary, not of one installer. */
function assertDistinctRoles(roles) {
    const entries = Object.entries({ owner: roles.owner, runtime: roles.runtime, operator: roles.operator, functionOwner: roles.functionOwner });
    const seen = new Map();
    for (const [name, value] of entries) {
        if (seen.has(value)) {
            throw new Error(`authority roles must be distinct: ${name} and ${seen.get(value)} are both ${value}`);
        }
        seen.set(value, name);
    }
}

module.exports = { resolveAuthorityRoles, assertDistinctRoles, CANONICAL, ENV };
