import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { type AuthorizedNode, authorizationAssertion, type Principal } from "../../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../../auth/locks";
import type { UploadCapabilities } from "../../auth/uploadCapability";
import { assertOpenPermit } from "../../db/permits";
import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../../db/primary";
import type { Env } from "../../env";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
  validateClaimAuthorization,
} from "../../jobs/operations";
import {
  commitMutationStatements,
  type MutationOutcome,
  type MutationStep,
  mutationStatements,
} from "../fsMutation";
import { accessUpload, type UploadRow, uploadFence } from "./access";
import { settleFailedCompletion } from "./failedCompletion";
import { multipartHeadCharge, multipartObjectProof, multipartPartsProof } from "./multipartProof";

const CLOCK = "strftime('%s','now')*1000";

function steps(
  row: UploadRow,
  claim: OperationClaim,
  authority: AuthorizedNode,
  actor: string,
): MutationStep[] {
  const op = claim.intent.id;
  const create = authority.operation === "node.create";
  if (!create && authority.operation !== "node.content.write")
    throw new Error("invalid_upload_authority");
  const name = portableName(row.upload_name);
  const search = searchName(name.name);
  const nodeId = create ? `${op}_node` : authority.node.id;
  return [
    {
      kind: "reservation",
      affectedId: row.reservation_id,
      statement: {
        sql: "UPDATE reservations SET state='consumed' WHERE id=? AND state='reserved' AND epoch=?",
        values: [row.reservation_id, row.epoch],
      },
    },
    {
      kind: "blob",
      affectedId: row.blob_id,
      statement: {
        sql: `UPDATE blobs SET state='committed',last_op_id=? WHERE id=? AND state='staging'
          AND sha256_verified ${row.mode === "single" ? "IS NOT NULL" : "IS NULL"}`,
        values: [op, row.blob_id],
      },
    },
    ...(create
      ? [
          {
            kind: "node",
            affectedId: nodeId,
            statement: {
              sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,hidden,last_op_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'file',?,?,?,${CLOCK},${CLOCK})`,
              values: [
                nodeId,
                row.space_id,
                row.owner_id,
                row.parent_id,
                name.name,
                name.nameCi,
                row.blob_id,
                name.hidden ? 1 : 0,
                op,
              ],
            },
          },
          {
            kind: "parent",
            affectedId: row.parent_id,
            statement: {
              sql: `UPDATE nodes SET revision=revision+1,updated_at=${CLOCK},last_op_id=? WHERE id=? AND revision=? AND deleted_at IS NULL`,
              values: [op, row.parent_id, authority.parent.revision],
            },
          },
          {
            kind: "tree",
            affectedId: row.space_id,
            statement: {
              sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
              values: [row.space_id, authority.parent.tree_generation],
            },
          },
          {
            kind: "search_index",
            affectedId: nodeId,
            statement: {
              sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
              values: [nodeId, row.space_id, search.textNorm, search.tokens, search.version],
            },
          },
          {
            kind: "search_fts",
            affectedId: nodeId,
            statement: {
              sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
              values: [nodeId],
            },
          },
        ]
      : [
          {
            kind: "version",
            affectedId: authority.node.current_blob_id!,
            statement: {
              sql: `INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES(?,?,?,?,${CLOCK})`,
              values: [
                `${op}_version`,
                nodeId,
                authority.node.current_blob_id,
                authority.node.revision,
              ],
            },
          },
          {
            kind: "node",
            affectedId: nodeId,
            statement: {
              sql: `UPDATE nodes SET current_blob_id=?,revision=revision+1,last_op_id=?,updated_at=${CLOCK}
          WHERE id=? AND parent_id=? AND revision=? AND current_blob_id=? AND deleted_at IS NULL`,
              values: [
                row.blob_id,
                op,
                nodeId,
                row.parent_id,
                row.target_revision,
                authority.node.current_blob_id,
              ],
            },
          },
          {
            kind: "search_index",
            affectedId: nodeId,
            statement: {
              sql: "UPDATE search_index SET revision=revision+1 WHERE node_id=? AND revision=?",
              values: [nodeId, row.target_revision],
            },
          },
        ]),
    {
      kind: "upload",
      affectedId: row.id,
      statement: {
        sql: "UPDATE uploads SET state='completed',in_flight=0,accept_parts=0 WHERE id=? AND state='completing' AND completion_op_id=?",
        values: [row.id, op],
      },
    },
    {
      kind: "activity",
      affectedId: nodeId,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'upload.complete',?,${CLOCK})`,
        values: [`${op}_activity`, op, actor, nodeId],
      },
    },
    {
      kind: "outbox",
      affectedId: nodeId,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
        VALUES(?,?,?,?,'pending',?,${CLOCK},${CLOCK})`,
        values: [`${op}_event`, op, create ? "node.created" : "node.updated", nodeId, row.epoch],
      },
    },
  ];
}

export async function completeSingleUpload(
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS" | "CONTROL">,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  requestId: string,
  lockTokens: readonly string[],
): Promise<MutationOutcome> {
  return completeUpload(
    env,
    principal,
    id,
    capability,
    capabilities,
    requestId,
    lockTokens,
    "single",
  );
}

/** Internal publication after R2 multipart completion and an independently observed object proof. */
export async function publishMultipartUpload(
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS" | "CONTROL">,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  requestId: string,
  lockTokens: readonly string[],
): Promise<MutationOutcome> {
  return completeUpload(
    env,
    principal,
    id,
    capability,
    capabilities,
    requestId,
    lockTokens,
    "multipart",
  );
}

async function completeUpload(
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS" | "CONTROL">,
  principal: Principal,
  id: string,
  capability: string,
  capabilities: UploadCapabilities,
  requestId: string,
  lockTokens: readonly string[],
  mode: "single" | "multipart",
): Promise<MutationOutcome> {
  const { row, authorized } = await accessUpload(
    env.DB,
    principal,
    id,
    capability,
    capabilities,
    false,
    "receipt",
  );
  if (principal.kind !== "user" || row.mode !== mode) throw new Error("invalid_upload_complete");
  if (row.completion_op_id) {
    const saved = await lookupOperation(env.DB, principal, row.completion_op_id);
    if (saved && saved.state !== "claimed") {
      if (saved.state === "failed") await settleFailedCompletion(env, row, saved.id);
      return { kind: "terminal", operation: saved };
    }
  }
  if (row.state !== "completing" || row.in_flight !== 0) throw new Error("upload_content_pending");
  if (row.expires_at <= Date.now() || row.last_progress_at <= Date.now() - 86400000)
    throw new Error("upload_expired");
  await atomicBatch(env.DB, [authorizationAssertion(authorized), uploadFence(row, ["completing"])]);
  if (mode === "multipart") {
    await atomicBatch(env.DB, [
      authorizationAssertion(authorized),
      uploadFence(row, ["completing"]),
      multipartPartsProof(row),
      multipartObjectProof(row),
    ]);
  }
  if (
    authorized.operation === "node.content.write" &&
    authorized.node.revision !== row.target_revision
  )
    throw new Error("upload_target_changed");
  const expectedSteps = row.target_id ? 8 : 10;
  const intent = await operationIntent(
    principal,
    requestId,
    row.space_id,
    "upload.complete",
    { uploadId: id, digest: row.request_digest },
    { parentId: row.parent_id, uploadId: id, ...(row.target_id ? { nodeId: row.target_id } : {}) },
  );
  if (row.completion_op_id && row.completion_op_id !== intent.id)
    throw new Error("idempotency_conflict");
  await findOperationIntent(env.DB, intent, expectedSteps);
  const lock = env.LOCKS.get(env.LOCKS.idFromName(row.space_id));
  const permit = row.target_id
    ? await lock.acquireNodeWrite({
        requestId: intent.id,
        spaceId: row.space_id,
        nodeId: row.target_id,
        principal,
        lockTokens,
        operation: "node.content.write",
      })
    : await lock.acquireCreate({
        requestId: intent.id,
        spaceId: row.space_id,
        parentId: row.parent_id,
        principal,
        lockTokens,
      });
  let terminal = false;
  try {
    const claimed = await claimOperation(env.DB, intent, permit, authorized, expectedSteps);
    if (claimed.kind !== "claimed") {
      const operation = await lookupOperation(env.DB, principal, intent.id);
      if (!operation) throw new Error("upload_authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    await atomicBatch(env.DB, [
      assertOperationClaim(claimed.claim),
      assertOpenPermit(permit),
      authorizationAssertion(authorized),
      uploadFence(row, ["completing"]),
      {
        sql: "UPDATE uploads SET completion_op_id=? WHERE id=? AND (completion_op_id IS NULL OR completion_op_id=?)",
        values: [intent.id, id, intent.id],
      },
      assertOneChange,
      ...(mode === "multipart" ? multipartHeadCharge(row) : []),
    ]);
    const object = await env.BLOBS.head(`u/${row.owner_id}/b/${row.blob_id}`);
    if (
      !object ||
      object.size !== row.declared_size ||
      object.customMetadata?.upload_id !== id ||
      object.customMetadata.attempt_id !== row.write_attempt_id ||
      object.customMetadata.blob_id !== row.blob_id ||
      object.customMetadata.epoch !== String(row.epoch)
    )
      throw new Error("upload_object_mismatch");
    const hashes = await lockTokenHashes(lockTokens);
    const planSteps = steps(row, claimed.claim, authorized, principal.user_id);
    const guards: SqlStatement[] = [
      uploadFence(row, ["completing"]),
      ...(mode === "multipart" ? [multipartPartsProof(row), multipartObjectProof(row)] : []),
      assertExists(
        `SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id
        WHERE b.id=? AND b.owner_id=? AND b.state='staging'
          AND b.sha256_verified ${mode === "single" ? "IS NOT NULL" : "IS NULL"}
          AND b.size=? AND b.r2_etag=? AND s.bytes=b.size AND s.r2_etag=b.r2_etag AND s.removed_at IS NULL`,
        [row.blob_id, row.owner_id, row.declared_size, object.etag],
      ),
    ];
    let statements: SqlStatement[];
    if (authorized.operation === "node.create") {
      statements = [
        ...guards,
        ...mutationStatements({
          claim: claimed.claim,
          authorized,
          lockHashes: hashes,
          steps: planSteps,
          result: { status: 201, nodeId: `${intent.id}_node` },
        }),
      ];
    } else if (authorized.operation === "node.content.write") {
      statements = [
        assertOpenPermit(permit),
        assertOperationClaim(claimed.claim),
        validateClaimAuthorization(intent, permit, authorized, expectedSteps),
        ...guards,
        assertCreateLocks(authorized.node.id, row.space_id, principal, hashes),
        assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [
          intent.id,
        ]),
      ];
      for (const [index, step] of planSteps.entries())
        statements.push(
          step.statement,
          assertOneChange,
          {
            sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
            values: [intent.id, index + 1, step.kind, step.affectedId],
          },
          assertOneChange,
        );
      statements.push(
        {
          sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${CLOCK})
        WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
          values: [JSON.stringify({ status: 204, nodeId: row.target_id }), intent.id, intent.id],
        },
        assertOneChange,
      );
    } else throw new Error("invalid_upload_authority");
    const outcome = await commitMutationStatements(env.DB, claimed.claim, statements);
    terminal = outcome.kind === "terminal";
    if (outcome.kind === "terminal" && outcome.operation.state === "failed") {
      // A known failed operation may release its reservation; unknown commits never compensate.
      await settleFailedCompletion(env, row, intent.id);
    }
    return outcome;
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* lease recovery */
      }
  }
}
