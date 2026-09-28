import { expect, it, vi } from "vitest";
import type { R2WriteRequest } from "../../src/db/r2Write";
import { MutationUnavailableError } from "../../src/services/accountMutation";
import { trackedR2Write } from "../../src/services/r2Write";

it.each(["grant", "native", "settlement"])(
  "retains the %s failure cause without changing the public error",
  async (phase) => {
    const cause = new Error(`${phase}_failed`),
      action = vi.fn(async () => {
        if (phase === "native") throw cause;
        return "stored";
      }),
      finishR2Write = vi.fn(async () => {
        if (phase === "settlement") throw cause;
      });
    const result = trackedR2Write(
      {
        DB: {} as D1Database,
        systemControl: {
          beginR2Write: async (request: R2WriteRequest) => {
            if (phase === "grant") throw cause;
            return { ...request, startedAt: Date.now(), token: crypto.randomUUID() };
          },
          finishR2Write,
        },
      },
      {
        epoch: 1,
        ownerId: "owner",
        kind: "manifest.put",
        key: `target-sets/${crypto.randomUUID()}`,
      },
      action,
    );
    await expect(result).rejects.toBeInstanceOf(MutationUnavailableError);
    await expect(result).rejects.toMatchObject({ message: "mutation_unavailable", cause });
    expect(action).toHaveBeenCalledTimes(phase === "grant" ? 0 : 1);
    expect(finishR2Write).toHaveBeenCalledTimes(phase === "settlement" ? 1 : 0);
  },
);
