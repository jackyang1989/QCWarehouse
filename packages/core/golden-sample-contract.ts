import { guard, Problem, type Actor } from "./common";
import { evaluateAuthorization, type StaffScopeContext } from "./authz-contract";

export const GOLDEN_BENCHMARK_STATES = [
  "candidate",
  "qa_approved",
  "sealed",
  "contract_pending_payment",
  "active",
  "frozen",
  "expired",
  "retired",
  "retrieved",
] as const;
export type GoldenBenchmarkState = (typeof GOLDEN_BENCHMARK_STATES)[number];

export type GoldenBenchmarkContract = {
  benchmarkId: string;
  version: number;
  orgId: string;
  itemId: string;
  categorySlug: string;
  proposedBy: string;
  qaApprovedBy: string | null;
  state: GoldenBenchmarkState;
  custodyContractId: string | null;
  custodyReceivableSettled: boolean;
  expiresAt: string | null;
  frozenReason: string | null;
  reservedCallsCount: number;
  archivedMeasurementSpecHash: string;
  parentOrderClosed: boolean;
};

/**
 * §64.5 QA approval for a candidate Golden Sample enforces Separation of Duties:
 * proposer/inspector CANNOT self-approve.
 */
export function approveCandidateBenchmark(
  actor: Actor | null,
  scope: StaffScopeContext,
  benchmark: GoldenBenchmarkContract,
): GoldenBenchmarkContract {
  evaluateAuthorization(actor, "qc.qa_approve", scope, {
    actorLinks: { author_id: benchmark.proposedBy },
  });
  guard(
    benchmark.state === "candidate",
    "INVALID_BENCHMARK_STATE",
    `Benchmark must be in 'candidate' state for QA approval (got '${benchmark.state}').`,
    409,
  );
  return {
    ...benchmark,
    state: "qa_approved",
    qaApprovedBy: actor!.id,
  };
}

/**
 * Sealing binds archive lock & storage location, advancing to 'sealed' — NOT paid 'active'!
 */
export function sealApprovedBenchmark(benchmark: GoldenBenchmarkContract): GoldenBenchmarkContract {
  guard(
    benchmark.state === "qa_approved" && Boolean(benchmark.qaApprovedBy),
    "BENCHMARK_QA_REQUIRED",
    "Independent QA approval is required prior to sealing.",
    409,
  );
  return { ...benchmark, state: "sealed" };
}

/**
 * Activation requires explicit custody contract selection AND settled custody receivable (§64.5).
 */
export function activatePaidBenchmarkContract(
  benchmark: GoldenBenchmarkContract,
  contractTermDays: 30 | 90 | 180 | 365,
  custodyContractId: string,
  custodyReceivableSettled: boolean,
  expiresAtIso: string,
): GoldenBenchmarkContract {
  guard(
    ["sealed", "contract_pending_payment", "expired"].includes(benchmark.state),
    "BENCHMARK_NOT_ACTIVATABLE",
    `Cannot activate custody contract from state '${benchmark.state}'.`,
    409,
  );
  guard(
    custodyReceivableSettled,
    "CUSTODY_PAYMENT_REQUIRED",
    `Custody contract (${contractTermDays}d) requires verified payment settlement before benchmark becomes active/callable.`,
    409,
  );
  return {
    ...benchmark,
    state: "active",
    custodyContractId,
    custodyReceivableSettled: true,
    expiresAt: expiresAtIso,
  };
}

/**
 * Matching eligibility gate (§08/64.5/TASK-228A):
 * Archived/sealed does NOT mean paid & callable. Blocks unpaid, cross-customer, frozen, expired,
 * retired, or retrieved benchmarks cleanly.
 */
export function assertBenchmarkCallableForMatching(
  benchmark: GoldenBenchmarkContract,
  requestingOrgId: string,
  expectedCategorySlug: string,
  now = new Date(),
): { callable: true; lockedBenchmarkId: string; lockedVersion: number } {
  guard(benchmark.orgId === requestingOrgId, "FORBIDDEN", "Benchmark belongs to another customer organization.", 403);
  guard(benchmark.categorySlug === expectedCategorySlug, "BENCHMARK_CATEGORY_MISMATCH", "Benchmark category does not match order category.", 409);
  guard(
    benchmark.state === "active",
    "BENCHMARK_NOT_ACTIVE",
    `Benchmark is in state '${benchmark.state}' (sealed/archived/frozen/retired is NOT callable for matching).`,
    409,
  );
  guard(
    benchmark.custodyReceivableSettled && Boolean(benchmark.custodyContractId),
    "CUSTODY_PAYMENT_REQUIRED",
    "Golden Sample custody contract must be paid before calling benchmark for matching.",
    409,
  );
  guard(!benchmark.frozenReason, "BENCHMARK_FROZEN", `Benchmark is frozen: ${benchmark.frozenReason}`, 409);
  guard(
    Boolean(benchmark.expiresAt) && new Date(benchmark.expiresAt!).getTime() > now.getTime(),
    "BENCHMARK_EXPIRED",
    "Golden Sample custody term has expired or lacks a fixed expiry; renew contract before matching.",
    409,
  );
  return {
    callable: true,
    lockedBenchmarkId: benchmark.benchmarkId,
    lockedVersion: benchmark.version,
  };
}

/**
 * Superseding/updating a benchmark MUST increment version & create a new versioned record,
 * NEVER mutating existing sealed/referenced historical spec hashes.
 */
export function createSupersededBenchmarkVersion(
  prior: GoldenBenchmarkContract,
  nextBenchmarkId: string,
  nextItemId: string,
  nextSpecHash: string,
  proposedBy: string,
): { archivedPrior: GoldenBenchmarkContract; nextCandidate: GoldenBenchmarkContract } {
  guard(
    prior.archivedMeasurementSpecHash !== nextSpecHash || prior.itemId !== nextItemId,
    "NO_BENCHMARK_CHANGE",
    "Superseding benchmark requires a distinct physical sample or updated spec hash.",
    422,
  );
  return {
    archivedPrior: { ...prior, state: "retired" },
    nextCandidate: {
      benchmarkId: nextBenchmarkId,
      version: prior.version + 1,
      orgId: prior.orgId,
      itemId: nextItemId,
      categorySlug: prior.categorySlug,
      proposedBy,
      qaApprovedBy: null,
      state: "candidate",
      custodyContractId: null,
      custodyReceivableSettled: false,
      expiresAt: null,
      frozenReason: null,
      reservedCallsCount: 0,
      archivedMeasurementSpecHash: nextSpecHash,
      parentOrderClosed: prior.parentOrderClosed,
    },
  };
}

/**
 * Historical benchmark version mutation guard + post-order-closure ongoing obligation check.
 */
export function assertHistoricalBenchmarkImmutable(existing: GoldenBenchmarkContract, attemptedHash: string) {
  guard(
    existing.archivedMeasurementSpecHash === attemptedHash,
    "HISTORICAL_BENCHMARK_IMMUTABLE",
    `Cannot overwrite frozen measurement spec hash of benchmark ${existing.benchmarkId} v${existing.version}.`,
    409,
  );
}

export function assertCustomerAccountDeletionBlockedByActiveCustody(benchmarks: readonly GoldenBenchmarkContract[]) {
  const active = benchmarks.find((b) => ["sealed", "contract_pending_payment", "active", "frozen", "expired"].includes(b.state));
  if (active) {
    throw new Problem(
      "ONGOING_CUSTODY_OBLIGATION_ACTIVE",
      `Ongoing Golden Sample custody (${active.benchmarkId}, state=${active.state}) remains active even after parent order closure.`,
      409,
    );
  }
}
