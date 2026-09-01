# Database backup and recovery

## What is tested in this repository

CI runs a disposable PostgreSQL recovery drill after the normal Jest suite. The drill:

1. creates a sentinel record in a dedicated `backup_drill` schema;
2. creates a PostgreSQL custom-format logical dump with `pg_dump`;
3. validates that the archive is readable with `pg_restore --list`;
4. creates a fresh disposable PostgreSQL database;
5. restores the archive with `pg_restore --exit-on-error`;
6. verifies the sentinel and confirms application tables were restored; and
7. removes the sentinel schema, restore database, and temporary archive.

The drill normalizes Prisma's optional `schema` query parameter before calling PostgreSQL CLI tools because `psql`/`pg_dump` do not accept that Prisma-specific parameter.

The manual command is:

```bash
DATABASE_URL="$TEST_DATABASE_URL" \
PG_ADMIN_URL="postgres://<user>:<password>@<host>:<port>/postgres" \
BACKUP_DRILL_ALLOW_MUTATION=1 \
npm run db:recovery-drill
```

Only run the drill against a disposable/test source database. The explicit
`BACKUP_DRILL_ALLOW_MUTATION=1` requirement exists because the drill creates and
removes its sentinel schema in the source database.

## What this does not provide

A logical `pg_dump` is an archival/restore mechanism, not continuous disaster
recovery. It does not provide PostgreSQL WAL-based point-in-time recovery.
Production infrastructure should separately provide:

- encrypted off-host backup storage;
- retention and deletion policies appropriate to financial data;
- regular restore drills against isolated infrastructure;
- continuous WAL archiving/PITR when the production recovery objectives require it;
- alerts when backups or WAL archiving stop succeeding; and
- documented recovery ownership, RPO, RTO, and escalation procedures.

The repository-level drill proves that the current schema and data can be
serialized and restored into a fresh PostgreSQL database. The production
infrastructure layer remains responsible for backup retention, isolation, and
PITR.
