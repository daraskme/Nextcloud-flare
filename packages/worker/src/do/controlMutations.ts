import {
  advanceMutations,
  enqueueMutation,
  MUTATION_QUEUE_LIMIT,
  type MutationAdmission,
  type MutationReceipt,
  type MutationRequest,
} from "../db/mutationAdmission";

/** D1 owns the capacity. Instance loss, caller timeout and lost RPC replies never free a grant. */
export class ControlMutations {
  #pending = 0;
  #round: Promise<MutationReceipt[]> | undefined;
  constructor(
    private readonly db: D1Database,
    private readonly admit: (epoch: number) => Promise<void>,
    private readonly current: (epoch: number) => void,
  ) {}

  async acquire(request: MutationRequest): Promise<MutationAdmission> {
    if (
      !request ||
      this.#pending >= MUTATION_QUEUE_LIMIT ||
      !Number.isSafeInteger(request.deadline) ||
      request.deadline <= Date.now() ||
      request.deadline > Date.now() + 5000
    )
      throw new Error("mutation_unavailable");
    this.#pending++;
    const action = this.#acquire(request).finally(() => {
      this.#pending--;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("mutation_unavailable")),
            Math.max(0, request.deadline - Date.now()),
          );
        }),
      ]);
    } catch {
      throw new Error("mutation_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async #acquire(request: MutationRequest): Promise<MutationAdmission> {
    await this.admit(request.epoch);
    this.current(request.epoch);
    let receipt = await enqueueMutation(this.db, request);
    for (;;) {
      this.current(request.epoch);
      if (Date.now() >= request.deadline) throw new Error("mutation_unavailable");
      if (
        receipt.state === "active" &&
        receipt.expires_at !== null &&
        receipt.expires_at > Date.now()
      )
        return { ...receipt, expires_at: receipt.expires_at };
      if (receipt.state !== "waiting") throw new Error("mutation_unavailable");
      const rows = await this.#poll();
      const next = rows.find((row) => row.id === receipt.id);
      if (!next) throw new Error("mutation_unavailable");
      receipt = next;
    }
  }

  #poll(): Promise<MutationReceipt[]> {
    if (!this.#round)
      this.#round = (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return advanceMutations(this.db);
      })().finally(() => {
        this.#round = undefined;
      });
    return this.#round;
  }
}
