import { problem } from "@next-cloud-flare/shared/errors";
import { LIMITS } from "@next-cloud-flare/shared/limits";

export type BatchFailure = "rolled_back" | "commit_unknown";

/** Only a definite SQLite rejection proves rollback; transport errors never do. */
export function classifyBatchFailure(error: unknown): BatchFailure {
  if (!(error instanceof Error)) return "commit_unknown";
  const message = error.message;
  return /^D1_ERROR:/.test(message) &&
    /(?:CHECK|UNIQUE|NOT NULL|FOREIGN KEY) constraint failed|SQLITE_CONSTRAINT/.test(message)
    ? "rolled_back"
    : "commit_unknown";
}

export interface OperationOutcome {
  state: "claimed" | "committed" | "failed";
  result_json: string | null;
  error_code: string | null;
}

export type Reconciliation =
  | { kind: "terminal"; operation: OperationOutcome }
  | { kind: "commit_unknown" };

/** readAuthorized must read primary and recheck the current credential every time. */
export async function reconcileCommit(
  readAuthorized: () => Promise<OperationOutcome | null>,
  options: { now?: () => number; budgetMs?: number } = {},
): Promise<Reconciliation> {
  const now = options.now ?? Date.now;
  const deadline =
    now() + Math.min(options.budgetMs ?? LIMITS.reconciliationMs, LIMITS.reconciliationMs);
  for (let attempt = 0; attempt < LIMITS.reconciliationAttempts; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const row = await Promise.race([
        readAuthorized(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), remaining);
        }),
      ]);
      if (now() < deadline && row && row.state !== "claimed") {
        return { kind: "terminal", operation: row };
      }
    } catch {
      // No failed-state write: timeout/lookup failure says nothing about commit.
    } finally {
      clearTimeout(timeout);
    }
  }
  return { kind: "commit_unknown" };
}

export function commitUnknownResponse(operationId: string): Response {
  const response = problem(503, "commit_unknown");
  response.headers.set("Operation-Id", operationId);
  response.headers.set("Retry-After", "1");
  return response;
}
