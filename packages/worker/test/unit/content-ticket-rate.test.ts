import { expect, it, vi } from "vitest";
import { admitContentTicketCost } from "../../src/api/contentTickets";
import type { Principal } from "../../src/auth/authorize";
import type { Env } from "../../src/env";

const user = (credential: string): Principal => ({
  kind: "user",
  user_id: "owner",
  credential_id: credential,
  epoch: 1,
});

it("charges one rate unit per 8 targets using the stable user identity", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  const env = { EDGE_LIMITER: { limit } } as unknown as Env;
  expect(await admitContentTicketCost(env, user("as:first"), 1)).toBeNull();
  expect(await admitContentTicketCost(env, user("as:second"), 17)).toBeNull();
  expect(limit).toHaveBeenCalledTimes(4);
  expect(limit).toHaveBeenCalledWith({ key: "content-ticket:user:owner" });
  limit.mockClear();
  expect(await admitContentTicketCost(env, user("as:first"), 1_000)).toBeNull();
  expect(limit).toHaveBeenCalledTimes(125);
});

it("fails closed at the limiter before issuing a ticket", async () => {
  const limit = vi
    .fn()
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false });
  const env = { EDGE_LIMITER: { limit } } as unknown as Env;
  const rejected = await admitContentTicketCost(env, user("as:first"), 16);
  expect(rejected?.status).toBe(429);
  expect(rejected?.headers.get("Retry-After")).toBe("60");
  expect(limit).toHaveBeenCalledTimes(2);
  expect(
    (
      await admitContentTicketCost(
        {
          EDGE_LIMITER: {
            limit: async () => {
              throw new Error("down");
            },
          },
        } as unknown as Env,
        user("as:first"),
        1,
      )
    )?.status,
  ).toBe(503);
  expect((await admitContentTicketCost(env, user("as:first"), 1_001))?.status).toBe(400);
});

it("charges all public share sessions against one share key", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  const env = { EDGE_LIMITER: { limit } } as unknown as Env;
  for (const credential of ["ss:first", "ss:second"]) {
    const principal: Principal = {
      kind: "link_share",
      share_id: "shared-link",
      share_version: 1,
      credential_id: credential,
      epoch: 1,
    };
    expect(await admitContentTicketCost(env, principal, 1)).toBeNull();
  }
  expect(limit).toHaveBeenCalledTimes(2);
  expect(limit).toHaveBeenCalledWith({ key: "content-ticket:share:shared-link" });
});
