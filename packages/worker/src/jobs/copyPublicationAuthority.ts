import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { principalSelection, storedPrincipal } from "../auth/selectedShare";
import { assertExists, primary, type SqlStatement } from "../db/primary";
import type { OperationRow } from "./operations";

// Group predicates to leave headroom when embedded in the D1 recovery fence (depth limit 100).
export const COPY_PUBLICATION_BINDING_SQL = `SELECT a.* FROM operations p JOIN bulk_jobs j ON j.id=json_extract(p.operands_json,'$.jobId')
    JOIN operations a ON a.op_id=j.op_id JOIN copy_job_manifests m ON m.job_id=j.id
    WHERE p.op_id=?
      AND (p.kind='copy.publish' AND p.principal_kind='user' AND a.kind='copy.enqueue' AND a.state='committed')
      AND (j.kind='node.copy' AND j.id='copy_'||substr(a.op_id,4) AND j.epoch=a.epoch AND j.credential_id=a.credential_id)
      AND (p.principal_id=a.principal_id AND p.credential_id=a.credential_id AND p.epoch=a.epoch
        AND p.space_id=a.destination_space_id AND p.destination_space_id IS NULL)
      AND (p.selected_share_id IS a.destination_share_id AND p.selected_share_version IS a.destination_share_version)
      AND (json_extract(p.operands_json,'$.parentId')=json_extract(a.operands_json,'$.parentId')
        AND json_extract(p.operands_json,'$.overwriteTargetId') IS json_extract(a.operands_json,'$.overwriteTargetId')
        AND json_extract(p.operands_json,'$.manifestDigest')=m.sha256)
      AND (p.state<>'committed' OR (j.state='completed' AND j.publish_op_id=p.op_id
        AND j.published_root_id=json_extract(p.result_json,'$.nodeId')))`;

/** Publication lives in the destination space; source authority remains bound to acceptance. */
export async function copyPublicationAuthority(
  db: D1Database,
  operationId: string,
  principal: Principal,
): Promise<SqlStatement[]> {
  const accepted = await primary(db)
    .prepare(COPY_PUBLICATION_BINDING_SQL)
    .bind(operationId)
    .first<OperationRow>();
  if (
    !accepted ||
    principal.kind !== "user" ||
    principal.user_id !== accepted.principal_id ||
    principal.credential_id !== accepted.credential_id
  )
    throw new Error("authorization_denied");
  const source = storedPrincipal(
    {
      kind: "user",
      user_id: principal.user_id,
      credential_id: principal.credential_id,
      epoch: principal.epoch,
    },
    accepted,
  );
  const operands = JSON.parse(accepted.operands_json) as { sourceNodeId: string };
  const authorized = await authorizeNode(db, source, {
    operation: "node.read",
    nodeId: operands.sourceNodeId,
    spaceId: accepted.space_id,
    ownerOnly: !principalSelection(source),
  });
  return [
    assertExists(COPY_PUBLICATION_BINDING_SQL, [operationId]),
    authorizationAssertion(authorized),
  ];
}
