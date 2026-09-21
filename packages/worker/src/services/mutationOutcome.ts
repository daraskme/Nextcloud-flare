export type BatchFailure =
  | { kind: "statement"; error: unknown }
  | { kind: "batch-rejected"; error: unknown }
  | { kind: "network"; error: unknown }
  | { kind: "timeout"; error: unknown };

export type BatchFailureClassification = "rollback-confirmed" | "commit-unknown";

export function classifyBatchFailure(failure: BatchFailure): BatchFailureClassification {
  return failure.kind === "statement" || failure.kind === "batch-rejected"
    ? "rollback-confirmed"
    : "commit-unknown";
}
