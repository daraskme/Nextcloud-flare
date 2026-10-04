import { DurableObject } from "cloudflare:workers";
import {
  CONTROL_NAME,
  ControlDO as ProductionControlDO,
} from "../../packages/worker/src/do/ControlDO";
import { LockDO } from "../../packages/worker/src/do/LockDO";
import type { Env } from "../../packages/worker/src/env";
import { handleDeadLetterBatch } from "../../packages/worker/src/jobs/deadLetter";
import { dispatchOutbox } from "../../packages/worker/src/jobs/outbox";
import { handleOutboxBatch } from "../../packages/worker/src/jobs/queue";
import { createFolder } from "../../packages/worker/src/services/createFolder";

export { LockDO };

interface FaultEnv extends Env {
  FAULT_STATE: DurableObjectNamespace<FaultStateDO>;
  FAULT_RUN_ID: string;
  FAULT_ARMED: string;
}

/** Production ControlDO logic with a private in-memory reset probe. */
export class ControlDO extends ProductionControlDO {
  readonly #instanceNonce = crypto.randomUUID();

  async drillProbe(runId: string) {
    if (runId !== (this.env as FaultEnv).FAULT_RUN_ID)
      throw new Error("fault_drill_identity_conflict");
    const status = await this.status();
    const audit = await this.recoveryAuditStatus(status.epoch);
    return { nonce: this.#instanceNonce, status, auditCompleted: audit?.completed === true };
  }

  drillAbort(runId: string): void {
    if (runId !== (this.env as FaultEnv).FAULT_RUN_ID)
      throw new Error("fault_drill_identity_conflict");
    this.ctx.abort("fault_drill_private_control_reset", { retryAlarm: false });
  }
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_AUDIT_PAGES = 20;
type FaultStage = "claimed" | "ready" | "dispatched" | "failed";

function validRun(env: FaultEnv): void {
  if (!UUID.test(env.FAULT_RUN_ID) || env.ENVIRONMENT !== "staging")
    throw new Error("fault_drill_unconfigured");
}

interface FaultSnapshot {
  stage: FaultStage | null;
  healthy: string | null;
  poison: string | null;
  healthyAcks: number;
  poisonRetries: number;
  deadLetters: number;
  deadLetterAcks: number;
}

/** Dedicated private SQLite object; only the fixed drill instance is used. */
export class FaultStateDO extends DurableObject<FaultEnv> {
  constructor(ctx: DurableObjectState, env: FaultEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fault_state(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      healthy TEXT,
      poison TEXT,
      healthy_acks INTEGER NOT NULL DEFAULT 0,
      poison_retries INTEGER NOT NULL DEFAULT 0,
      dead_letters INTEGER NOT NULL DEFAULT 0,
      dead_letter_acks INTEGER NOT NULL DEFAULT 0
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fault_probe(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      run_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('started','passed','failed'))
    )`);
  }

  fetch(): Response {
    return new Response(null, { status: 404 });
  }

  claim(runId: string): boolean {
    if (runId !== this.env.FAULT_RUN_ID || !UUID.test(runId)) return false;
    const written = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fault_state(singleton,run_id,stage) VALUES(1,?,'claimed')",
      runId,
    );
    return written.rowsWritten === 1;
  }

  setIds(runId: string, healthy: string, poison: string): void {
    if (
      runId !== this.env.FAULT_RUN_ID ||
      !/^op_[a-f0-9]{64}_event$/.test(healthy) ||
      !/^op_[a-f0-9]{64}_event$/.test(poison) ||
      healthy === poison
    )
      throw new Error("fault_drill_identity_conflict");
    const result = this.ctx.storage.sql.exec(
      "UPDATE fault_state SET healthy=?,poison=?,stage='ready' WHERE singleton=1 AND run_id=? AND stage='claimed'",
      healthy,
      poison,
      runId,
    );
    if (result.rowsWritten !== 1) throw new Error("fault_drill_identity_conflict");
  }

  markDispatched(runId: string): void {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    this.ctx.storage.sql.exec(
      "UPDATE fault_state SET stage='dispatched' WHERE singleton=1 AND run_id=? AND stage='ready'",
      runId,
    );
  }

  record(runId: string, kind: "healthyAck" | "poisonRetry" | "deadLetter" | "deadLetterAck"): void {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    const column = {
      healthyAck: "healthy_acks",
      poisonRetry: "poison_retries",
      deadLetter: "dead_letters",
      deadLetterAck: "dead_letter_acks",
    }[kind];
    this.ctx.storage.sql.exec(
      `UPDATE fault_state SET ${column}=${column}+1 WHERE singleton=1 AND run_id=? AND stage IN ('ready','dispatched')`,
      runId,
    );
  }

  snapshot(runId: string): FaultSnapshot {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    const row = this.ctx.storage.sql
      .exec<{
        stage: FaultStage;
        healthy: string | null;
        poison: string | null;
        healthy_acks: number;
        poison_retries: number;
        dead_letters: number;
        dead_letter_acks: number;
      }>(
        "SELECT stage,healthy,poison,healthy_acks,poison_retries,dead_letters,dead_letter_acks FROM fault_state WHERE singleton=1 AND run_id=?",
        runId,
      )
      .toArray()[0];
    return {
      stage: row?.stage ?? null,
      healthy: row?.healthy ?? null,
      poison: row?.poison ?? null,
      healthyAcks: row?.healthy_acks ?? 0,
      poisonRetries: row?.poison_retries ?? 0,
      deadLetters: row?.dead_letters ?? 0,
      deadLetterAcks: row?.dead_letter_acks ?? 0,
    };
  }

  startProbe(runId: string): boolean {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    const result = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO fault_probe(singleton,run_id,outcome) VALUES(1,?,'started')",
      runId,
    );
    return result.rowsWritten === 1;
  }

  finishProbe(runId: string, passed: boolean): void {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    this.ctx.storage.sql.exec(
      "UPDATE fault_probe SET outcome=? WHERE singleton=1 AND run_id=? AND outcome='started'",
      passed ? "passed" : "failed",
      runId,
    );
  }

  probeOutcome(runId: string): string | null {
    if (runId !== this.env.FAULT_RUN_ID) throw new Error("fault_drill_identity_conflict");
    return (
      this.ctx.storage.sql
        .exec<{ outcome: string }>(
          "SELECT outcome FROM fault_probe WHERE singleton=1 AND run_id=?",
          runId,
        )
        .toArray()[0]?.outcome ?? null
    );
  }
}

function state(env: FaultEnv): DurableObjectStub<FaultStateDO> {
  return env.FAULT_STATE.get(env.FAULT_STATE.idFromName(env.FAULT_RUN_ID));
}

function fixtureIds(runId: string) {
  const tag = runId.replaceAll("-", "").slice(0, 16);
  return {
    user: `fault_${tag}_u`,
    space: `fault_${tag}_s`,
    root: `fault_${tag}_r`,
    session: `fault_${tag}_session`,
  };
}

async function seedFixture(env: FaultEnv): Promise<ReturnType<typeof fixtureIds>> {
  const ids = fixtureIds(env.FAULT_RUN_ID);
  const now = Date.now();
  const issuer = "https://fault.invalid";
  // This batch is atomic in a dedicated D1. No pre-existing application account is referenced.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users(id,access_iss,access_sub,email,role,quota_bytes,created_at) VALUES(?,?,?,'fault@example.invalid','app_admin',1000000,?)",
    ).bind(ids.user, issuer, ids.user, now),
    env.DB.prepare("INSERT INTO spaces(id,owner_id,root_node_id) VALUES(?,?,?)").bind(
      ids.space,
      ids.user,
      ids.root,
    ),
    env.DB.prepare(
      "INSERT INTO nodes(id,space_id,owner_id,name,name_ci,kind,created_at,updated_at) VALUES(?,?,?,'','','root',?,?)",
    ).bind(ids.root, ids.space, ids.user, now, now),
    env.DB.prepare(
      "INSERT INTO sessions(id,user_id,kind,fingerprint,epoch,issued_at,expires_at,last_seen_at) VALUES(?,?,'access',?,2,?,?,?)",
    ).bind(ids.session, ids.user, `fault_${env.FAULT_RUN_ID}`, now, now + 600_000, now),
    env.DB.prepare("INSERT INTO credentials(id,kind,session_id) VALUES(?,'access',?)").bind(
      `as:${ids.session}`,
      ids.session,
    ),
    env.DB.prepare(
      "UPDATE control SET bootstrap_done_at=?,bootstrap_iss=?,bootstrap_sub=? WHERE singleton=1 AND epoch=1 AND maintenance=1",
    ).bind(now, issuer, ids.user),
  ]);
  return ids;
}

async function createdOutbox(env: FaultEnv, nodeId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT b.outbox_id FROM outbox b JOIN operations o ON o.op_id=b.op_id WHERE b.payload_ref=? AND b.kind='node.created' AND o.state='committed' AND b.epoch=2",
  )
    .bind(nodeId)
    .first<{ outbox_id: string }>();
  if (!row) throw new Error("fault_drill_outbox_missing");
  return row.outbox_id;
}

async function createFixtureFolder(
  env: FaultEnv,
  ids: ReturnType<typeof fixtureIds>,
  name: string,
) {
  const outcome = await createFolder(env, {
    principal: { kind: "user", user_id: ids.user, credential_id: `as:${ids.session}`, epoch: 2 },
    idempotencyKey: `fault:${env.FAULT_RUN_ID}:${name === "Fault Healthy" ? "healthy" : "poison"}`,
    spaceId: ids.space,
    parentId: ids.root,
    name,
    lockTokens: [],
  });
  if (outcome.kind !== "terminal" || outcome.operation.state !== "committed")
    throw new Error("fault_drill_folder_unknown");
  const nodeId = outcome.operation.result?.nodeId;
  if (typeof nodeId !== "string") throw new Error("fault_drill_folder_unknown");
  return createdOutbox(env, nodeId);
}

export async function runFaultCron(env: FaultEnv): Promise<void> {
  validRun(env);
  if (env.FAULT_ARMED !== "true") return;
  const tracker = state(env);
  if (!(await tracker.claim(env.FAULT_RUN_ID))) return;
  let phase = "seed";
  try {
    const ids = await seedFixture(env);
    phase = "control_recover";
    const control = env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME));
    const recovered = await control.recover();
    if (recovered.epoch !== 2 || !recovered.maintenance)
      throw new Error("fault_drill_recovery_invalid");
    await env.LOCKS.get(env.LOCKS.idFromName(ids.space)).recover(ids.space, 2);
    phase = "recovery_audit";
    await control.beginRecoveryAudit(2);
    let completed = false;
    for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
      if ((await control.nextRecoveryAuditPage(2, 20)).completed) {
        completed = true;
        break;
      }
    }
    if (!completed) throw new Error("fault_drill_audit_incomplete");
    await control.resumeAdmission(2);
    phase = "create_dispatch";
    await createAndDispatch(env, ids, tracker);
    console.log("fault_drill_outbox_dispatched");
  } catch (error) {
    // The durable claim deliberately prevents a second setup after an unknown D1/Queue outcome.
    const code =
      error instanceof Error && /^[a-z_]{3,60}$/.test(error.message) ? error.message : "unknown";
    console.error("fault_drill_setup_failed", phase, code);
    throw new Error("fault_drill_cron_unknown_outcome");
  }
}

async function createAndDispatch(
  env: FaultEnv,
  ids: ReturnType<typeof fixtureIds>,
  tracker: DurableObjectStub<FaultStateDO>,
): Promise<void> {
  const healthy = await createFixtureFolder(env, ids, "Fault Healthy");
  const poison = await createFixtureFolder(env, ids, "Fault Poison");
  await tracker.setIds(env.FAULT_RUN_ID, healthy, poison);
  if ((await dispatchOutbox(env, env.JOBS, healthy, 2)) !== "sent")
    throw new Error("fault_drill_dispatch_unknown");
  if ((await dispatchOutbox(env, env.JOBS, poison, 2)) !== "sent")
    throw new Error("fault_drill_dispatch_unknown");
  await tracker.markDispatched(env.FAULT_RUN_ID);
}

/** Exact-state one-shot continuation after a transport-unknown first bootstrap. */
async function runFaultResume(env: FaultEnv): Promise<void> {
  const tracker = state(env);
  const snapshot = await tracker.snapshot(env.FAULT_RUN_ID);
  const counts = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM nodes) AS nodes,
    (SELECT COUNT(*) FROM operations) AS operations,
    (SELECT COUNT(*) FROM outbox) AS outbox,
    (SELECT epoch FROM control WHERE singleton=1) AS epoch,
    (SELECT maintenance FROM control WHERE singleton=1) AS maintenance`).first<{
    users: number;
    nodes: number;
    operations: number;
    outbox: number;
    epoch: number;
    maintenance: number;
  }>();
  if (
    snapshot.stage !== "claimed" ||
    snapshot.healthy ||
    snapshot.poison ||
    counts?.users !== 1 ||
    counts.nodes !== 1 ||
    counts.operations !== 0 ||
    counts.outbox !== 0 ||
    counts.epoch !== 2 ||
    counts.maintenance !== 0
  )
    throw new Error("fault_drill_resume_state_conflict");
  try {
    await createAndDispatch(env, fixtureIds(env.FAULT_RUN_ID), tracker);
    console.log("fault_drill_resume_dispatched");
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]{3,60}$/.test(error.message) ? error.message : "unknown";
    console.error("fault_drill_resume_failed", code);
    throw new Error("fault_drill_resume_unknown_outcome");
  }
}

/** Inject one scoped D1 read outage at the handler boundary for the fixed poison ID. */
function withFaultedD1(env: FaultEnv): FaultEnv {
  const db = new Proxy(env.DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "prepare")
        return () => {
          throw new Error("fault_drill_injected_d1_outage");
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB: db };
}

export async function runFaultQueue(batch: MessageBatch<unknown>, env: FaultEnv): Promise<void> {
  validRun(env);
  const tracker = state(env);
  const snapshot = await tracker.snapshot(env.FAULT_RUN_ID);
  for (const message of batch.messages) {
    if (
      batch.queue === env.JOBS_QUEUE_NAME &&
      message.body !== null &&
      typeof message.body === "object" &&
      !Array.isArray(message.body) &&
      Object.keys(message.body).length === 1 &&
      (message.body as { faultBootstrap?: unknown }).faultBootstrap === env.FAULT_RUN_ID
    ) {
      try {
        await runFaultCron(env);
        message.ack();
        console.log("fault_drill_bootstrap_queue_completed");
      } catch {
        message.ack(); // Durable claim prevents a safe blind retry after uncertain D1/Queue work.
        console.error("fault_drill_bootstrap_queue_unknown");
      }
      continue;
    }
    if (
      batch.queue === env.JOBS_QUEUE_NAME &&
      message.body !== null &&
      typeof message.body === "object" &&
      !Array.isArray(message.body) &&
      Object.keys(message.body).length === 1 &&
      (message.body as { faultResume?: unknown }).faultResume === env.FAULT_RUN_ID
    ) {
      try {
        await runFaultResume(env);
        message.ack();
      } catch {
        message.ack();
        console.error("fault_drill_resume_queue_unknown");
      }
      continue;
    }
    if (
      batch.queue === env.JOBS_QUEUE_NAME &&
      message.body !== null &&
      typeof message.body === "object" &&
      !Array.isArray(message.body) &&
      Object.keys(message.body).length === 1 &&
      (message.body as { controlProbe?: unknown }).controlProbe === env.FAULT_RUN_ID
    ) {
      try {
        await runControlEvictionProbe(env);
        message.ack();
      } catch {
        // A reset RPC has an uncertain response. Never repeat it automatically.
        message.ack();
        console.error("fault_drill_eviction_unknown");
      }
      continue;
    }
    const id = (message.body as { outboxId?: unknown } | null)?.outboxId;
    if (typeof id !== "string" || (id !== snapshot.healthy && id !== snapshot.poison)) {
      message.ack();
      console.error("fault_drill_unexpected_message");
      continue;
    }
    if (batch.queue === env.JOBS_DLQ_NAME) {
      await tracker.record(env.FAULT_RUN_ID, "deadLetter");
      const result = await handleDeadLetterBatch(env, {
        messages: [
          {
            id: message.id,
            attempts: message.attempts,
            body: message.body,
            ack: () => message.ack(),
            retry: () => message.retry({ delaySeconds: 35 }),
          },
        ],
      });
      if (result.acked === 1) await tracker.record(env.FAULT_RUN_ID, "deadLetterAck");
      console.log(result.acked === 1 ? "fault_drill_dlq_acked" : "fault_drill_dlq_retried");
      continue;
    }
    if (batch.queue !== env.JOBS_QUEUE_NAME) {
      message.ack();
      console.error("fault_drill_unknown_queue");
      continue;
    }
    const isPoison = id === snapshot.poison;
    const result = await handleOutboxBatch(isPoison ? withFaultedD1(env) : env, {
      messages: [
        {
          body: message.body,
          ack: () => message.ack(),
          retry: () => message.retry({ delaySeconds: 35 }),
        },
      ],
    });
    if (isPoison && result.retried === 1) await tracker.record(env.FAULT_RUN_ID, "poisonRetry");
    if (!isPoison && result.acked === 1) await tracker.record(env.FAULT_RUN_ID, "healthyAck");
    console.log(isPoison ? "fault_drill_poison_delivery" : "fault_drill_healthy_delivery");
  }
}

async function runControlEvictionProbe(env: FaultEnv): Promise<void> {
  const tracker = state(env);
  const terminals = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM outbox WHERE state='completed') AS completed,
      (SELECT COUNT(*) FROM outbox WHERE state='failed') AS failed,
      (SELECT COUNT(*) FROM outbox_dead_letters WHERE status='failed') AS dead_letters`,
  ).first<{ completed: number; failed: number; dead_letters: number }>();
  if (terminals?.completed !== 1 || terminals.failed !== 1 || terminals.dead_letters !== 1)
    throw new Error("fault_drill_queue_not_terminal");
  if (!(await tracker.startProbe(env.FAULT_RUN_ID))) return;
  const control = env.CONTROL.get(
    env.CONTROL.idFromName(CONTROL_NAME),
  ) as DurableObjectStub<ControlDO>;
  try {
    const mirror = async () =>
      env.DB.prepare("SELECT epoch,maintenance,gc_paused FROM control WHERE singleton=1").first<{
        epoch: number;
        maintenance: number;
        gc_paused: number;
      }>();
    const d1Before = await mirror();
    const before = await control.drillProbe(env.FAULT_RUN_ID);
    if (
      before.status.epoch !== 2 ||
      before.status.maintenance ||
      !before.auditCompleted ||
      d1Before?.epoch !== 2 ||
      d1Before.maintenance !== 0
    )
      throw new Error("fault_drill_control_not_ready");
    try {
      await control.drillAbort(env.FAULT_RUN_ID);
    } catch {
      // The platform rejects the RPC when ctx.abort() resets this instance.
    }
    let after;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const fresh = env.CONTROL.get(
          env.CONTROL.idFromName(CONTROL_NAME),
        ) as DurableObjectStub<ControlDO>;
        after = await fresh.drillProbe(env.FAULT_RUN_ID);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const d1After = await mirror();
    const passed =
      after !== undefined &&
      after.nonce !== before.nonce &&
      after.status.epoch === before.status.epoch &&
      after.status.maintenance === before.status.maintenance &&
      after.status.gcPaused === before.status.gcPaused &&
      after.auditCompleted &&
      d1After?.epoch === d1Before.epoch &&
      d1After.maintenance === d1Before.maintenance &&
      d1After.gc_paused === d1Before.gc_paused;
    await tracker.finishProbe(env.FAULT_RUN_ID, passed);
    if (!passed) throw new Error("fault_drill_eviction_mismatch");
    console.log("fault_drill_eviction_passed");
  } catch {
    await tracker.finishProbe(env.FAULT_RUN_ID, false).catch(() => {});
    throw new Error("fault_drill_eviction_failed");
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  scheduled(_event: ScheduledController, env: FaultEnv) {
    return runFaultCron(env);
  },
  queue(batch: MessageBatch<unknown>, env: FaultEnv) {
    return runFaultQueue(batch, env);
  },
};
