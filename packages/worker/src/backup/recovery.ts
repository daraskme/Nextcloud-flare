import type { Env } from "../env.js";
import {
  bumpRecoveryEpoch,
  getRuntimeControl,
  setGcPaused,
  setMaintenance,
} from "../services/control.js";
import { runGarbageCollection } from "../services/gc.js";

export interface RecoveryVerification {
  rootViolations: number;
  refViolations: number;
  quotaViolations: number;
  missingObjects: string[];
}

export async function beginRecovery(
  env: Env,
  input: { id: string; kind: "time_travel" | "logical_export"; sourceGeneration: string },
): Promise<void> {
  const control = await getRuntimeControl(env);
  await setMaintenance(env, true);
  await setGcPaused(env, true);
  await env.DB.batch([
    env.DB.prepare("UPDATE permits SET state='revoked' WHERE state='open'"),
    env.DB.prepare(
      "UPDATE operations SET state='failed',error_code='recovery_fence',updated_at=?1 WHERE state='claimed'",
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO recovery_runs(id,kind,state,source_generation,epoch_before,epoch_after,checkpoint,details_json,created_at,completed_at) VALUES(?1,?2,'started',?3,?4,NULL,NULL,NULL,?5,NULL)",
    ).bind(input.id, input.kind, input.sourceGeneration, control.epoch, Date.now()),
  ]);
}

export async function verifyRecovery(env: Env, limit = 1000): Promise<RecoveryVerification> {
  const roots = await env.DB.prepare(
    "SELECT COUNT(*) count FROM spaces s WHERE NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=s.root_node_id AND n.space_id=s.id AND n.owner_id=s.owner_id AND n.kind='root' AND n.parent_id IS NULL AND n.deleted_at IS NULL)",
  ).first<{ count: number }>();
  const refs = await env.DB.prepare(
    "SELECT COUNT(*) count FROM blobs b WHERE b.ref_count<>(SELECT COUNT(*) FROM nodes n WHERE n.current_blob_id=b.id)+(SELECT COUNT(*) FROM node_versions v WHERE v.blob_id=b.id)+(SELECT COUNT(*) FROM blob_pins p WHERE p.blob_id=b.id)",
  ).first<{ count: number }>();
  const quotas = await env.DB.prepare(
    "SELECT COUNT(*) count FROM users u WHERE u.used_bytes<>COALESCE((SELECT SUM(size) FROM blobs b WHERE b.owner_id=u.id AND b.ref_count>0 AND b.state NOT IN ('deleted')),0)",
  ).first<{ count: number }>();
  const objects = await env.DB.prepare(
    "SELECT id,r2_key key FROM blobs WHERE state NOT IN ('deleted') ORDER BY id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string; key: string }>();
  const missingObjects: string[] = [];
  for (const object of objects.results) {
    if ((await env.BLOBS.head(object.key)) === null) missingObjects.push(object.id);
  }
  return {
    rootViolations: roots?.count ?? 0,
    refViolations: refs?.count ?? 0,
    quotaViolations: quotas?.count ?? 0,
    missingObjects,
  };
}

export async function finishRecovery(env: Env, recoveryId: string): Promise<RecoveryVerification> {
  const control = await getRuntimeControl(env);
  if (!control.maintenance || !control.gcPaused) throw new Error("recovery_not_quiesced");
  await runGarbageCollection(env, { limit: 1000, allowPaused: true, deletingOnly: true });
  const deleting = await env.DB.prepare(
    "SELECT COUNT(*) count FROM gc_candidates WHERE state='deleting'",
  ).first<{ count: number }>();
  if ((deleting?.count ?? 0) > 0) throw new Error("recovery_gc_busy");
  const verification = await verifyRecovery(env);
  if (
    verification.rootViolations > 0 ||
    verification.refViolations > 0 ||
    verification.quotaViolations > 0 ||
    verification.missingObjects.length > 0
  ) {
    await env.DB.prepare(
      "UPDATE recovery_runs SET state='failed',details_json=?1,completed_at=?2 WHERE id=?3 AND state='started'",
    )
      .bind(JSON.stringify(verification), Date.now(), recoveryId)
      .run();
    throw new Error("recovery_verification_failed");
  }
  const epoch = await bumpRecoveryEpoch(env, `recovery:${recoveryId}`);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE recovery_runs SET state='verified',epoch_after=?1,details_json=?2,completed_at=?3 WHERE id=?4 AND state='started'",
    ).bind(epoch, JSON.stringify(verification), Date.now(), recoveryId),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
  await setMaintenance(env, false);
  await setGcPaused(env, false);
  return verification;
}
