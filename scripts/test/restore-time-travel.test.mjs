import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyRestoreTimeTravel, timeTravelProvider } from "../restore/timeTravel.mjs";
import { restoreStatus } from "../restore/verify.mjs";

let grant, reader, control, selected, transport, timestamp;
const nativeResult = { bookmark: "after-restore", previous_bookmark: "before-restore" };
const result = { bookmark: "after-restore", previousBookmark: "before-restore" };
const response = () =>
  Response.json({ success: true, result: nativeResult, secret: "must-not-print" });
beforeEach(() => {
  const accountId = "a".repeat(32),
    now = Date.now();
  timestamp = new Date(now - 60000).toISOString();
  reader = {
    target: { mode: "remote", accountId, databaseId: randomUUID() },
    blobsTarget: { accountId, bucket: "blobs", jurisdiction: "default" },
    backupsTarget: { accountId, bucket: "backups", jurisdiction: "default" },
    assertUnchanged: vi.fn(async () => {}),
    readBookmark: vi.fn(async () => ({ bookmark: "selected&bookmark", timestamp })),
  };
  selected = {
    id: randomUUID(),
    epoch: 2,
    newEpoch: 3,
    createdAt: now - 90000,
    state: "epoch_reserved",
    source: { kind: "time_travel", bookmark: "selected&bookmark" },
  };
  grant = {
    validator: "time-travel-dispatch-v1",
    id: selected.id,
    epoch: 2,
    newEpoch: 3,
    targets: { target: reader.target, blobs: reader.blobsTarget, backups: reader.backupsTarget },
    bookmark: selected.source.bookmark,
    timestamp,
    token: randomUUID(),
    issuedAt: now,
    expiresAt: now + 5000,
  };
  control = {
    inspect: vi.fn(async () => structuredClone(selected)),
    beginTimeTravel: vi.fn(async () => {
      const issuedAt = Date.now();
      return { ...structuredClone(grant), issuedAt, expiresAt: issuedAt + 5000 };
    }),
    finishTimeTravel: vi.fn(async () => ({
      ...selected,
      state: "restore_written",
      restoreResult: result,
      token: "must-not-print",
    })),
    cancel: vi.fn(),
  };
  transport = vi.fn(async () => response());
});
afterEach(() => vi.useRealTimers());
const run = (options = {}) =>
  applyRestoreTimeTravel({
    epoch: 2,
    id: selected.id,
    control,
    reader,
    timestamp,
    provider: timeTravelProvider("private-token", { fetch: transport, ...options }),
  });

it("performs one pinned POST and records only native success before reporting completion", async () => {
  const saved = await run();
  expect(saved).toMatchObject({ state: "restore_written", newEpoch: 3, restoreResult: result });
  expect(JSON.stringify(saved)).not.toContain("must-not-print");
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, options] = transport.mock.calls[0];
  expect(url.origin).toBe("https://api.cloudflare.com");
  expect(url.pathname).toBe(
    `/client/v4/accounts/${reader.target.accountId}/d1/database/${reader.target.databaseId}/time_travel/restore`,
  );
  expect(url.searchParams.get("bookmark")).toBe(selected.source.bookmark);
  expect(options).toMatchObject({
    method: "POST",
    redirect: "manual",
    headers: { Authorization: "Bearer private-token" },
  });
  expect(control.finishTimeTravel).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});

it.each(["restore_pending", "preparing", "frozen", "epoch_reserving", "cancelled"])(
  "never dispatches in %s",
  async (state) => {
    selected.state = state;
    await expect(run()).rejects.toThrow(/dispatch_unavailable/);
    expect(transport).not.toHaveBeenCalled();
    expect(control.beginTimeTravel).not.toHaveBeenCalled();
  },
);
it("reports a durable receipt without another bookmark query or POST", async () => {
  selected.state = "restore_written";
  selected.restoreResult = result;
  expect(await run()).toEqual(selected);
  expect(reader.readBookmark).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
it.each(["id", "epoch", "newEpoch", "bookmark", "timestamp", "targets"])(
  "rejects a grant with changed %s",
  async (field) => {
    if (field === "id") grant.id = randomUUID();
    if (field === "epoch") grant.epoch = 1;
    if (field === "newEpoch") grant.newEpoch = 4;
    if (field === "bookmark") grant.bookmark = "other";
    if (field === "timestamp") grant.timestamp = new Date(Date.now() - 120000).toISOString();
    if (field === "targets")
      grant.targets = { ...grant.targets, target: { ...reader.target, databaseId: randomUUID() } };
    await expect(run()).rejects.toThrow(/invalid_grant/);
    expect(transport).not.toHaveBeenCalled();
  },
);
it.each([1, 2, 3])("rejects configuration changes at boundary %s", async (boundary) => {
  let checks = 0;
  reader.assertUnchanged.mockImplementation(async () => {
    if (++checks === boundary) throw new Error("database_restore_config_changed");
  });
  await expect(run()).rejects.toThrow(/config_changed/);
  expect(transport).not.toHaveBeenCalled();
});
it("does not send when the grant response is unknown", async () => {
  control.beginTimeTravel.mockRejectedValue(new Error("database_restore_operator_timeout"));
  await expect(run()).rejects.toThrow(/operator_timeout/);
  expect(transport).not.toHaveBeenCalled();
});
it("does not turn receipt acknowledgment loss into another POST", async () => {
  control.finishTimeTravel.mockRejectedValue(new Error("response lost"));
  await expect(run()).rejects.toThrow("database_restore_provider_unknown");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(control.cancel).not.toHaveBeenCalled();
});
it.each([
  () => new Response("private error", { status: 503 }),
  () => new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }),
  () => Response.json({ success: false, result: nativeResult }),
  () => Response.json({ success: true, result: { bookmark: "after" } }),
  () => Response.json({ success: true, result: { ...nativeResult, bookmark: "bad bookmark" } }),
  () => new Response("private invalid json"),
  () => new Response("x".repeat(16385)),
  () => new Response(new Uint8Array([0xff])),
])("retains unknown on an unusable native response %#", async (makeResponse) => {
  transport.mockImplementation(async () => makeResponse());
  await expect(run()).rejects.toThrow("database_restore_provider_unknown");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(control.finishTimeTravel).not.toHaveBeenCalled();
});
it("sanitizes transport errors and never retries them", async () => {
  transport.mockRejectedValue(new Error("private-token"));
  await expect(run()).rejects.toThrow("database_restore_provider_unknown");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(control.finishTimeTravel).not.toHaveBeenCalled();
});
it("prevents reuse of the same grant even after failure", async () => {
  const provider = timeTravelProvider("private-token", { fetch: transport });
  transport.mockRejectedValue(new Error("unknown"));
  await expect(provider(grant, vi.fn())).rejects.toThrow(/provider_unknown/);
  await expect(provider(grant, vi.fn())).rejects.toThrow(/dispatch_unavailable/);
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each([-1, 5000])("refuses dispatch outside its short time window (%s)", async (offset) => {
  vi.useFakeTimers();
  vi.setSystemTime(grant.issuedAt + offset);
  await expect(
    timeTravelProvider("private-token", { fetch: transport })(grant, vi.fn()),
  ).rejects.toThrow(/dispatch_unavailable/);
  expect(transport).not.toHaveBeenCalled();
});
it("records a late native response without converting the timeout to success", async () => {
  vi.useFakeTimers();
  let resolve;
  transport.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const saved = vi.fn(async () => {});
  const pending = timeTravelProvider("private-token", { fetch: transport, timeoutMs: 10 })(
    grant,
    saved,
  ).catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toBe("database_restore_provider_unknown");
  expect(saved).not.toHaveBeenCalled();
  resolve(response());
  await vi.advanceTimersByTimeAsync(1);
  expect(saved).toHaveBeenCalledExactlyOnceWith(result);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("bounds stalled response bodies without reporting completion", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  transport.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true'));
        },
        cancel,
      }),
    ),
  );
  const pending = run({ bodyTimeoutMs: 10 }).catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(11);
  expect(await pending).toBe("database_restore_provider_unknown");
  expect(control.finishTimeTravel).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("requires successful provider evidence in public written status", () => {
  expect(() => restoreStatus({ ...selected, state: "restore_written" }, 2, selected.id)).toThrow();
});
it("rejects local apply before connecting or reading credentials", async () => {
  await expect(
    promisify(execFile)(process.execPath, [
      "scripts/database-restore.mjs",
      "apply-time-travel",
      "--local",
      "--operator-config",
      "missing",
      "--config",
      "missing",
      "--epoch",
      "2",
      "--id",
      selected.id,
      "--timestamp",
      timestamp,
    ]),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("database_restore_invalid_arguments"),
  });
});
