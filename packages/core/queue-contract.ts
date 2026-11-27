import { guard, Problem, uuid } from "./common";

export const QUEUE_EXECUTION_POOLS = {
  payment_settlement: { priority: 100, maxConcurrency: 4, defaultLeaseSeconds: 30, maxAttempts: 10 },
  delivery_notification: { priority: 80, maxConcurrency: 4, defaultLeaseSeconds: 30, maxAttempts: 10 },
  report_render: { priority: 60, maxConcurrency: 2, defaultLeaseSeconds: 120, maxAttempts: 8 },
  media_processing: { priority: 40, maxConcurrency: 2, defaultLeaseSeconds: 180, maxAttempts: 6 },
  translation_batch: { priority: 20, maxConcurrency: 1, defaultLeaseSeconds: 90, maxAttempts: 5 },
} as const;

export type QueuePoolName = keyof typeof QUEUE_EXECUTION_POOLS;

export type ReliableQueueJob = {
  id: string;
  pool: QueuePoolName;
  type: string;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  state: "pending" | "leased" | "completed" | "retry_wait" | "exhausted" | "unknown_outcome" | "cancelled";
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  lastErrorCode: string | null;
};

const PERMANENT_ERROR_CODES = new Set([
  "UNSUPPORTED_PAYLOAD",
  "RECORD_NOT_FOUND",
  "INVALID_STATE_TRANSITION",
  "PERMISSION_REVOKED",
  "BUSINESS_OBLIGATION_CLOSED",
]);

/**
 * §70 strict pool scheduling & isolation: high-volume translation/media jobs CANNOT starve
 * payment expiration, Stripe reconciliation, or critical delivery notifications.
 */
export function selectNextEligiblePoolJob(
  jobs: readonly ReliableQueueJob[],
  activeCountByPool: Record<QueuePoolName, number>,
  now = new Date(),
): ReliableQueueJob | null {
  const candidates = jobs
    .filter((j) => {
      if (j.state !== "pending" && j.state !== "retry_wait") return false;
      if (j.attempts >= j.maxAttempts) return false;
      if (new Date(j.nextAttemptAt).getTime() > now.getTime()) return false;
      const cfg = QUEUE_EXECUTION_POOLS[j.pool];
      return (activeCountByPool[j.pool] ?? 0) < cfg.maxConcurrency;
    })
    .sort((a, b) => {
      const prioDiff = QUEUE_EXECUTION_POOLS[b.pool].priority - QUEUE_EXECUTION_POOLS[a.pool].priority;
      if (prioDiff !== 0) return prioDiff;
      return a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.id.localeCompare(b.id);
    });
  return candidates[0] ?? null;
}

export function acquireQueueLease(job: ReliableQueueJob, workerId: string, now = new Date()): ReliableQueueJob {
  const expiredLease = job.state === "leased" && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= now.getTime();
  guard(
    job.state === "pending" || job.state === "retry_wait" || expiredLease,
    "JOB_LEASE_UNAVAILABLE",
    `Job ${job.id} in state '${job.state}' is already leased or terminal.`,
    409,
  );
  guard(job.attempts < job.maxAttempts, "JOB_EXHAUSTED", "Job exceeded max attempts; move to dead-letter.", 409);
  const leaseMs = QUEUE_EXECUTION_POOLS[job.pool].defaultLeaseSeconds * 1000;
  return {
    ...job,
    state: "leased",
    leaseOwner: workerId,
    leaseToken: uuid(),
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
}

export function assertValidFencedLease(job: ReliableQueueJob, expectedLeaseToken: string, now = new Date()) {
  guard(
    job.state === "leased" && job.leaseToken === expectedLeaseToken,
    "STALE_QUEUE_LEASE",
    "Worker lease token does not match current owner (reclaimed or stale worker).",
    409,
  );
  guard(
    Boolean(job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() > now.getTime()),
    "STALE_QUEUE_LEASE",
    "Worker lease expired before completion commit.",
    409,
  );
}

/**
 * Bounded exponential backoff with jitter factor [0.75..1.25] & permanent-error dead-lettering (§70).
 */
export function recordQueueFailure(
  job: ReliableQueueJob,
  leaseToken: string,
  errorCode: string,
  jitterUnit = 0.5,
  now = new Date(),
): ReliableQueueJob {
  assertValidFencedLease(job, leaseToken, now);
  const nextAttempts = job.attempts + 1;
  const clampedJitter = 0.75 + Math.max(0, Math.min(1, jitterUnit)) * 0.5;
  const baseSec = Math.min(900, 10 * 2 ** Math.min(nextAttempts - 1, 7));
  const delayMs = Math.round(baseSec * clampedJitter * 1000);
  const exhausted = PERMANENT_ERROR_CODES.has(errorCode) || nextAttempts >= job.maxAttempts;
  return {
    ...job,
    attempts: nextAttempts,
    state: exhausted ? "exhausted" : "retry_wait",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: errorCode,
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

/**
 * Irreversible external side-effect crash/timeout handling: marks 'unknown_outcome' and BLOCKS
 * blind automated replay until reconciled against authoritative external status or explicitly approved.
 */
export function markExternalUnknownOutcome(job: ReliableQueueJob, leaseToken: string, reasonCode: string, now = new Date()): ReliableQueueJob {
  assertValidFencedLease(job, leaseToken, now);
  return {
    ...job,
    state: "unknown_outcome",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: reasonCode,
  };
}

export function resolveUnknownOutcomeJob(
  job: ReliableQueueJob,
  externalStatus: "confirmed_applied" | "confirmed_not_sent" | "still_unknown",
  operatorApprovedReplay = false,
): ReliableQueueJob {
  guard(job.state === "unknown_outcome", "INVALID_STATE_TRANSITION", "Only unknown_outcome jobs require external reconciliation.", 409);
  if (externalStatus === "confirmed_applied") {
    return { ...job, state: "completed", lastErrorCode: null };
  }
  if (externalStatus === "confirmed_not_sent" || operatorApprovedReplay) {
    return { ...job, state: "pending", lastErrorCode: null, nextAttemptAt: new Date().toISOString() };
  }
  throw new Problem(
    "UNKNOWN_OUTCOME_REQUIRES_RECONCILE",
    "External side effect outcome is still unknown; cannot blindly replay without verification or operator override.",
    409,
  );
}
