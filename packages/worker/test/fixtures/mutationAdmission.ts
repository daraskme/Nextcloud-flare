import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  ImageTransformGrant,
  ImageTransformReceipt,
  ImageTransformRequest,
  ImageTransformTerminal,
} from "../../src/db/imageTransform";
import {
  enqueueGlobalMutation,
  enqueueMutation,
  enqueueSystemMutation,
  type GlobalMutationAdmission,
  type MutationAdmission,
  type MutationRequest,
  type SystemMutationAdmission,
} from "../../src/db/mutationAdmission";
import { grantPermit as grant } from "../../src/db/permits";
import type { SqlStatement } from "../../src/db/primary";
import type { R2WriteGrant, R2WriteRequest, R2WriteTerminal } from "../../src/db/r2Write";
import { ControlImageDerivatives } from "../../src/do/controlImageDerivatives";
import { ControlImageTransforms } from "../../src/do/controlImageTransforms";
import { ControlR2Writes } from "../../src/do/controlR2Writes";
import type { Env } from "../../src/env";
import type { ImageTransformFailureReceipt } from "../../src/media/images/failure";

/** Explicit immediate admission fixture; actual ControlDO FIFO/stop/restart is tested separately. */
export async function acquireMutation<Space extends string | null = string>(
  request: MutationRequest<Space>,
  db = env.DB,
): Promise<MutationAdmission<Space>> {
  const receipt = await enqueueMutation(db, request);
  if (
    receipt.state !== "active" ||
    receipt.expires_at === null ||
    receipt.space_id !== request.spaceId
  )
    throw new Error("fixture_mutation_waiting");
  return { ...receipt, space_id: request.spaceId, expires_at: receipt.expires_at };
}

export async function acquireSystemMutation(
  request: MutationRequest,
  db = env.DB,
): Promise<SystemMutationAdmission> {
  const maintenance = await db
    .prepare("SELECT maintenance FROM control WHERE singleton=1")
    .first<0 | 1>("maintenance");
  if (maintenance !== 0 && maintenance !== 1) throw new Error("fixture_control_missing");
  const receipt = await enqueueSystemMutation(db, { ...request, system: 1, maintenance });
  if (
    receipt.state !== "active" ||
    receipt.expires_at === null ||
    receipt.space_id !== request.spaceId
  )
    throw new Error("fixture_mutation_waiting");
  return {
    ...receipt,
    space_id: request.spaceId,
    expires_at: receipt.expires_at,
    system: 1,
    maintenance,
  };
}

export async function acquireGlobalMutation(
  request: Omit<MutationRequest, "spaceId">,
  db = env.DB,
): Promise<GlobalMutationAdmission> {
  const maintenance = await db
    .prepare("SELECT maintenance FROM control WHERE singleton=1")
    .first<0 | 1>("maintenance");
  if (maintenance !== 0 && maintenance !== 1) throw new Error("fixture_control_missing");
  const receipt = await enqueueGlobalMutation(db, {
    ...request,
    spaceId: null,
    system: 1,
    maintenance,
  });
  if (receipt.state !== "active" || receipt.expires_at === null || receipt.space_id !== null)
    throw new Error("fixture_mutation_waiting");
  return { ...receipt, space_id: null, expires_at: receipt.expires_at, system: 1, maintenance };
}

/** Domain-batch fault injection is independent of the admission backend. */
export function mutationEnv(db = env.DB, admissionDb = env.DB): Env {
  return {
    ...env,
    DB: db,
    CONTROL: {
      idFromName: env.CONTROL.idFromName.bind(env.CONTROL),
      get: () => ({
        ...r2WriteFixture(admissionDb),
        ...imageTransformFixture(admissionDb),
        acquireMutation: (request: MutationRequest) => acquireMutation(request, admissionDb),
        acquireGlobalMutation: (request: Omit<MutationRequest, "spaceId">) =>
          acquireGlobalMutation(request, admissionDb),
        acquireSystemMutation: (request: MutationRequest) =>
          acquireSystemMutation(request, admissionDb),
        status: async () => {
          const row = await admissionDb
            .prepare("SELECT epoch,maintenance,gc_paused FROM control WHERE singleton=1")
            .first<{ epoch: number; maintenance: number; gc_paused: number }>();
          if (!row) throw new Error("fixture_control_missing");
          return {
            epoch: row.epoch,
            maintenance: row.maintenance === 1,
            gcPaused: row.gc_paused === 1,
          };
        },
        acquireBootstrapMutation: (request: Omit<MutationRequest, "spaceId">) =>
          acquireMutation({ ...request, spaceId: null }, admissionDb),
      }),
    } as unknown as Env["CONTROL"],
  };
}

/** Real image receipts and native history; only admission is immediate in this fixture. */
export function imageTransformFixture(db = env.DB) {
  const invoke = async <T>(
    action: (images: ControlImageTransforms, derivatives: ControlImageDerivatives) => Promise<T>,
  ) => {
    const result = await runInDurableObject(
      env.CONTROL.get(env.CONTROL.idFromName("singleton")),
      async (_, state) => {
        const settle = async () =>
          acquireGlobalMutation(
            {
              permitId: `global:images.settle:${crypto.randomUUID()}`,
              epoch: (await db
                .prepare("SELECT epoch FROM control WHERE singleton=1")
                .first<number>("epoch"))!,
              deadline: Date.now() + 5000,
            },
            db,
          );
        const images = new ControlImageTransforms(
          state.storage,
          db,
          () => {},
          (r) => acquireMutation(r, db),
          settle,
        );
        const derivatives = new ControlImageDerivatives(state.storage, db, () => {}, settle);
        try {
          return { ok: true as const, value: await action(images, derivatives) };
        } catch (error) {
          return {
            ok: false as const,
            message: error instanceof Error ? error.message : "image_fixture_failed",
          };
        }
      },
    );
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };
  return {
    beginImageTransform: (request: ImageTransformRequest) =>
      invoke((images) => images.begin(request)),
    finishImageTransform: (
      grant: ImageTransformGrant,
      state: ImageTransformTerminal,
      output: ImageTransformReceipt | null,
      failure: ImageTransformFailureReceipt | null = null,
    ) => invoke((images) => images.finish(grant, state, output, failure)),
    imageDerivativePublicationProof: (epoch: number, id: string) =>
      invoke((_, derivatives) => derivatives.publicationProof(epoch, id)),
  };
}

/** Real DO receipt storage and D1 ledger with explicit test-only immediate admission. */
export function r2WriteFixture(
  db = env.DB,
  acquire = (request: MutationRequest) => acquireMutation(request, db),
) {
  const invoke = async <T>(action: (writes: ControlR2Writes) => Promise<T>) => {
    const result = await runInDurableObject(
      env.CONTROL.get(env.CONTROL.idFromName("singleton")),
      async (_instance, state) => {
        const writes = new ControlR2Writes(
          state.storage,
          db,
          () => {},
          acquire,
          async () => {
            const epoch = await db.prepare("SELECT epoch FROM control").first<number>("epoch");
            return acquireGlobalMutation(
              {
                permitId: `global:r2.write-settle:${crypto.randomUUID()}`,
                epoch: epoch!,
                deadline: Date.now() + 5000,
              },
              db,
            );
          },
          (epoch, deadline, kind) =>
            acquireGlobalMutation(
              {
                epoch,
                deadline,
                permitId: `global:${kind === "backup.delete" ? "r2.backups-delete" : kind === "backups.probe.put" ? "r2.backups-probe-put" : kind === "probe.put" ? "r2.probe-put" : kind.endsWith(".abort") ? "r2.multipart-abort" : kind === "manifest.delete" ? "r2.manifest-delete" : "r2.gc-delete"}:${crypto.randomUUID()}`,
              },
              db,
            ),
        );
        try {
          return { ok: true as const, value: await action(writes) };
        } catch (error) {
          return {
            ok: false as const,
            message: error instanceof Error ? error.message : "r2_write_failed",
          };
        }
      },
    );
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };
  return {
    beginR2Write: (request: R2WriteRequest) => invoke((writes) => writes.begin(request)),
    finishR2Write: (grant: R2WriteGrant, outcome: R2WriteTerminal) =>
      invoke((writes) => writes.finish(grant, outcome)),
  };
}

/** Between tests only, after every synthetic native action has ended. No production bypass. */
export async function clearEndedR2TestWrites() {
  await env.DB.prepare(
    "UPDATE r2_write_attempts SET state='not_started',finished_at=MAX(started_at,strftime('%s','now')*1000) WHERE state='pending'",
  ).run();
  await runInDurableObject(
    env.CONTROL.get(env.CONTROL.idFromName("singleton")),
    async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE control_r2_write_receipts SET state='not_started' WHERE state='pending'",
      );
      state.storage.sql.exec("DELETE FROM control_r2_write_receipts");
    },
  );
}

export async function grantPermit(
  db: D1Database,
  requestId: string,
  spaceId: string,
  epoch: number,
  leaseMs?: number,
  guards: readonly SqlStatement[] = [],
) {
  const admission = await acquireMutation({
    permitId: requestId,
    spaceId,
    epoch,
    deadline: Date.now() + 5000,
  });
  return grant(db, requestId, spaceId, epoch, admission, leaseMs, guards);
}
