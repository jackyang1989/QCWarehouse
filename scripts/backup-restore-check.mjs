#!/usr/bin/env node
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/qcwarehouse";

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const started = Date.now();
    const dbMetaRes = await client.query("select current_database() database_name");
    const dbLatencyMs = Math.max(0, Date.now() - started);
    const countsRes = await client.query(`
      select
        (select count(*)::int from users) users_count,
        (select count(*)::int from orders) orders_count,
        (select count(*)::int from warehouse_items) items_count,
        (select count(*)::int from payments) payments_count,
        (select count(*)::int from report_versions where state='published') published_reports_count,
        (select count(*)::int from audit_events) audit_events_count,
        (select count(*)::int from outbox_events where processed_at is null and attempts=0) pending_jobs_count,
        (select count(*)::int from outbox_events where processed_at is null and attempts>0 and attempts<5) retrying_jobs_count,
        (select count(*)::int from outbox_events where processed_at is null and attempts>=5) exhausted_jobs_count,
        (select count(*)::int from private_files) private_files_count,
        (select coalesce(sum(octet_length(data)),0)::bigint from private_files)::double precision private_files_bytes
    `);
    const migrationsRes = await client.query("select name from qc_migrations order by name desc");
    const triggersRes = await client.query(`
      select tgname from pg_trigger
      where not tgisinternal
        and tgname in ('immutable_audit','immutable_logistics','freeze_report','freeze_template','freeze_inspection_quote')
      order by tgname
    `);
    const runsRes = await client.query(`
      select id, restored_to, started_at, finished_at, reconciliation
      from recovery_runs
      order by started_at desc
      limit 10
    `);
    const counts = countsRes.rows[0];
    const migrations = migrationsRes.rows.map((r) => r.name);
    const triggers = triggersRes.rows.map((r) => r.tgname);
    const latestRealRestore = runsRes.rows.find(
      (r) =>
        r.reconciliation?.evidence_mode === "real_isolated_restore" &&
        r.reconciliation?.isolated_environment === true &&
        r.reconciliation?.production_verified === true
    );
    const checks = {
      database: { status: "operational", latency_ms: dbLatencyMs, database_name: dbMetaRes.rows[0]?.database_name ?? null },
      migrations: {
        status: migrations.length >= 13 ? "operational" : migrations.length > 0 ? "degraded" : "unavailable",
        applied_count: migrations.length,
        latest_migration: migrations[0] ?? null,
      },
      immutable_triggers: {
        status: triggers.length === 5 ? "operational" : "unavailable",
        count: triggers.length,
        expected: 5,
        triggers,
      },
      outbox_queue: {
        status: counts.exhausted_jobs_count === 0 ? "operational" : "degraded",
        pending_count: counts.pending_jobs_count,
        retrying_count: counts.retrying_jobs_count,
        exhausted_count: counts.exhausted_jobs_count,
      },
      media_storage: {
        status: "degraded",
        backend: "postgres_private_files_legacy",
        object_count: counts.private_files_count,
        total_bytes: counts.private_files_bytes,
      },
      backup_restore: {
        status: latestRealRestore ? "operational" : "unknown",
        last_verified_at: latestRealRestore ? latestRealRestore.finished_at ?? latestRealRestore.started_at : null,
        last_backup_reference: latestRealRestore?.reconciliation?.backup_reference ?? null,
        manifest_sha256: latestRealRestore?.reconciliation?.manifest_sha256 ?? null,
      },
    };
    const overallStatus =
      checks.immutable_triggers.status === "unavailable" || checks.migrations.status === "unavailable"
        ? "unavailable"
        : checks.outbox_queue.status === "degraded" || checks.migrations.status === "degraded"
          ? "degraded"
          : "operational";
    const healthy =
      checks.database.status === "operational" &&
      checks.migrations.status === "operational" &&
      checks.immutable_triggers.status === "operational" &&
      checks.outbox_queue.status === "operational";
    const summary = {
      checked_at: new Date().toISOString(),
      healthy,
      overall_status: overallStatus,
      counts: { ...counts, applied_migrations_count: migrations.length },
      checks,
      immutable_triggers: triggers,
      recent_recovery_runs: runsRes.rows.slice(0, 5),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!healthy) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Backup/restore check failed:", err);
  process.exit(1);
});
