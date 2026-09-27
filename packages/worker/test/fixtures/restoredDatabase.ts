import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { RESTORE_BACKUPS_PROBE_KEY } from "../../../shared/src/restoreBackups";
import type { RestoreDomainKind } from "../../../shared/src/restoreDomain";
import { CONTROL_NAME, ControlDO } from "../../src/do/ControlDO";
import { BINDING_PROBE_KEY } from "../../src/r2/bindingProbe";
import { inventoryEnv } from "./s3Inventory";

/** Real local restore barriers/adoption; only S3/provider response and D1 rollback are simulated. */
export async function restoredDatabaseFixture() {
  const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await runInDurableObject(control, async (_, state) => state.storage.deleteAll());
  await evictDurableObject(control);
  const epoch = (await control.recover()).epoch,
    id = crypto.randomUUID();
  const targets = {
    target: {
      mode: "remote" as const,
      accountId: "a".repeat(32),
      databaseId: "00000000-0000-0000-0000-000000000000",
    },
    blobs: { accountId: "a".repeat(32), bucket: "test-blobs", jurisdiction: "default" as const },
    backups: {
      accountId: "a".repeat(32),
      bucket: "test-backups",
      jurisdiction: "default" as const,
    },
  };
  const timestamp = new Date(Date.now() - 60000).toISOString();
  const observation = () => ({ bookmark: "opaque", timestamp, observedAt: Date.now() });
  await control.prepareDatabaseRestore(epoch, id, { kind: "time_travel", bookmark: "opaque" });
  const challenge = await control.challengeDatabaseRestoreD1(epoch, id, targets.target);
  await control.attestDatabaseRestoreD1(epoch, id, challenge);
  await control.attestDatabaseRestoreBookmark(epoch, id, challenge, observation());
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response((await env.BLOBS.get(BINDING_PROBE_KEY))!.body),
  );
  await runInDurableObject(control, async (_, state) => {
    const instance = new ControlDO(state, {
      ...env,
      ...inventoryEnv,
      RESTORE_WRITE_ENABLED: "true",
    });
    const blobs = await instance.verifyDatabaseRestoreBlobs(epoch, id, challenge, targets.blobs);
    const probe = await instance.challengeDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      targets.backups,
    );
    await instance.attestDatabaseRestoreBackups(
      epoch,
      id,
      challenge,
      probe.attemptId,
      await (await env.BACKUPS.get(RESTORE_BACKUPS_PROBE_KEY))!.text(),
    );
    await instance.freezeDatabaseRestore(epoch, id, targets, {
      challenge,
      blobsAttempt: blobs.attemptId,
      backupsAttempt: probe.attemptId,
    });
    await instance.reserveDatabaseRestoreEpoch(epoch, id, targets);
    const grant = await instance.beginDatabaseRestoreTimeTravel(epoch, id, targets, observation());
    await instance.finishDatabaseRestoreTimeTravel(epoch, id, grant, {
      bookmark: "restored-new-bookmark",
      previousBookmark: "before-restore",
    });
  });
  await env.DB.prepare("UPDATE control SET restore_freeze_token=NULL").run();
  await env.DB.prepare(
    "UPDATE control SET epoch=1,maintenance=0,gc_paused=0,admission_revision=0,admission_token=NULL",
  ).run();
  const adopted = async () => {
    const c = await control.challengeDatabaseRestoreSnapshot(epoch, id, targets);
    await control.attestDatabaseRestoreSnapshot(epoch, id, c, {
      validator: "restored-snapshot-v1",
      schemaSha256: "a".repeat(64),
      migrations: Array.from({ length: 46 }, (_, n) => ({
        name: String(n + 1).padStart(4, "0") + "_fixture.sql",
        sha256: "b".repeat(64),
      })),
      data: { bytes: 100, sha256: "c".repeat(64) },
      tables: c.mirror.tables.map((name) => ({ name, rows: 0, sha256: "d".repeat(64) })),
    });
    await runInDurableObject(control, async (_, state) => {
      const instance = new ControlDO(state, { ...env, RESTORE_WRITE_ENABLED: "true" });
      await instance.attestDatabaseRestoreAdoption(
        epoch,
        id,
        await instance.beginDatabaseRestoreAdoption(epoch, id, targets),
      );
    });
  };
  const domain = async (
    kind: RestoreDomainKind,
    limit = 20,
    overrides: { DB?: D1Database; BLOBS?: R2Bucket } = {},
  ) => {
    const result = await runInDurableObject(control, async (_, state) => {
      try {
        return {
          ok: true as const,
          value: await new ControlDO(state, {
            ...env,
            ...overrides,
            RESTORE_WRITE_ENABLED: "true",
          }).repairDatabaseRestoreDomain(epoch, id, kind, limit),
        };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  return { control, epoch, id, adopted, domain };
}
