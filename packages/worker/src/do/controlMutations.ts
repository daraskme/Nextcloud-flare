import {
  type AnyMutationRequest,
  advanceMutations,
  enqueueGlobalMutation,
  enqueueMutation,
  enqueueSystemMutation,
  MUTATION_QUEUE_LIMIT,
  MUTATION_WAIT_MS,
  type MutationReceipt,
} from "../db/mutationAdmission";

/** D1 owns the capacity. Instance loss, caller timeout and lost RPC replies never free a grant. */
export class ControlMutations {
  #pending = 0;
  #round: Promise<MutationReceipt[]> | undefined;
  constructor(
    private readonly db: D1Database,
    private readonly admit: (request: AnyMutationRequest) => Promise<void>,
    private readonly current: (request: AnyMutationRequest) => void,
    private readonly diagnostic?: (stage: string) => void,
  ) {}

  async acquire(request: AnyMutationRequest): Promise<MutationReceipt & { expires_at: number }> {
    const receivedAt = Date.now();
    if (
      !request ||
      this.#pending >= MUTATION_QUEUE_LIMIT ||
      !Number.isSafeInteger(request.deadline) ||
      request.deadline <= receivedAt
    ) {
      this.diagnostic?.(
        !request
          ? "missing_request"
          : this.#pending >= MUTATION_QUEUE_LIMIT
            ? "queue_full"
            : !Number.isSafeInteger(request.deadline)
              ? "invalid_deadline"
              : "expired_deadline",
      );
      throw new Error("mutation_unavailable");
    }
    // RPC callers and the coordinator can observe different clocks. Shorten a future
    // caller deadline to this receiver's budget; never extend an earlier deadline.
    request = { ...request, deadline: Math.min(request.deadline, receivedAt + MUTATION_WAIT_MS) };
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
            () => {
              this.diagnostic?.("wait_timeout");
              reject(new Error("mutation_unavailable"));
            },
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

  async #acquire(request: AnyMutationRequest): Promise<MutationReceipt & { expires_at: number }> {
    let stage = "admit";
    try {
      await this.admit(request);
      stage = "current_before_enqueue";
      this.current(request);
      stage = "enqueue";
      let receipt = await ("system" in request
        ? request.spaceId === null
          ? enqueueGlobalMutation(this.db, request)
          : enqueueSystemMutation(this.db, request)
        : enqueueMutation(this.db, request));
      for (;;) {
        stage = "current_after_enqueue";
        this.current(request);
        stage = "deadline_after_enqueue";
        if (Date.now() >= request.deadline) throw new Error("mutation_unavailable");
        if (
          receipt.state === "active" &&
          receipt.expires_at !== null &&
          receipt.expires_at > Date.now()
        )
          return { ...receipt, expires_at: receipt.expires_at };
        stage = receipt.state === "active" ? "expired_receipt" : "closed_receipt";
        if (receipt.state !== "waiting") throw new Error("mutation_unavailable");
        stage = "poll";
        const rows = await this.#poll();
        stage = "missing_receipt";
        const next = rows.find((row) => row.id === receipt.id);
        if (!next) throw new Error("mutation_unavailable");
        receipt = next;
      }
    } catch (error) {
      this.diagnostic?.(stage);
      throw error;
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
