import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { audit, guard, hash, one, organization, Problem, role, uuid, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import {
  assertSafeExternalUrl,
  ensureIntegrationProvidersSeeded,
  recordIntegrationEvent,
  resolveProviderSecret,
  type ProviderRow,
} from "./integrations-admin";
import { isPdfBytes, validatePdfBytes } from "./media";
import { parseOcrDocument, type OcrRawBlock, type ParsedOcrDocument } from "./ocr-parser";
import type { DB } from "../db";

const execFileAsync = promisify(execFile);

interface Stage1Result {
  ok: boolean;
  provider_key: string;
  page_count: number;
  full_text: string;
  avg_confidence: number;
  blocks: OcrRawBlock[];
  latency_ms: number;
  cost_estimate_usd: number;
  error_code?: string;
  error_message?: string;
}

async function runPaddleOcr(bytes: Buffer, mime: string, config: Record<string, unknown>): Promise<Stage1Result> {
  const started = Date.now();
  const maxPages = Math.max(1, Math.min(30, Number(config.max_pages ?? 10)));
  const timeoutMs = Math.max(5000, Math.min(60000, Number(config.timeout_ms ?? 25000)));
  const ext = mime === "application/pdf" ? ".pdf" : mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
  const dir = await mkdtemp(path.join(os.tmpdir(), "qcw-ocr-"));
  const filePath = path.join(dir, `doc${ext}`);

  try {
    await writeFile(filePath, bytes);
    let stdout = "";
    try {
      const execRes = await execFileAsync(
        "python3",
        ["scripts/ocr_engine.py", "--input", filePath, "--mime", mime, "--max-pages", String(maxPages)],
        { cwd: process.cwd(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );
      stdout = execRes.stdout;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout && e.stdout.trim().startsWith("{")) {
        stdout = e.stdout;
      } else {
        return {
          ok: false,
          provider_key: "paddle_ocr",
          page_count: 1,
          full_text: "",
          avg_confidence: 0,
          blocks: [],
          latency_ms: Date.now() - started,
          cost_estimate_usd: 0,
          error_code: "PADDLE_OCR_EXEC_FAILED",
          error_message: (e.stderr || e.message || "PaddleOCR process failed").slice(0, 300),
        };
      }
    }

    const parsed = JSON.parse(stdout.trim()) as {
      ok: boolean;
      page_count?: number;
      full_text?: string;
      avg_confidence?: number;
      blocks?: OcrRawBlock[];
      code?: string;
      error?: string;
    };
    const latency = Date.now() - started;
    if (!parsed.ok) {
      return {
        ok: false,
        provider_key: "paddle_ocr",
        page_count: parsed.page_count ?? 1,
        full_text: "",
        avg_confidence: 0,
        blocks: [],
        latency_ms: latency,
        cost_estimate_usd: 0,
        error_code: parsed.code ?? "OCR_FAILED",
        error_message: parsed.error ?? "OCR extraction failed.",
      };
    }

    return {
      ok: true,
      provider_key: "paddle_ocr",
      page_count: parsed.page_count ?? 1,
      full_text: parsed.full_text ?? "",
      avg_confidence: parsed.avg_confidence ?? 0,
      blocks: parsed.blocks ?? [],
      latency_ms: latency,
      cost_estimate_usd: 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runGoogleVisionOcr(
  db: DB,
  bytes: Buffer,
  mime: string,
  provider: ProviderRow,
): Promise<Stage1Result> {
  const started = Date.now();
  const apiKey = await resolveProviderSecret(db, "google_vision_ocr", provider.environment, "api_key");
  if (!apiKey) {
    return {
      ok: false,
      provider_key: "google_vision_ocr",
      page_count: 1,
      full_text: "",
      avg_confidence: 0,
      blocks: [],
      latency_ms: Date.now() - started,
      cost_estimate_usd: 0,
      error_code: "OCR_UNCONFIGURED",
      error_message: "Google Cloud Vision API key is not configured.",
    };
  }

  const endpoint = String(provider.config?.endpoint ?? "https://vision.googleapis.com/v1/images:annotate");
  assertSafeExternalUrl(endpoint, ["vision.googleapis.com"]);
  const timeoutMs = Math.max(5000, Math.min(45000, Number(provider.config?.timeout_ms ?? 15000)));
  const maxPages = Math.max(1, Math.min(30, Number(provider.config?.max_pages ?? 10)));
  const isPdf = mime === "application/pdf";
  if (isPdf) {
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
      const pages = doc.getPageCount();
      if (pages > maxPages) {
        return {
          ok: false,
          provider_key: "google_vision_ocr",
          page_count: pages,
          full_text: "",
          avg_confidence: 0,
          blocks: [],
          latency_ms: Date.now() - started,
          cost_estimate_usd: 0,
          error_code: "PDF_PAGE_LIMIT",
          error_message: `PDF has ${pages} pages, exceeding maximum ${maxPages} pages.`,
        };
      }
    } catch {
      return {
        ok: false,
        provider_key: "google_vision_ocr",
        page_count: 1,
        full_text: "",
        avg_confidence: 0,
        blocks: [],
        latency_ms: Date.now() - started,
        cost_estimate_usd: 0,
        error_code: "PDF_CORRUPT",
        error_message: "Failed to parse or decrypt PDF.",
      };
    }
  }
  const targetUrl = isPdf
    ? endpoint.replace("/images:annotate", "/files:annotate")
    : endpoint;

  const payload = isPdf
    ? {
        requests: [
          {
            inputConfig: { content: bytes.toString("base64"), mimeType: "application/pdf" },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }
    : {
        requests: [
          {
            image: { content: bytes.toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      };

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        provider_key: "google_vision_ocr",
        page_count: 1,
        full_text: "",
        avg_confidence: 0,
        blocks: [],
        latency_ms: latency,
        cost_estimate_usd: 0,
        error_code: `VISION_HTTP_${res.status}`,
        error_message: (await res.text()).slice(0, 240),
      };
    }

    const body = (await res.json()) as {
      responses?: Array<{
        fullTextAnnotation?: { text?: string };
        responses?: Array<{ fullTextAnnotation?: { text?: string } }>;
      }>;
    };
    const r0 = body.responses?.[0];
    const pages = r0?.responses ?? (r0 ? [r0] : []);
    const texts = pages.map((p) => p.fullTextAnnotation?.text?.trim() ?? "").filter(Boolean);
    const fullText = texts.join("\n");
    const lines = fullText.split(/\r?\n/).filter((l) => l.trim());
    const blocks: OcrRawBlock[] = lines.map((line, i) => ({
      page: 1,
      text: line.trim(),
      confidence: 0.9,
      bbox: [0.05, Number((i / Math.max(1, lines.length)).toFixed(4)), 0.95, Number(((i + 0.9) / Math.max(1, lines.length)).toFixed(4))],
    }));
    const unitCost = Number(provider.config?.unit_price_per_1k_usd ?? 1.5) / 1000;
    return {
      ok: true,
      provider_key: "google_vision_ocr",
      page_count: Math.max(1, pages.length),
      full_text: fullText,
      avg_confidence: lines.length > 0 ? 0.9 : 0,
      blocks,
      latency_ms: latency,
      cost_estimate_usd: Number((Math.max(1, pages.length) * unitCost).toFixed(6)),
    };
  } catch (err) {
    return {
      ok: false,
      provider_key: "google_vision_ocr",
      page_count: 1,
      full_text: "",
      avg_confidence: 0,
      blocks: [],
      latency_ms: Date.now() - started,
      cost_estimate_usd: 0,
      error_code: "VISION_NETWORK_ERROR",
      error_message: err instanceof Error ? err.message.slice(0, 240) : "Vision API call failed",
    };
  }
}

async function runConfiguredEngine(db: DB, provider: ProviderRow, bytes: Buffer, mime: string): Promise<Stage1Result> {
  if (provider.provider_key === "paddle_ocr") {
    return runPaddleOcr(bytes, mime, provider.config ?? {});
  }
  if (provider.provider_key === "google_vision_ocr") {
    return runGoogleVisionOcr(db, bytes, mime, provider);
  }
  return {
    ok: false,
    provider_key: provider.provider_key,
    page_count: 1,
    full_text: "",
    avg_confidence: 0,
    blocks: [],
    latency_ms: 0,
    cost_estimate_usd: 0,
    error_code: "UNSUPPORTED_OCR_ENGINE",
    error_message: `Engine '${provider.provider_key}' is not configured for execution.`,
  };
}

async function executeOcrPipeline(
  db: DB,
  bytes: Buffer,
  mime: string,
  preferredProviderKey?: string,
): Promise<{ stage1: Stage1Result; parsed: ParsedOcrDocument; fallbackUsed: string | null }> {
  await ensureIntegrationProvidersSeeded(db);
  const providers = (
    await db.query<ProviderRow>(
      `select * from integration_providers where domain='ocr' and enabled=true order by priority asc, provider_key asc`,
    )
  ).rows;

  let ordered = providers;
  const allowFallback = !preferredProviderKey;
  if (preferredProviderKey) {
    const exact = await one<ProviderRow>(db, "select * from integration_providers where provider_key=$1 and domain='ocr'", [
      preferredProviderKey,
    ]);
    ordered = [exact];
  }
  guard(ordered.length > 0, "OCR_DISABLED", "No OCR engine is currently enabled.", 503);

  let primary = await runConfiguredEngine(db, ordered[0], bytes, mime);
  let fallbackUsed: string | null = null;

  const nonRetryableErrorCodes = new Set(["PDF_ENCRYPTED", "PDF_CORRUPT", "PDF_PAGE_LIMIT", "PDF_EMPTY"]);
  const shouldFallback =
    allowFallback &&
    ((!primary.ok && !nonRetryableErrorCodes.has(primary.error_code ?? "")) ||
      (primary.ok && primary.avg_confidence < 0.45 && ordered.length > 1));

  if (shouldFallback && ordered.length > 1) {
    for (const candidateEngine of ordered.slice(1)) {
      const attempt = await runConfiguredEngine(db, candidateEngine, bytes, mime);
      if (attempt.ok) {
        fallbackUsed = candidateEngine.provider_key;
        primary = attempt;
        break;
      }
    }
  }

  const parsed = primary.ok
    ? parseOcrDocument(primary.full_text, primary.blocks, primary.avg_confidence)
    : {
        platform: null,
        supplier_name: null,
        platform_order_no: null,
        tracking_no: null,
        order_date: null,
        currency: null,
        candidates: [],
        warnings: [primary.error_message ?? "OCR failed."],
        needs_review: true,
      };

  return { stage1: primary, parsed, fallbackUsed };
}

async function persistCandidatesForJob(
  db: DB,
  jobId: string,
  orgId: string | null,
  parsed: ParsedOcrDocument,
) {
  await db.query("delete from ocr_candidates where job_id=$1", [jobId]);
  for (const cand of parsed.candidates) {
    await db.query(
      `insert into ocr_candidates (
         id, job_id, org_id, sort_index, status, platform, supplier_name, platform_order_no, tracking_no,
         item_name, sku_code, color, size, quantity, unit_price_text, currency, order_date,
         confidence, field_confidences, bbox, raw_excerpt
       ) values ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20)`,
      [
        uuid(),
        jobId,
        orgId,
        cand.sort_index,
        cand.platform,
        cand.supplier_name,
        cand.platform_order_no,
        cand.tracking_no,
        cand.item_name,
        cand.sku_code,
        cand.color,
        cand.size,
        cand.quantity,
        cand.unit_price_text,
        cand.currency,
        cand.order_date,
        cand.confidence,
        JSON.stringify(cand.field_confidences),
        JSON.stringify(cand.bbox),
        cand.raw_excerpt,
      ],
    );
  }
}

export async function runOcrJob(db: DB, jobId: string) {
  const job = await one<{
    id: string;
    org_id: string | null;
    media_id: string | null;
    file_mime: string;
    provider_key: string;
    state: string;
  }>(db, "select id, org_id, media_id, file_mime, provider_key, state from ocr_jobs where id=$1 for update", [jobId]);

  if (job.state === "completed" || job.state === "needs_review" || job.state === "canceled") {
    return getOcrJobRaw(db, jobId);
  }
  guard(Boolean(job.media_id), "OCR_MEDIA_MISSING", "OCR job has no linked media asset.", 409);

  await db.query("update ocr_jobs set state='processing', attempts=attempts+1, started_at=coalesce(started_at, now()) where id=$1", [
    jobId,
  ]);

  const asset = await one<{ object_key: string; mime: string }>(
    db,
    "select object_key, mime from media_assets where id=$1 and status='ready'",
    [job.media_id],
  );
  const file = await one<{ data: Buffer; mime: string }>(db, "select data, mime from private_files where key=$1", [asset.object_key]);

  const { stage1, parsed, fallbackUsed } = await executeOcrPipeline(db, file.data, asset.mime);
  const nextState = !stage1.ok ? "failed" : parsed.needs_review ? "needs_review" : "completed";

  if (stage1.ok) {
    await persistCandidatesForJob(db, jobId, job.org_id, parsed);
  }

  await db.query(
    `update ocr_jobs
     set provider_key = $2,
         fallback_provider_key = $3,
         state = $4,
         page_count = $5,
         confidence = $6,
         raw_text = $7,
         raw_blocks = $8::jsonb,
         parsed_summary = $9::jsonb,
         warnings = $10::jsonb,
         error_code = $11,
         error_message = $12,
         latency_ms = $13,
         completed_at = now()
     where id = $1`,
    [
      jobId,
      stage1.provider_key,
      fallbackUsed,
      nextState,
      stage1.page_count,
      stage1.avg_confidence,
      stage1.full_text,
      JSON.stringify(stage1.blocks),
      JSON.stringify({
        platform: parsed.platform,
        supplier_name: parsed.supplier_name,
        platform_order_no: parsed.platform_order_no,
        tracking_no: parsed.tracking_no,
        order_date: parsed.order_date,
        currency: parsed.currency,
        candidate_count: parsed.candidates.length,
      }),
      JSON.stringify(parsed.warnings),
      stage1.error_code ?? null,
      stage1.error_message ?? null,
      stage1.latency_ms,
    ],
  );

  await db.query(
    `update outbox_events set processed_at = coalesce(processed_at, now())
     where type = 'ocr.extract' and payload->>'job_id' = $1 and processed_at is null`,
    [jobId],
  );

  await recordIntegrationEvent(db, {
    provider_key: stage1.provider_key,
    environment: "live",
    event_kind: "ocr_executed",
    status: stage1.ok ? (nextState === "needs_review" ? "warn" : "ok") : "error",
    latency_ms: stage1.latency_ms,
    cost_estimate_usd: stage1.cost_estimate_usd,
    summary: stage1.ok
      ? `OCR ${nextState}: ${parsed.candidates.length} candidate(s), avg conf ${(stage1.avg_confidence * 100).toFixed(0)}%.`
      : `OCR failed [${stage1.error_code}]: ${stage1.error_message}`,
    meta: { job_id: jobId, pages: stage1.page_count, fallback_used: fallbackUsed },
  });

  return getOcrJobRaw(db, jobId);
}

async function getOcrJobRaw(db: DB, jobId: string) {
  const job = await one<Record<string, unknown>>(db, "select * from ocr_jobs where id=$1", [jobId]);
  const candidates = (
    await db.query<Record<string, unknown>>("select * from ocr_candidates where job_id=$1 order by sort_index asc, created_at asc", [
      jobId,
    ])
  ).rows;
  return { job, candidates };
}

async function assertOrgOcrQuota(db: DB, org: string) {
  const primary = await one<ProviderRow>(db, "select * from integration_providers where provider_key='paddle_ocr'");
  const dailyQuota = Math.max(1, Number(primary.config?.daily_quota_per_org ?? 50));
  const concurrencyLimit = Math.max(1, Number(primary.config?.concurrent_jobs_per_org ?? 3));
  const retentionDays = Math.max(1, Number(primary.config?.retention_days ?? 90));

  const usage = await one<{ daily_count: number; active_count: number }>(
    db,
    `select
       count(*) filter (where created_at > now() - interval '24 hours' and is_test=false)::int as daily_count,
       count(*) filter (where state in ('queued','processing') and is_test=false)::int as active_count
     from ocr_jobs where org_id=$1`,
    [org],
  );

  guard(usage.daily_count < dailyQuota, "OCR_QUOTA_EXCEEDED", `Daily OCR limit (${dailyQuota} files/24h) reached.`, 429);
  guard(usage.active_count < concurrencyLimit, "OCR_CONCURRENCY_LIMIT", "Too many active OCR jobs; wait for current job to finish.", 429);
  return { retentionDays };
}

export async function enqueueOcrJob(
  db: DB,
  actor: Actor,
  input: {
    media_id: string;
    order_id?: string;
    batch_key?: string;
    force_rerun?: boolean;
    execute_now?: boolean;
  },
) {
  const org = organization(actor);
  await ensureIntegrationProvidersSeeded(db);

  const asset = await one<{
    id: string;
    org_id: string | null;
    kind: string;
    mime: string;
    sha256: string;
    status: string;
    object_key: string;
  }>(db, "select id, org_id, kind, mime, sha256, status, object_key from media_assets where id=$1", [input.media_id]);

  guard(asset.org_id === org, "FORBIDDEN", "This attachment belongs to another workspace.", 403);
  guard(asset.kind === "attachment", "INVALID_MEDIA_KIND", "Only purchase evidence attachments support OCR extraction.", 422);
  guard(asset.status === "ready", "MEDIA_NOT_READY", "Complete file upload before starting OCR extraction.", 409);

  if (input.order_id) {
    const ord = await one<{ org_id: string }>(db, "select org_id from orders where id=$1", [input.order_id]);
    guard(ord.org_id === org, "FORBIDDEN", "Order belongs to another workspace.", 403);
  }

  const { retentionDays } = await assertOrgOcrQuota(db, org);

  if (!input.force_rerun) {
    const existingForMedia = (
      await db.query<{ id: string }>(
        `select id from ocr_jobs where org_id=$1 and media_id=$2 and state in ('completed','needs_review','queued','processing') order by created_at desc limit 1`,
        [org, input.media_id],
      )
    ).rows[0];
    if (existingForMedia) {
      return { ...(await getOcrJobRaw(db, existingForMedia.id)), deduplicated: true };
    }

    const cachedBySha = (
      await db.query<{
        id: string;
        provider_key: string;
        state: string;
        page_count: number;
        confidence: number;
        raw_text: string;
        raw_blocks: unknown;
        parsed_summary: Record<string, unknown>;
        warnings: unknown;
      }>(
        `select id, provider_key, state, page_count, confidence, raw_text, raw_blocks, parsed_summary, warnings
         from ocr_jobs
         where org_id=$1 and file_sha256=$2 and state in ('completed','needs_review') and is_test=false
         order by created_at desc limit 1`,
        [org, asset.sha256],
      )
    ).rows[0];

    if (cachedBySha && cachedBySha.raw_text) {
      const clonedJobId = uuid();
      await db.query(
        `insert into ocr_jobs (
           id, org_id, order_id, media_id, batch_key, file_sha256, file_mime, page_count,
           provider_key, state, confidence, raw_text, raw_blocks, parsed_summary, warnings, latency_ms,
           attempts, created_by, completed_at, expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,1,1,$16,now(), now() + make_interval(days => $17))`,
        [
          clonedJobId,
          org,
          input.order_id ?? null,
          input.media_id,
          input.batch_key ?? null,
          asset.sha256,
          asset.mime,
          cachedBySha.page_count,
          cachedBySha.provider_key,
          cachedBySha.state,
          cachedBySha.confidence,
          cachedBySha.raw_text,
          JSON.stringify(cachedBySha.raw_blocks ?? []),
          JSON.stringify({ ...(cachedBySha.parsed_summary ?? {}), deduplicated_from_job_id: cachedBySha.id }),
          JSON.stringify(cachedBySha.warnings ?? []),
          actor.id,
          retentionDays,
        ],
      );
      const sourceCands = (await db.query("select * from ocr_candidates where job_id=$1 order by sort_index asc", [cachedBySha.id])).rows;
      for (const c of sourceCands) {
        await db.query(
          `insert into ocr_candidates (
             id, job_id, org_id, sort_index, status, platform, supplier_name, platform_order_no, tracking_no,
             item_name, sku_code, color, size, quantity, unit_price_text, currency, order_date,
             confidence, field_confidences, bbox, raw_excerpt
           ) values ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20)`,
          [
            uuid(),
            clonedJobId,
            org,
            c.sort_index,
            c.platform,
            c.supplier_name,
            c.platform_order_no,
            c.tracking_no,
            c.item_name,
            c.sku_code,
            c.color,
            c.size,
            c.quantity,
            c.unit_price_text,
            c.currency,
            c.order_date,
            c.confidence,
            JSON.stringify(c.field_confidences ?? {}),
            JSON.stringify(c.bbox ?? null),
            c.raw_excerpt,
          ],
        );
      }
      await audit(db, actor, "ocr_job_deduplicated", "ocr_jobs", clonedJobId, { source_job_id: cachedBySha.id });
      return { ...(await getOcrJobRaw(db, clonedJobId)), deduplicated: true };
    }
  }

  const jobId = uuid();
  await db.query(
    `insert into ocr_jobs (
       id, org_id, order_id, media_id, batch_key, file_sha256, file_mime,
       provider_key, state, created_by, expires_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9, now() + make_interval(days => $10))`,
    [jobId, org, input.order_id ?? null, input.media_id, input.batch_key ?? null, asset.sha256, asset.mime, "paddle_ocr", actor.id, retentionDays],
  );

  await db.query(`insert into outbox_events (type, payload) values ('ocr.extract', $1::jsonb)`, [
    JSON.stringify({ job_id: jobId }),
  ]);

  await audit(db, actor, "ocr_job_enqueued", "ocr_jobs", jobId, {
    media_id: input.media_id,
    mime: asset.mime,
  });

  if (input.execute_now) {
    return { ...(await runOcrJob(db, jobId)), deduplicated: false };
  }
  return { ...(await getOcrJobRaw(db, jobId)), deduplicated: false };
}

export async function listCustomerOcrJobs(db: DB, actor: Actor, orderId?: string) {
  const org = organization(actor);
  const jobs = (
    await db.query<Record<string, unknown>>(
      `select j.*, m.mime media_mime, m.size_bytes media_size_bytes
       from ocr_jobs j
       left join media_assets m on m.id = j.media_id
       where j.org_id = $1 and j.is_test = false
         ${orderId ? "and j.order_id = $2" : ""}
       order by j.created_at desc
       limit 40`,
      orderId ? [org, orderId] : [org],
    )
  ).rows;
  if (jobs.length === 0) return { jobs: [] };
  const jobIds = jobs.map((j) => String(j.id));
  const cands = (
    await db.query<Record<string, unknown>>(
      `select * from ocr_candidates where job_id = any($1::uuid[]) order by sort_index asc, created_at asc`,
      [jobIds],
    )
  ).rows;
  const byJob = new Map<string, Array<Record<string, unknown>>>();
  for (const c of cands) {
    const jid = String(c.job_id);
    const list = byJob.get(jid) ?? [];
    list.push(c);
    byJob.set(jid, list);
  }
  return {
    jobs: jobs.map((j) => ({ ...j, candidates: byJob.get(String(j.id)) ?? [] })),
  };
}

export async function getOcrJobDetail(db: DB, actor: Actor, jobId: string) {
  const row = await one<{ id: string; org_id: string | null }>(db, "select id, org_id from ocr_jobs where id=$1", [jobId]);
  if (actor.kind === "customer") {
    guard(row.org_id === organization(actor), "FORBIDDEN", "OCR job belongs to another workspace.", 403);
  } else {
    role(actor, "super_admin", "support", "warehouse_admin", "finance");
  }
  return getOcrJobRaw(db, jobId);
}

export async function retryOcrJob(db: DB, actor: Actor, jobId: string) {
  const org = organization(actor);
  const row = await one<{ id: string; org_id: string | null; media_id: string | null; state: string; expires_at: string | null }>(
    db,
    "select id, org_id, media_id, state, expires_at from ocr_jobs where id=$1 for update",
    [jobId],
  );
  guard(row.org_id === org, "FORBIDDEN", "OCR job belongs to another workspace.", 403);
  guard(!row.expires_at || new Date(row.expires_at).getTime() > Date.now(), "OCR_JOB_EXPIRED", "Expired OCR job cannot be retried.", 409);
  guard(["failed", "needs_review"].includes(row.state), "OCR_RETRY_NOT_ALLOWED", `Cannot retry OCR job in '${row.state}' state.`, 409);
  const hasConfirmed = (
    await db.query("select 1 from ocr_candidates where job_id=$1 and status='confirmed' limit 1", [jobId])
  ).rowCount;
  guard(!hasConfirmed, "CANDIDATES_ALREADY_CONFIRMED", "Confirmed OCR candidates already exist on this job; upload a new file instead.", 409);
  await assertOrgOcrQuota(db, org);
  await db.query("update ocr_jobs set state='queued', error_code=null, error_message=null where id=$1", [jobId]);
  return runOcrJob(db, jobId);
}

export async function updateOcrCandidate(
  db: DB,
  actor: Actor,
  candidateId: string,
  patch: {
    status?: "pending" | "confirmed" | "rejected";
    platform?: string | null;
    supplier_name?: string | null;
    platform_order_no?: string | null;
    tracking_no?: string | null;
    item_name?: string;
    sku_code?: string | null;
    color?: string | null;
    size?: string | null;
    quantity?: number;
    unit_price_text?: string | null;
    currency?: string | null;
    order_date?: string | null;
  },
) {
  const org = organization(actor);
  const cand = await one<{ id: string; job_id: string; org_id: string | null; status: string }>(
    db,
    "select id, job_id, org_id, status from ocr_candidates where id=$1 for update",
    [candidateId],
  );
  guard(cand.org_id === org, "FORBIDDEN", "Candidate belongs to another workspace.", 403);
  guard(!["merged", "split"].includes(cand.status), "CANDIDATE_SUPERSEDED", "Superseded candidate cannot be edited.", 409);

  if (patch.quantity !== undefined) {
    guard(Number.isInteger(patch.quantity) && patch.quantity >= 1 && patch.quantity <= 9999, "INVALID_QTY", "Quantity must be between 1 and 9999.", 422);
  }
  if (patch.item_name !== undefined) {
    guard(patch.item_name.trim().length >= 1, "INVALID_ITEM_NAME", "Item name cannot be empty.", 422);
  }

  const updated = await one<Record<string, unknown>>(
    db,
    `update ocr_candidates
     set status = coalesce($2, status),
         platform = case when $3::boolean then $4 else platform end,
         supplier_name = case when $5::boolean then $6 else supplier_name end,
         platform_order_no = case when $7::boolean then $8 else platform_order_no end,
         tracking_no = case when $9::boolean then $10 else tracking_no end,
         item_name = coalesce($11, item_name),
         sku_code = case when $12::boolean then $13 else sku_code end,
         color = case when $14::boolean then $15 else color end,
         size = case when $16::boolean then $17 else size end,
         quantity = coalesce($18, quantity),
         unit_price_text = case when $19::boolean then $20 else unit_price_text end,
         currency = case when $21::boolean then $22 else currency end,
         order_date = case when $23::boolean then $24 else order_date end,
         updated_by = $25,
         updated_at = now()
     where id = $1
     returning *`,
    [
      candidateId,
      patch.status ?? null,
      patch.platform !== undefined,
      patch.platform ?? null,
      patch.supplier_name !== undefined,
      patch.supplier_name ?? null,
      patch.platform_order_no !== undefined,
      patch.platform_order_no ?? null,
      patch.tracking_no !== undefined,
      patch.tracking_no ?? null,
      patch.item_name?.trim() ?? null,
      patch.sku_code !== undefined,
      patch.sku_code ?? null,
      patch.color !== undefined,
      patch.color ?? null,
      patch.size !== undefined,
      patch.size ?? null,
      patch.quantity ?? null,
      patch.unit_price_text !== undefined,
      patch.unit_price_text ?? null,
      patch.currency !== undefined,
      patch.currency ?? null,
      patch.order_date !== undefined,
      patch.order_date ?? null,
      actor.id,
    ],
  );
  return { candidate: updated };
}

export async function mergeOcrCandidates(db: DB, actor: Actor, jobId: string, candidateIds: string[]) {
  const org = organization(actor);
  const uniqueIds = [...new Set(candidateIds)];
  guard(uniqueIds.length >= 2, "MERGE_REQUIRES_TWO", "Select at least 2 candidates to merge.", 422);

  const job = await one<{ id: string; org_id: string | null }>(db, "select id, org_id from ocr_jobs where id=$1", [jobId]);
  guard(job.org_id === org, "FORBIDDEN", "OCR job belongs to another workspace.", 403);

  const rows = (
    await db.query<{
      id: string;
      status: string;
      sort_index: number;
      platform: string | null;
      supplier_name: string | null;
      platform_order_no: string | null;
      tracking_no: string | null;
      item_name: string;
      sku_code: string | null;
      color: string | null;
      size: string | null;
      quantity: number;
      unit_price_text: string | null;
      currency: string | null;
      order_date: string | null;
      confidence: number;
      bbox: unknown;
      raw_excerpt: string | null;
    }>(
      "select * from ocr_candidates where job_id=$1 and id = any($2::uuid[]) order by sort_index asc for update",
      [jobId, uniqueIds],
    )
  ).rows;
  guard(rows.length === uniqueIds.length, "CANDIDATE_NOT_FOUND", "One or more selected candidates do not belong to this job.", 404);
  guard(rows.every((r) => ["pending", "confirmed"].includes(r.status)), "INVALID_MERGE_STATE", "Only pending/confirmed candidates can be merged.", 409);

  const first = rows[0];
  const mergedQty = rows.reduce((acc, r) => acc + r.quantity, 0);
  const mergedId = uuid();

  await db.query("update ocr_candidates set status='merged', updated_by=$2, updated_at=now() where id = any($1::uuid[])", [
    uniqueIds,
    actor.id,
  ]);

  const inserted = await one<Record<string, unknown>>(
    db,
    `insert into ocr_candidates (
       id, job_id, org_id, sort_index, status, platform, supplier_name, platform_order_no, tracking_no,
       item_name, sku_code, color, size, quantity, unit_price_text, currency, order_date,
       confidence, field_confidences, bbox, raw_excerpt, updated_by
     ) values ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21)
     returning *`,
    [
      mergedId,
      jobId,
      org,
      first.sort_index,
      rows.find((r) => r.platform)?.platform ?? null,
      rows.find((r) => r.supplier_name)?.supplier_name ?? null,
      rows.find((r) => r.platform_order_no)?.platform_order_no ?? null,
      rows.find((r) => r.tracking_no)?.tracking_no ?? null,
      first.item_name,
      rows.find((r) => r.sku_code)?.sku_code ?? null,
      rows.find((r) => r.color)?.color ?? null,
      rows.find((r) => r.size)?.size ?? null,
      mergedQty,
      first.unit_price_text,
      first.currency,
      first.order_date,
      Math.min(...rows.map((r) => Number(r.confidence))),
      JSON.stringify({ merged_from: uniqueIds }),
      JSON.stringify(first.bbox),
      rows.map((r) => r.raw_excerpt ?? "").filter(Boolean).join(" | ").slice(0, 220),
      actor.id,
    ],
  );

  return { merged_candidate: inserted, ... (await getOcrJobRaw(db, jobId)) };
}

export async function splitOcrCandidate(db: DB, actor: Actor, candidateId: string, quantities: number[]) {
  const org = organization(actor);
  guard(
    Array.isArray(quantities) && quantities.length >= 2 && quantities.length <= 20 && quantities.every((q) => Number.isInteger(q) && q >= 1),
    "INVALID_SPLIT",
    "Provide at least 2 positive integer split quantities.",
    422,
  );
  const src = await one<{
    id: string;
    job_id: string;
    org_id: string | null;
    status: string;
    sort_index: number;
    platform: string | null;
    supplier_name: string | null;
    platform_order_no: string | null;
    tracking_no: string | null;
    item_name: string;
    sku_code: string | null;
    color: string | null;
    size: string | null;
    quantity: number;
    unit_price_text: string | null;
    currency: string | null;
    order_date: string | null;
    confidence: number;
    bbox: unknown;
    raw_excerpt: string | null;
  }>(db, "select * from ocr_candidates where id=$1 for update", [candidateId]);

  guard(src.org_id === org, "FORBIDDEN", "Candidate belongs to another workspace.", 403);
  guard(["pending", "confirmed"].includes(src.status), "INVALID_SPLIT_STATE", "Only pending/confirmed candidates can be split.", 409);

  await db.query("update ocr_candidates set status='split', updated_by=$2, updated_at=now() where id=$1", [candidateId, actor.id]);

  const createdIds: string[] = [];
  for (let i = 0; i < quantities.length; i++) {
    const cid = uuid();
    createdIds.push(cid);
    await db.query(
      `insert into ocr_candidates (
         id, job_id, org_id, sort_index, status, platform, supplier_name, platform_order_no, tracking_no,
         item_name, sku_code, color, size, quantity, unit_price_text, currency, order_date,
         confidence, field_confidences, bbox, raw_excerpt, updated_by
       ) values ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21)`,
      [
        cid,
        src.job_id,
        org,
        src.sort_index * 100 + i + 1,
        src.platform,
        src.supplier_name,
        src.platform_order_no,
        src.tracking_no,
        src.item_name,
        src.sku_code,
        src.color,
        src.size,
        quantities[i],
        src.unit_price_text,
        src.currency,
        src.order_date,
        src.confidence,
        JSON.stringify({ split_from: candidateId }),
        JSON.stringify(src.bbox),
        src.raw_excerpt,
        actor.id,
      ],
    );
  }

  return { created_candidate_ids: createdIds, ...(await getOcrJobRaw(db, src.job_id)) };
}

export async function confirmOcrCandidates(db: DB, actor: Actor, jobId: string, candidateIds: string[],
  edits: {candidate_id:string; patch:Parameters<typeof updateOcrCandidate>[3]}[] = [],
) {
  const org = organization(actor);
  const uniqueIds = [...new Set(candidateIds)];
  guard(uniqueIds.length >= 1, "NO_CANDIDATES_SELECTED", "Select at least one candidate row to confirm.", 422);
  guard(new Set(edits.map(edit=>edit.candidate_id)).size===edits.length&&edits.every(edit=>uniqueIds.includes(edit.candidate_id)),
    "INVALID_CANDIDATE_EDITS","Edit only the candidates selected for confirmation.",422);

  const job = await one<{ id: string; org_id: string | null; media_id: string | null }>(
    db,
    "select id, org_id, media_id from ocr_jobs where id=$1",
    [jobId],
  );
  guard(job.org_id === org, "FORBIDDEN", "OCR job belongs to another workspace.", 403);

  const rows = (
    await db.query<{
      id: string;
      status: string;
      item_name: string;
      quantity: number;
    }>("select id, status, item_name, quantity from ocr_candidates where job_id=$1 and id = any($2::uuid[]) order by id for update", [
      jobId,
      uniqueIds,
    ])
  ).rows;
  guard(rows.length === uniqueIds.length, "CANDIDATE_NOT_FOUND", "Selected candidates do not match this OCR job.", 404);

  for (const r of rows) {
    guard(["pending", "confirmed"].includes(r.status), "CANDIDATE_NOT_CONFIRMABLE", "Rejected or superseded candidates cannot be confirmed.", 409);
  }
  for(const edit of edits) {
    const result=await updateOcrCandidate(db,actor,edit.candidate_id,edit.patch);
    const row=rows.find(r=>r.id===edit.candidate_id)!;
    row.item_name=String(result.candidate.item_name);
    row.quantity=Number(result.candidate.quantity);
  }
  for (const r of rows) {
    guard(r.item_name.trim().length > 0 && r.quantity >= 1, "CANDIDATE_INCOMPLETE", "Each confirmed item needs a name and quantity >= 1.", 422);
  }

  await db.query(
    "update ocr_candidates set status='confirmed', updated_by=$2, updated_at=now() where id = any($1::uuid[])",
    [uniqueIds, actor.id],
  );

  const confirmedRows = (
    await db.query("select * from ocr_candidates where id = any($1::uuid[]) order by sort_index asc", [uniqueIds])
  ).rows;

  await audit(db, actor, "ocr_candidates_confirmed", "ocr_jobs", jobId, {
    candidate_count: confirmedRows.length,
    media_id: job.media_id,
  });

  return { job_id: jobId, media_id: job.media_id, confirmed_candidates: confirmedRows };
}

export async function adminTestOcrExtract(
  db: DB,
  actor: Actor,
  sessionHash: string,
  input: { bytes: Buffer; mime: string; provider_key?: string },
) {
  role(actor, "super_admin", "warehouse_admin", "finance");
  await requireStaffMfa(db, actor, sessionHash, 15);
  guard(input.bytes.length > 0 && input.bytes.length <= 15_000_000, "FILE_INVALID", "Upload an image or PDF up to 15 MB.", 422);

  if (input.mime === "application/pdf" || isPdfBytes(input.bytes)) {
    validatePdfBytes(input.bytes);
  }

  const { stage1, parsed, fallbackUsed } = await executeOcrPipeline(
    db,
    input.bytes,
    isPdfBytes(input.bytes) ? "application/pdf" : input.mime,
    input.provider_key,
  );

  const jobId = uuid();
  const nextState = !stage1.ok ? "failed" : parsed.needs_review ? "needs_review" : "completed";
  await db.query(
    `insert into ocr_jobs (
       id, org_id, file_sha256, file_mime, page_count, provider_key, fallback_provider_key,
       state, confidence, raw_text, raw_blocks, parsed_summary, warnings, error_code, error_message,
       latency_ms, attempts, is_test, created_by, started_at, completed_at, expires_at
     ) values ($1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,1,true,$16,now(),now(), now() + interval '7 days')`,
    [
      jobId,
      hash(input.bytes),
      isPdfBytes(input.bytes) ? "application/pdf" : input.mime,
      stage1.page_count,
      stage1.provider_key,
      fallbackUsed,
      nextState,
      stage1.avg_confidence,
      stage1.full_text,
      JSON.stringify(stage1.blocks),
      JSON.stringify({
        platform: parsed.platform,
        supplier_name: parsed.supplier_name,
        platform_order_no: parsed.platform_order_no,
        tracking_no: parsed.tracking_no,
        candidate_count: parsed.candidates.length,
      }),
      JSON.stringify(parsed.warnings),
      stage1.error_code ?? null,
      stage1.error_message ?? null,
      stage1.latency_ms,
      actor.id,
    ],
  );

  if (stage1.ok) {
    await persistCandidatesForJob(db, jobId, null, parsed);
  }

  await recordIntegrationEvent(db, {
    provider_key: stage1.provider_key,
    environment: "live",
    event_kind: "ocr_executed",
    status: stage1.ok ? (parsed.needs_review ? "warn" : "ok") : "error",
    latency_ms: stage1.latency_ms,
    cost_estimate_usd: stage1.cost_estimate_usd,
    summary: `Admin test OCR (${stage1.provider_key}): ${nextState}, ${parsed.candidates.length} candidate(s), ${stage1.latency_ms}ms.`,
    actor_id: actor.id,
  });

  await audit(db, actor, "admin_test_ocr_extract", "ocr_jobs", jobId, {
    provider_key: stage1.provider_key,
    ok: stage1.ok,
    candidate_count: parsed.candidates.length,
  });

  return {
    job_id: jobId,
    provider_key: stage1.provider_key,
    fallback_provider_key: fallbackUsed,
    ok: stage1.ok,
    state: nextState,
    page_count: stage1.page_count,
    confidence: stage1.avg_confidence,
    latency_ms: stage1.latency_ms,
    raw_text: stage1.full_text,
    blocks: stage1.blocks,
    parsed_summary: parsed,
    candidates: parsed.candidates,
    warnings: parsed.warnings,
    error_code: stage1.error_code ?? null,
    error_message: stage1.error_message ?? null,
  };
}

export async function adminListOcrJobs(db: DB, actor: Actor) {
  role(actor, "super_admin", "warehouse_admin", "finance");
  return (
    await db.query(
      `select j.id, j.org_id, j.order_id, j.media_id, j.file_mime, j.page_count,
              j.provider_key, j.fallback_provider_key, j.state, j.confidence, j.parsed_summary,
              j.warnings, j.error_code, j.error_message, j.latency_ms, j.attempts, j.is_test,
              j.created_at, j.completed_at, j.expires_at,
              (select count(*)::int from ocr_candidates c where c.job_id = j.id) candidate_count
       from ocr_jobs j
       order by j.created_at desc
       limit 100`,
    )
  ).rows;
}

export async function cleanupExpiredOcrJobs(db: DB) {
  const { rows: expiredTest } = await db.query<{ id: string }>(
    `delete from ocr_jobs where is_test = true and expires_at is not null and expires_at < now() returning id`,
  );
  const { rowCount: redactedCount } = await db.query(
    `update ocr_jobs
     set raw_text = null, raw_blocks = '[]'::jsonb
     where is_test = false and expires_at is not null and expires_at < now() and raw_text is not null`,
  );
  return { cleaned: expiredTest.length + (redactedCount ?? 0) };
}
