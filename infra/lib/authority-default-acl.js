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
               -- grantee OID 0 is PUBLIC, a pseudo-role that has no pg_roles entry.
               -- pg_get_userbyid(0) is NULL, and quoting 'PUBLIC' as an identifier
               -- would look for a role literally named PUBLIC and fail.
               CASE WHEN a.grantee = 0::oid THEN 'PUBLIC'
                    ELSE pg_get_userbyid(a.grantee) END AS grantee,
               CASE WHEN a.grantee = 0::oid THEN true ELSE false END AS is_public,
               min(a.grantee::text) AS grantee_oid
          FROM pg_default_acl d
          LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         WHERE d.defaclrole = ${oidSub()}
           AND a.grantee <> ${oidSub()}
         GROUP BY 1,2,3,4`, role);
    let count = 0;
    for (const r of rows || []) {
        const kind = ACL_KINDS[r.defaclobjtype];
        if (!kind) continue;
        const scope = r.nspname ? ` IN SCHEMA ${q(r.nspname)}` : '';
        const grantee = r.is_public || r.grantee === null || r.grantee === 'PUBLIC' ? 'PUBLIC' : q(r.grantee);
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
               CASE WHEN a.grantee = 0::oid THEN 'PUBLIC'
                    ELSE coalesce(pg_get_userbyid(a.grantee), a.grantee::text) END AS grantee,
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
