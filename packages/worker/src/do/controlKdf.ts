import type { KdfRequest } from "../auth/globalKdf";
import { KdfExecutor, KdfUnavailableError } from "../auth/kdf";
import { assertOneChange, atomicBatch } from "../db/primary";
import type { KdfSettlements } from "./kdfSettlements";

const CLOCK = "strftime('%s','now')*1000";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;

/** One calculation per current ControlDO instance; D1 also bounds overlapping/unknown instances. */
export class ControlKdf {
  readonly #executor = new KdfExecutor();
  constructor(
    private readonly db: D1Database,
    private readonly admit: (epoch: number) => Promise<void>,
    private readonly current: (epoch: number) => void,
    private readonly settlements: KdfSettlements,
  ) {}

  async derive(request: KdfRequest): Promise<ArrayBuffer> {
    if (
      !request ||
      typeof request.id !== "string" ||
      !UUID.test(request.id) ||
      !Number.isSafeInteger(request.epoch) ||
      request.epoch < 1 ||
      !Number.isSafeInteger(request.deadline) ||
      request.deadline <= Date.now() ||
      request.deadline > Date.now() + 5000 ||
      !(request.input instanceof ArrayBuffer) ||
      request.input.byteLength !== 32 ||
      !(request.salt instanceof Uint8Array) ||
      request.salt.byteLength !== 16
    )
      throw new KdfUnavailableError();
    const { id, epoch, deadline } = request;
    const input = request.input.slice(0),
      salt = request.salt.slice();
    try {
      return await this.#executor.run(async () => {
        await this.admit(epoch);
        const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
        const token = crypto.randomUUID();
        const dispatch = { id, token, epoch, deadline };
        let dispatched = false;
        try {
          await this.settlements.repair();
          this.current(epoch);
          if (deadline <= Date.now()) throw new KdfUnavailableError();
          this.settlements.reserve(dispatch);
          const rows = await atomicBatch(this.db, [
            {
              sql: `DELETE FROM kdf_attempts WHERE state<>'claimed' AND issued_at<=${CLOCK}-65000`,
            },
            {
              sql: `INSERT INTO kdf_attempts(id,dispatch_token,epoch,issued_at,expires_at)
                VALUES(?,?,?,${CLOCK},MIN(?,${CLOCK}+5000))`,
              values: [id, token, epoch, deadline],
            },
            assertOneChange,
            {
              sql: "SELECT expires_at FROM kdf_attempts WHERE id=? AND dispatch_token=?",
              values: [id, token],
            },
          ]);
          const expires = (rows[3]?.results[0] as { expires_at?: unknown } | undefined)?.expires_at;
          await this.admit(epoch);
          // Storage access also fences an old DO instance after a runtime replacement.
          this.current(epoch);
          if (typeof expires !== "number" || Date.now() >= expires) throw new KdfUnavailableError();
          dispatched = true;
          let output: ArrayBuffer;
          try {
            output = await crypto.subtle.deriveBits(
              { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
              key,
              256,
            );
          } finally {
            // Native crypto cannot be cancelled. Only its actual settlement releases the slot.
            await this.settlements.settle(dispatch, "finished");
          }
          return output;
        } catch {
          if (!dispatched) {
            // A lost claim reply cannot dispatch. This token cannot clear another invocation's claim.
            try {
              await this.settlements.settle(dispatch, "not_started");
            } catch {
              /* retain unknown slot */
            }
          }
          throw new KdfUnavailableError();
        }
      });
    } finally {
      new Uint8Array(input).fill(0);
      salt.fill(0);
    }
  }
}
