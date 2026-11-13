// infra/lib/authority-default-acl.js
// §WP-H — DEFAULT PRIVILEGES ARE A LATENT GRANT PATH.
//
// pg_default_acl decides what FUTURE objects created by this role will grant.
// A poisoned entry (ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO other)
// survives every direct-object revoke, because the objects it applies to do not
// exist yet. It is reconciled and verified here, globally and per schema.
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const oidSub = () => "(SELECT oid FROM pg_roles WHERE rolname = $1)";

const ACL_KINDS = { r: 'TABLES', S: 'SEQUENCES', f: 'FUNCTIONS', T: 'TYPES' };

async function revokeDefaultPrivileges(prisma, role, applied) {
    const rows = await prisma.$queryRawUnsafe(`
        SELECT n.nspname, d.defaclobjtype,
               pg_get_userbyid(a.grantee) AS grantee
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         WHERE d.defaclrole = ${oidSub()}
           AND a.grantee <> ${oidSub()}
         GROUP BY 1,2,3`, role);
    let count = 0;
    for (const r of rows || []) {
        const kind = ACL_KINDS[r.defaclobjtype];
        if (!kind) continue;
        const scope = r.nspname ? ` IN SCHEMA ${q(r.nspname)}` : '';
        const grantee = r.grantee === null ? 'PUBLIC' : q(r.grantee);
        await prisma.$executeRawUnsafe(
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(role)}${scope} REVOKE ALL ON ${kind} FROM ${grantee}`);
        applied.push(`revoked default ${kind}${scope || ' (global)'} from ${grantee || 'PUBLIC'}`);
        count += 1;
    }
    return count;
}

async function inspectDefaultPrivileges(prisma, role, problems) {
    const rows = await prisma.$queryRawUnsafe(`
        SELECT coalesce(n.nspname, '(global)') AS scope, d.defaclobjtype,
               coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') AS grantee,
               a.privilege_type
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         WHERE d.defaclrole = ${oidSub()}
           AND a.grantee <> ${oidSub()}
         ORDER BY 1,2,3,4`, role);
    for (const r of rows || []) {
        problems.push(`role ${role} grants default ${r.privilege_type} on ${r.defaclobjtype} in ${r.scope} to ${r.grantee}`);
    }
    return { entries: rows || [] };
}

module.exports = { revokeDefaultPrivileges, inspectDefaultPrivileges, ACL_KINDS };
