import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { invokeOperator, operatorConfig, parseAction } from "../../ops/staging/control.mjs";

const accountId = "a".repeat(32);

it("builds only the staging named entrypoint remote capability", () => {
  const config = operatorConfig(accountId);
  expect(config.account_id).toBe(accountId);
  expect(config.services).toEqual([
    {
      binding: "STAGING_CONTROL",
      service: "next-cloud-flare-staging",
      entrypoint: "StagingControlOperator",
      props: { purpose: "staging-control-recovery-v1", environment: "staging" },
      remote: true,
    },
  ]);
  expect(() => operatorConfig("not-an-account")).toThrow("staging_control_account_id_required");
});

it("accepts only the fixed recovery actions and a safe epoch", () => {
  expect(parseAction(["recover"])).toEqual({ action: "recover", method: "recover", args: [] });
  expect(parseAction(["audit-next", "2"])).toEqual({
    action: "audit-next",
    method: "nextAuditPage",
    args: [2],
  });
  for (const argv of [
    ["recover", "2"],
    ["bump", "2"],
    ["audit-next", "2", "extra"],
  ])
    expect(() => parseAction(argv)).toThrow("staging_control_invalid_action");
  for (const epoch of ["0", "-2", "1e2", "9007199254740992"])
    expect(() => parseAction(["resume", epoch])).toThrow("staging_control_invalid_epoch");
});

it("uses a private temporary config, invokes exactly one RPC, and disposes", async () => {
  const nextAuditPage = vi.fn().mockResolvedValue({ epoch: 2, completed: true });
  const dispose = vi.fn();
  let path;
  const result = await invokeOperator(accountId, ["audit-next", "2"], async (options) => {
    expect(options.remoteBindings).toBe(true);
    expect(options.envFiles).toEqual([]);
    path = options.configPath;
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.services[0].entrypoint).toBe("StagingControlOperator");
    return { env: { STAGING_CONTROL: { nextAuditPage } }, dispose };
  });
  expect(result.result.completed).toBe(true);
  expect(nextAuditPage).toHaveBeenCalledExactlyOnceWith(2);
  expect(dispose).toHaveBeenCalledOnce();
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed on absent binding, malformed response and provider failure", async () => {
  const factory = async () => ({ env: {}, dispose: vi.fn() });
  await expect(invokeOperator(accountId, ["recover"], factory)).rejects.toThrow(
    "staging_control_binding_missing",
  );
  await expect(
    invokeOperator(accountId, ["audit-next", "2"], async () => ({
      env: { STAGING_CONTROL: { nextAuditPage: () => ({ epoch: 3, completed: true }) } },
      dispose: vi.fn(),
    })),
  ).rejects.toThrow("staging_control_invalid_response");
  await expect(
    invokeOperator(accountId, ["recover"], async () => {
      throw new Error("secret-bearing provider error");
    }),
  ).rejects.toThrow("staging_control_unavailable");
});
