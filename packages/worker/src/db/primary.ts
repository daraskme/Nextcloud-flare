import { classifyBatchFailure, type BatchFailure } from "../services/mutationOutcome.js";

export class PrimaryDatabase {
  readonly binding: D1Database;

  constructor(binding: D1Database) {
    this.binding = binding;
  }

  prepare(sql: string): D1PreparedStatement {
    return this.binding.prepare(sql);
  }

  async batch(statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
    return this.binding.batch([...statements]);
  }
}

export interface MutationBatchResult {
  state: "committed" | "rollback-confirmed" | "commit-unknown";
  results?: D1Result[];
  error?: unknown;
}

export async function executeMutationBatch(
  database: PrimaryDatabase,
  statements: readonly D1PreparedStatement[],
  classify: (error: unknown) => BatchFailure,
): Promise<MutationBatchResult> {
  try {
    return { state: "committed", results: await database.batch(statements) };
  } catch (error) {
    const failure = classify(error);
    return { state: classifyBatchFailure(failure), error };
  }
}
