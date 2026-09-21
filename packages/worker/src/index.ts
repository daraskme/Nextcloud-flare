import { Hono } from "hono";

import { BudgetDO } from "./do/BudgetDO.js";
import {
  dispatchPendingCopyJobs,
  processCrossOwnerCopy,
  type CopyJobMessage,
} from "./jobs/copy.js";
import { reconcileExpiredUploads } from "./jobs/uploads.js";
import { discoverGcCandidates, runGarbageCollection } from "./services/gc.js";
import { reapExpiredZipManifests } from "./services/zip.js";
import { ControlDO } from "./do/ControlDO.js";
import { LockDO } from "./do/LockDO.js";
import { UploadDO } from "./do/UploadDO.js";
import type { Env } from "./env.js";
import { registerRoutes } from "./routes/register.js";

export const app = new Hono<{ Bindings: Env }>();

registerRoutes(app, 6);

app.notFound((context) =>
  context.json({ error: { code: "not_found", message: "Route not found" } }, 404),
);

export { BudgetDO, ControlDO, LockDO, UploadDO };

function isCopyJobMessage(value: unknown): value is CopyJobMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<CopyJobMessage>;
  return message.kind === "cross-owner-copy" && typeof message.jobId === "string";
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (!isCopyJobMessage(message.body)) throw new Error("unknown_job_kind");
        await processCrossOwnerCopy(env, message.body.jobId);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reconcileExpiredUploads(env);
    await dispatchPendingCopyJobs(env);
    await discoverGcCandidates(env);
    await runGarbageCollection(env);
    await reapExpiredZipManifests(env);
  },
} satisfies ExportedHandler<Env>;
