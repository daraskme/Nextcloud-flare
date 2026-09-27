import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { controlCalls } from "../backup/control.mjs";
import { bindingBackupStore, manifestKey, S3BackupStore } from "../backup/objectStore.mjs";
import { checkPublicationWrites, trackedPublicationPut } from "../backup/publicationWrite.mjs";
import { publicationControlFixture } from "./fixtures/backup-writes.mjs";

const config = {
  R2_BACKUP_ACCOUNT_ID: "a".repeat(32),
  R2_BACKUP_BUCKET: "private-backups",
  R2_BACKUP_ACCESS_KEY_ID: "testkey1234567890",
  R2_BACKUP_SECRET_ACCESS_KEY: "secret".repeat(8),
};
const generation = {
  id: randomUUID(),
  epoch: 1,
  token: randomUUID(),
  createdAt: 1,
  watermark: null,
};
const key = manifestKey(generation.id),
  bytes = Buffer.from("SQL bytes");
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());
function fixture(kind, native, timeoutMs = 1000) {
  const control = publicationControlFixture();
  const finish = vi.spyOn(control, "finishPublicationWrite");
  const store =
    kind === "s3"
      ? new S3BackupStore(config, { fetch: native, timeoutMs })
      : bindingBackupStore({ get: vi.fn(), put: native }, { timeoutMs });
  return {
    control,
    finish,
    store,
    put: () => trackedPublicationPut(store, control, generation, key, bytes),
  };
}

it.each(["s3", "binding"])(
  "records %s native success before returning to the publisher",
  async (kind) => {
    const native = vi.fn(async () => (kind === "s3" ? new Response(null) : { etag: "saved" }));
    const { control, finish, put } = fixture(kind, native);
    expect(await put()).toBe(true);
    expect(native).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    await checkPublicationWrites(control, generation);
  },
);
it.each(["s3", "binding"])(
  "records a %s conditional conflict as an ended native no-op",
  async (kind) => {
    const { control, finish, put } = fixture(kind, async () =>
      kind === "s3" ? new Response(null, { status: 412 }) : null,
    );
    expect(await put()).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    await checkPublicationWrites(control, generation);
  },
);
it.each(["s3", "binding"])(
  "keeps rejected %s native calls pending and redacts their errors",
  async (kind) => {
    const native = vi.fn(async () => {
      throw new Error("secret transport canary");
    });
    const { control, finish, put } = fixture(kind, native);
    await expect(put()).rejects.toThrow(/^backup_store_write_unknown$/);
    expect(finish).not.toHaveBeenCalled();
    await expect(checkPublicationWrites(control, generation)).rejects.toThrow(
      "backup_publication_write_unsettled",
    );
    await expect(put()).rejects.toThrow("backup_publication_write_unsettled");
    expect(native).toHaveBeenCalledTimes(1);
  },
);
it.each([301, 403, 500, 503])(
  "does not settle S3 HTTP %s from error response or readback",
  async (status) => {
    const { control, finish, put } = fixture("s3", async () => new Response(null, { status }));
    await expect(put()).rejects.toThrow("backup_store_write_unknown");
    expect(finish).not.toHaveBeenCalled();
    await expect(checkPublicationWrites(control, generation)).rejects.toThrow(
      "backup_publication_write_unsettled",
    );
  },
);
it.each(["s3", "binding"])(
  "records a late %s response without turning timeout into publication success",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = gate(),
      response = gate(),
      ended = gate();
    const native = vi.fn(() => {
      entered.resolve();
      return response.promise;
    });
    const { control, finish, put } = fixture(kind, native, 20);
    const original = control.finishPublicationWrite;
    control.finishPublicationWrite = async (...args) => {
      const result = await original(...args);
      ended.resolve();
      return result;
    };
    const rejected = expect(put()).rejects.toThrow("backup_store_write_unknown");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(finish).not.toHaveBeenCalled();
    await expect(checkPublicationWrites(control, generation)).rejects.toThrow(
      "backup_publication_write_unsettled",
    );
    response.resolve(kind === "s3" ? new Response(null) : { etag: "late" });
    await ended.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
    await checkPublicationWrites(control, generation);
  },
);
it("does not send after a grant RPC times out even if the original grant arrives later", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const underlying = publicationControlFixture(),
    entered = gate(),
    response = gate();
  const grant = underlying.grantPublicationWrite;
  underlying.grantPublicationWrite = async (...args) => {
    const result = await grant(...args);
    entered.resolve();
    await response.promise;
    return result;
  };
  const native = vi.fn();
  const store = bindingBackupStore({ get: vi.fn(), put: native });
  const rejected = expect(
    trackedPublicationPut(store, controlCalls(underlying, 20), generation, key, bytes),
  ).rejects.toThrow("backup_operator_timeout");
  await entered.promise;
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  response.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(native).not.toHaveBeenCalled();
  await expect(checkPublicationWrites(underlying, generation)).rejects.toThrow(
    "backup_publication_write_unsettled",
  );
});
it.each(["id", "epoch", "attemptId", "token"])(
  "rejects a malformed grant %s before native dispatch",
  async (field) => {
    const native = vi.fn(),
      { control, put } = fixture("binding", native);
    const grant = control.grantPublicationWrite;
    control.grantPublicationWrite = async (...args) => ({
      ...(await grant(...args)),
      [field]: field === "epoch" ? 2 : field === "token" ? "bad" : randomUUID(),
    });
    await expect(put()).rejects.toThrow(
      /backup_(invalid_publication_write|publication_write_conflict)/,
    );
    expect(native).not.toHaveBeenCalled();
  },
);
it("requires the actual native callback even if a store resolves successfully", async () => {
  const control = publicationControlFixture(),
    finish = vi.spyOn(control, "finishPublicationWrite");
  await expect(
    trackedPublicationPut({ put: async () => true }, control, generation, key, bytes),
  ).rejects.toThrow("backup_store_write_unknown");
  expect(finish).not.toHaveBeenCalled();
  await expect(checkPublicationWrites(control, generation)).rejects.toThrow(
    "backup_publication_write_unsettled",
  );
});
it("does not continue when the completion RPC fails, but allows a lost successful settlement to reconcile", async () => {
  const { control, put } = fixture("binding", async () => ({ etag: "saved" }));
  const finish = control.finishPublicationWrite;
  control.finishPublicationWrite = async (...args) => {
    await finish(...args);
    throw new Error("lost_ack");
  };
  await expect(put()).rejects.toThrow("backup_store_write_unknown");
  await checkPublicationWrites(control, generation);
});
it.each(["s3", "binding"])("rejects an untracked %s PUT before dispatch", async (kind) => {
  const native = vi.fn(),
    { store } = fixture(kind, native);
  await expect(Promise.resolve().then(() => store.put(key, bytes))).rejects.toThrow(
    "backup_write_tracking_required",
  );
  expect(native).not.toHaveBeenCalled();
});
it("requires an operator descriptor for standalone publish before accessing storage", async () => {
  await expect(
    promisify(execFile)(
      process.execPath,
      ["scripts/backup.mjs", "publish", "--directory", "/missing", "--remote"],
      { encoding: "utf8" },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("invalid_backup_arguments"),
  });
});
