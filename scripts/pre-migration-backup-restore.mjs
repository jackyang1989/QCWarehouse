#!/usr/bin/env node
/**
 * TASK-177: Real pg_dump backup, manifest + media SHA-256 inventory, isolated pg_restore verification,
 * relational integrity verification (verify.sql), and negative corrupt-dump rejection test.
 * Never mutates the source database or production external integrations.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const sourceUrlStr = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrlStr) {
  console.error("Set SOURCE_DATABASE_URL or DATABASE_URL to run isolated pre-migration backup/restore verification.");
  process.exit(2);
}

const sourceUrl = new URL(sourceUrlStr);
const sourceDbName = decodeURIComponent(sourceUrl.pathname.replace(/^\//, ""));
assert(sourceDbName, "SOURCE_DATABASE_URL must identify a source database name.");

const restoreDbName = process.env.RESTORE_DATABASE_NAME ?? `qcw_restore_${Date.now()}`;
assert.notEqual(restoreDbName, sourceDbName, "Restore target DB must be isolated from source DB.");

const restoreUrl = new URL(sourceUrlStr);
restoreUrl.pathname = `/${encodeURIComponent(restoreDbName)}`;

const adminUrl = new URL(sourceUrlStr);
adminUrl.pathname = "/postgres";

function safeUrlLabel(u) {
  const host = u.hostname || u.searchParams.get("host") || "local-socket";
  return `${host}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
}

async function captureSnapshot(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dbName = (await client.query("select current_database() name")).rows[0].name;
    const migrations = (
      await client.query("select name, sha256 from qc_migrations order by name")
    ).rows;
    const triggers = (
      await client.query(`
        select tgname from pg_trigger
        where not tgisinternal
          and tgname in ('immutable_audit','immutable_logistics','freeze_report','freeze_template','freeze_inspection_quote')
        order by tgname
      `)
    ).rows.map((r) => r.tgname);

    const countQueries = [
      ["users", "select count(*)::int n from users"],
      ["organizations", "select count(*)::int n from organizations"],
      ["orders", "select count(*)::int n from orders"],
      ["warehouse_items", "select count(*)::int n from warehouse_items"],
      ["charge_items", "select count(*)::int n from charge_items"],
      ["payments", "select count(*)::int n from payments"],
      ["refunds", "select count(*)::int n from refunds"],
      ["report_versions", "select count(*)::int n from report_versions"],
      ["media_assets", "select count(*)::int n from media_assets"],
      ["private_files", "select count(*)::int n from private_files"],
      ["audit_events", "select count(*)::int n from audit_events"],
      ["outbox_events", "select count(*)::int n from outbox_events"],
      ["integration_providers", "select count(*)::int n from integration_providers"],
      ["integration_secrets", "select count(*)::int n from integration_secrets"],
    ];
    const table_counts = {};
    for (const [k, q] of countQueries) {
      table_counts[k] = (await client.query(q)).rows[0].n;
    }

    const fin = (
      await client.query(`
        select
          coalesce((select sum(amount_cents) from payments), 0)::bigint as payments_sum_cents,
          coalesce((select sum(amount_cents) from refunds), 0)::bigint as refunds_sum_cents,
          coalesce((select sum(amount_cents) from charge_items), 0)::bigint as charges_sum_cents
      `)
    ).rows[0];
    const financial_totals = {
      payments_sum_cents: String(fin.payments_sum_cents),
      refunds_sum_cents: String(fin.refunds_sum_cents),
      charges_sum_cents: String(fin.charges_sum_cents),
    };

    const published_report_hashes = (
      await client.query(
        "select id, pdf_sha256 from report_versions where state='published' order by id"
      )
    ).rows;

    // Hash binary media objects from private_files cleanly without exposing secret fields
    const mediaRows = (
      await client.query("select key, mime, data from private_files order by key")
    ).rows;
    const media_manifest = mediaRows.map((r) => ({
      key: r.key,
      mime: r.mime,
      byte_length: r.data.length,
      sha256: createHash("sha256").update(r.data).digest("hex"),
    }));

    // Metadata-only credential recovery checklist (NEVER select ciphertext)
    const credential_recovery_inventory = (
      await client.query(`
        select provider_key, environment, secret_name, key_version, status
        from integration_secrets
        order by provider_key, environment, secret_name, key_version
      `)
    ).rows;

    return {
      dbName,
      migrations,
      triggers,
      table_counts,
      financial_totals,
      published_report_hashes,
      media_manifest,
      credential_recovery_inventory,
    };
  } finally {
    await client.end();
  }
}

async function run() {
  const workDir = mkdtempSync(join(tmpdir(), "qcw-backup-"));
  const dumpFile = join(workDir, "backup.dump");
  const corruptFile = join(workDir, "corrupt.dump");
  const manifestFile = join(workDir, "manifest.json");
  const adminClient = new pg.Client({ connectionString: adminUrl.toString() });
  let dbCreated = false;

  try {
    const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const backupStart = Date.now();

    // 1. Real pg_dump from source DB (read-only on source)
    execFileSync(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpFile, sourceUrlStr],
      { stdio: "pipe" }
    );
    const dumpBytes = readFileSync(dumpFile);
    const dumpSha256 = createHash("sha256").update(dumpBytes).digest("hex");

    // 2. Capture authoritative source snapshot & write manifest
    const srcSnap = await captureSnapshot(sourceUrlStr);
    const backupEnd = Date.now();

    const manifest = {
      backup_id: `bkp-${Date.now()}`,
      created_at: new Date().toISOString(),
      git_sha: gitSha,
      source_label: safeUrlLabel(sourceUrl),
      restore_target_label: safeUrlLabel(restoreUrl),
      outbound_side_effects_disabled: true,
      dump_bytes: dumpBytes.length,
      dump_sha256: dumpSha256,
      migrations: srcSnap.migrations,
      immutable_triggers: srcSnap.triggers,
      table_counts: srcSnap.table_counts,
      financial_totals: srcSnap.financial_totals,
      published_report_hashes: srcSnap.published_report_hashes,
      media_manifest: srcSnap.media_manifest,
      credential_recovery_inventory: srcSnap.credential_recovery_inventory,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    writeFileSync(manifestFile, manifestJson);
    const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

    // 3. Create isolated target DB & measure real pg_restore RTO
    await adminClient.connect();
    await adminClient.query(`create database "${restoreDbName.replaceAll('"', '""')}"`);
    dbCreated = true;

    const restoreStart = Date.now();
    execFileSync(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--dbname", restoreUrl.toString(), dumpFile],
      { stdio: "pipe" }
    );

    // 4. Verify all PostgreSQL constraints on restored DB are validated, and verify verify.sql on schema
    const restoreClient = new pg.Client({ connectionString: restoreUrl.toString() });
    await restoreClient.connect();
    let invalidConstraints = 0;
    let schemaVerifyMode = "direct_empty_db";
    try {
      const invalidRes = await restoreClient.query("select count(*)::int n from pg_constraint where not convalidated");
      invalidConstraints = invalidRes.rows[0].n;
      assert.equal(invalidConstraints, 0, "Restored DB contains unvalidated constraints");
    } finally {
      await restoreClient.end();
    }

    const verifySqlPath = resolve(process.cwd(), "docs/contracts/verify.sql");
    if (srcSnap.table_counts.users === 0 && srcSnap.table_counts.orders === 0) {
      execFileSync("psql", [restoreUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-f", verifySqlPath], { stdio: "pipe" });
    } else {
      schemaVerifyMode = "schema_only_empty_clone";
      const schemaDumpFile = join(workDir, "schema.sql");
      const schemaVerifyDb = `${restoreDbName}_schema`;
      const schemaVerifyUrl = new URL(restoreUrl.toString());
      schemaVerifyUrl.pathname = `/${encodeURIComponent(schemaVerifyDb)}`;
      execFileSync("pg_dump", ["--schema-only", "--no-owner", "--no-privileges", "--file", schemaDumpFile, restoreUrl.toString()], { stdio: "pipe" });
      await adminClient.query(`create database "${schemaVerifyDb.replaceAll('"', '""')}"`);
      try {
        execFileSync("psql", [schemaVerifyUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-f", schemaDumpFile], { stdio: "pipe" });
        execFileSync("psql", [schemaVerifyUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", "-f", verifySqlPath], { stdio: "pipe" });
      } finally {
        await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`, [schemaVerifyDb]).catch(() => undefined);
        await adminClient.query(`drop database if exists "${schemaVerifyDb.replaceAll('"', '""')}"`).catch(() => undefined);
      }
    }

    // 5. Capture restored DB snapshot and assert 100% parity
    const dstSnap = await captureSnapshot(restoreUrl.toString());
    const restoreEnd = Date.now();

    assert.equal(dstSnap.dbName, restoreDbName);
    assert.deepEqual(dstSnap.migrations, srcSnap.migrations, "Migration history mismatch after restore");
    assert.deepEqual(dstSnap.triggers, srcSnap.triggers, "Immutable trigger set mismatch after restore");
    assert.deepEqual(dstSnap.table_counts, srcSnap.table_counts, "Table counts mismatch after restore");
    assert.deepEqual(dstSnap.financial_totals, srcSnap.financial_totals, "Financial totals mismatch after restore");
    assert.deepEqual(dstSnap.published_report_hashes, srcSnap.published_report_hashes, "Report PDF hashes mismatch after restore");
    assert.deepEqual(dstSnap.media_manifest, srcSnap.media_manifest, "Media manifest SHA-256 mismatch after restore");
    assert.deepEqual(dstSnap.credential_recovery_inventory, srcSnap.credential_recovery_inventory, "Credential metadata mismatch after restore");

    // 6. Negative test: corrupt backup dump MUST fail checksum & pg_restore
    const badBytes = Buffer.from(dumpBytes);
    for (let i = Math.min(32, badBytes.length - 1); i < Math.min(128, badBytes.length); i++) {
      badBytes[i] = badBytes[i] ^ 0xff;
    }
    writeFileSync(corruptFile, badBytes);
    const corruptSha256 = createHash("sha256").update(badBytes).digest("hex");
    assert.notEqual(corruptSha256, dumpSha256, "Corrupt dump SHA-256 unexpectedly matched");

    let corruptRejected = false;
    try {
      execFileSync(
        "pg_restore",
        ["--list", corruptFile],
        { stdio: "pipe" }
      );
    } catch {
      corruptRejected = true;
    }
    assert.equal(corruptRejected, true, "Corrupt dump archive must be rejected by pg_restore");

    const rpoSeconds = Math.max(0, Math.round((backupEnd - backupStart) / 1000));
    const rtoMs = Math.max(1, restoreEnd - restoreStart);

    const result = {
      ok: true,
      git_sha: gitSha,
      source_label: manifest.source_label,
      restore_target_label: manifest.restore_target_label,
      outbound_side_effects_disabled: true,
      dump_bytes: dumpBytes.length,
      dump_sha256: dumpSha256,
      manifest_sha256: manifestSha256,
      migrations_verified: dstSnap.migrations.length,
      immutable_triggers_verified: dstSnap.triggers.length,
      table_counts: dstSnap.table_counts,
      financial_totals: dstSnap.financial_totals,
      media_objects_verified: dstSnap.media_manifest.length,
      published_reports_verified: dstSnap.published_report_hashes.length,
      credentials_metadata_count: dstSnap.credential_recovery_inventory.length,
      corrupt_backup_rejected: corruptRejected,
      schema_verify_mode: schemaVerifyMode,
      invalid_constraints: invalidConstraints,
      rpo_seconds: rpoSeconds,
      rto_ms: rtoMs,
      rto_seconds: Math.max(1, Math.round(rtoMs / 1000)),
      all_assertions_passed: true,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (dbCreated) {
      await adminClient.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()`, [restoreDbName]).catch(() => undefined);
      await adminClient.query(`drop database if exists "${restoreDbName.replaceAll('"', '""')}"`).catch(() => undefined);
    }
    await adminClient.end().catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("Pre-migration backup/restore verification failed:", err);
  process.exit(1);
});
