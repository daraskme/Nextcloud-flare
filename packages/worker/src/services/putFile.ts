import { portableName, searchName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { assertCreateLocks, lockTokenHashes } from "../auth/locks";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, atomicBatch, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
} from "../jobs/operations";
import { consumeKnownLength } from "../platform/stream";
import {
  type DavUploadRow,
  davPublicationFence,
  davUploadMetadata,
  davUploadRow,
  matchesDavObject,
  recordStoredDavUpload,
  type StoredDavBody as StoredBody,
  settleFailedDavUpload,
  startDavUpload,
} from "./davUpload";
import {
  commitMutationStatements,
  type MutationOutcome,
  type MutationPlan,
  type MutationStep,
  mutationStatements,
} from "./fsMutation";
import { observePhysicalObject } from "./physical";

export const DAV_PUT_MAX_BYTES = 95_000_000;
export const DAV_PUT_CREATE_STEPS = 10;
export const DAV_PUT_OVERWRITE_STEPS = 8;

type ContentAuthority = Extract<AuthorizedNode, { operation: "node.content.write" }>;

export interface PutFileRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly parentId: string;
  readonly name: string;
  readonly nodeId?: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly mime: string;
  readonly lockTokens: readonly string[];
}

/** Hash and write the request concurrently without buffering the body in Worker memory. */
async function storeBody(
  bucket: R2Bucket,
  row: DavUploadRow,
  body: ReadableStream<Uint8Array>,
): Promise<StoredBody> {
  const remaining = row.write_lease_expires_at - Date.now();
  if (remaining <= 0) throw new Error("dav_put_write_expired");
  const stored = await consumeKnownLength(
    body,
    row.declared_size,
    async (stream) => {
      const object = await bucket.put(`u/${row.owner_id}/b/${row.blob_id}`, stream, {
        onlyIf: { etagDoesNotMatch: "*" },
        customMetadata: davUploadMetadata(row),
      });
      if (!object || !matchesDavObject(row, object)) throw new Error("dav_put_write_failed");
      return object;
    },
    AbortSignal.timeout(remaining),
  );
  return { object: stored.value, sha256: stored.sha256 };
}

function blobSteps(
  op: string,
  ownerId: string,
  size: number,
  mime: string,
  stored: StoredBody,
): MutationStep[] {
  const blob = `${op}_blob`;
  const key = `u/${ownerId}/b/${blob}`;
  const clock = "strftime('%s','now')*1000";
  return [
    {
      kind: "blob",
      affectedId: blob,
      statement: {
        sql: `UPDATE blobs SET state='committed',mime_sniffed=?,last_op_id=?
          WHERE id=? AND owner_id=? AND r2_key=? AND size=? AND sha256_verified=? AND r2_etag=? AND state='staging' AND ref_count=0`,
        values: [mime, op, blob, ownerId, key, size, stored.sha256, stored.object.etag],
      },
    },
    {
      kind: "upload",
      affectedId: "dav_" + op,
      statement: {
        sql: `UPDATE uploads SET state='completed',cleanup_pending=0,last_progress_at=MAX(last_progress_at,${clock})
          WHERE id=? AND source='dav' AND completion_op_id=? AND state='completing' AND in_flight=0`,
        values: ["dav_" + op, op],
      },
    },
  ];
}

function reservationStep(claim: OperationClaim, ownerId: string): MutationStep {
  return {
    kind: "reservation",
    affectedId: `${claim.intent.id}_reservation`,
    statement: {
      sql: `UPDATE reservations SET state='consumed'
        WHERE id=? AND owner_id=? AND epoch=? AND state='reserved'
          AND expires_at>strftime('%s','now')*1000
          AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)`,
      values: [`${claim.intent.id}_reservation`, ownerId, claim.permit.epoch, claim.permit.epoch],
    },
  };
}

function createPlan(
  claim: OperationClaim,
  authorized: Extract<AuthorizedNode, { operation: "node.create" }>,
  request: PutFileRequest,
  stored: StoredBody,
  hashes: readonly string[],
): MutationPlan {
  if (request.principal.kind !== "app_password") throw new Error("invalid_dav_put");
  const name = portableName(request.name);
  const search = searchName(name.name);
  const op = claim.intent.id;
  const node = `${op}_node`;
  const blob = `${op}_blob`;
  const parent = authorized.parent;
  const clock = "strftime('%s','now')*1000";
  return {
    claim,
    authorized,
    lockHashes: hashes,
    result: { status: 201, nodeId: node },
    steps: [
      reservationStep(claim, parent.owner_id),
      ...blobSteps(op, parent.owner_id, request.size, request.mime, stored),
      {
        kind: "node",
        affectedId: node,
        statement: {
          sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,hidden,last_op_id,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'file',?,?,?,${clock},${clock})`,
          values: [
            node,
            parent.space_id,
            parent.owner_id,
            parent.id,
            name.name,
            name.nameCi,
            blob,
            name.hidden ? 1 : 0,
            op,
          ],
        },
      },
      {
        kind: "parent",
        affectedId: parent.id,
        statement: {
          sql: `UPDATE nodes SET revision=revision+1,updated_at=${clock},last_op_id=? WHERE id=? AND revision=? AND deleted_at IS NULL`,
          values: [op, parent.id, parent.revision],
        },
      },
      {
        kind: "tree",
        affectedId: parent.space_id,
        statement: {
          sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
          values: [parent.space_id, parent.tree_generation],
        },
      },
      {
        kind: "search_index",
        affectedId: node,
        statement: {
          sql: "INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision) VALUES(?,?,?,?,?,1)",
          values: [node, parent.space_id, search.textNorm, search.tokens, search.version],
        },
      },
      {
        kind: "search_fts",
        affectedId: node,
        statement: {
          sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id=?",
          values: [node],
        },
      },
      {
        kind: "activity",
        affectedId: node,
        statement: {
          sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'dav.put',?,${clock})`,
          values: [`${op}_activity`, op, request.principal.user_id, node],
        },
      },
      {
        kind: "outbox",
        affectedId: node,
        statement: {
          sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',?,${clock},${clock})`,
          values: [`${op}_event`, op, node, claim.permit.epoch],
        },
      },
    ],
  };
}

function overwriteStatements(
  claim: OperationClaim,
  authorized: ContentAuthority,
  request: PutFileRequest,
  stored: StoredBody,
  hashes: readonly string[],
): readonly SqlStatement[] {
  if (request.principal.kind !== "app_password") throw new Error("invalid_dav_put");
  const op = claim.intent.id;
  const node = authorized.node;
  const blob = `${op}_blob`;
  const clock = "strftime('%s','now')*1000";
  const steps: MutationStep[] = [
    reservationStep(claim, node.owner_id),
    ...blobSteps(op, node.owner_id, request.size, request.mime, stored),
    {
      kind: "version",
      affectedId: node.current_blob_id!,
      statement: {
        sql: `INSERT INTO node_versions(id,node_id,blob_id,revision,created_at) VALUES(?,?,?,?,${clock})`,
        values: [`${op}_version`, node.id, node.current_blob_id, node.revision],
      },
    },
    {
      kind: "node",
      affectedId: node.id,
      statement: {
        sql: `UPDATE nodes SET current_blob_id=?,revision=revision+1,last_op_id=?,updated_at=${clock} WHERE id=? AND parent_id=? AND revision=? AND current_blob_id=? AND kind='file' AND deleted_at IS NULL`,
        values: [blob, op, node.id, authorized.parentId, node.revision, node.current_blob_id],
      },
    },
    {
      kind: "search_index",
      affectedId: node.id,
      statement: {
        sql: "UPDATE search_index SET revision=? WHERE node_id=? AND revision=? AND space_id=?",
        values: [node.revision + 1, node.id, node.revision, node.space_id],
      },
    },
    {
      kind: "activity",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'dav.put',?,${clock})`,
        values: [`${op}_activity`, op, request.principal.user_id, node.id],
      },
    },
    {
      kind: "outbox",
      affectedId: node.id,
      statement: {
        sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.updated',?,'pending',?,${clock},${clock})`,
        values: [`${op}_event`, op, node.id, claim.permit.epoch],
      },
    },
  ];
  if (steps.length !== DAV_PUT_OVERWRITE_STEPS || !node.current_blob_id)
    throw new Error("invalid_mutation_plan");
  const statements: SqlStatement[] = [
    assertOpenPermit(claim.permit),
    assertOperationClaim(claim),
    authorizationAssertion(authorized),
    assertCreateLocks(node.id, node.space_id, request.principal, hashes),
    assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [op]),
  ];
  steps.forEach((step, index) =>
    statements.push(
      step.statement,
      assertOneChange,
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [op, index + 1, step.kind, step.affectedId],
      },
      assertOneChange,
    ),
  );
  statements.push(
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=${clock} WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
      values: [
        JSON.stringify({ status: 204, nodeId: node.id, revision: node.revision + 1 }),
        op,
        op,
      ],
    },
    assertOneChange,
  );
  return statements;
}

export async function putFile(
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS" | "CONTROL">,
  request: PutFileRequest,
): Promise<MutationOutcome> {
  if (
    request.principal.kind !== "app_password" ||
    !Number.isSafeInteger(request.size) ||
    request.size < 0 ||
    request.size > DAV_PUT_MAX_BYTES ||
    !/^[\x20-\x7e]{1,255}$/.test(request.mime)
  )
    throw new Error("invalid_dav_put");
  const name = portableName(request.name);
  const create = request.nodeId === undefined;
  const steps = create ? DAV_PUT_CREATE_STEPS : DAV_PUT_OVERWRITE_STEPS;
  const intent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    "dav.put",
    {
      parentId: request.parentId,
      nodeId: request.nodeId ?? null,
      name: name.name,
      size: request.size,
      mime: request.mime,
    },
    { parentId: request.parentId, ...(request.nodeId ? { nodeId: request.nodeId } : {}) },
  );
  const existing = await findOperationIntent(env.DB, intent, steps);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    const upload = await davUploadRow(env.DB, intent.id);
    if (operation.state === "failed" && upload) await settleFailedDavUpload(env, upload);
    await request.body.cancel();
    return { kind: "terminal", operation };
  }
  if (existing && (await davUploadRow(env.DB, intent.id))) {
    // A protocol retry uses a new request ID; the old immutable attempt never dispatches twice.
    if (!(await lookupOperation(env.DB, request.principal, intent.id)))
      throw new Error("authorization_denied");
    await request.body.cancel();
    return { kind: "commit_unknown", operationId: intent.id };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = create
    ? await lock.acquireCreate({
        requestId: intent.id,
        spaceId: request.spaceId,
        parentId: request.parentId,
        principal: request.principal,
        lockTokens: request.lockTokens,
      })
    : await lock.acquireNodeWrite({
        requestId: intent.id,
        spaceId: request.spaceId,
        nodeId: request.nodeId!,
        principal: request.principal,
        lockTokens: request.lockTokens,
        operation: "node.content.write",
      });
  let terminal = false;
  try {
    const authorized = create
      ? await authorizeNode(env.DB, request.principal, {
          operation: "node.create",
          parentId: request.parentId,
          spaceId: request.spaceId,
        })
      : await authorizeNode(env.DB, request.principal, {
          operation: "node.content.write",
          nodeId: request.nodeId!,
          spaceId: request.spaceId,
        });
    if (
      (create && authorized.operation !== "node.create") ||
      (!create &&
        (authorized.operation !== "node.content.write" ||
          authorized.parentId !== request.parentId ||
          authorized.node.name !== name.name))
    )
      throw new Error("authorization_denied");
    const ownerId =
      authorized.operation === "node.create"
        ? authorized.parent.owner_id
        : authorized.node.owner_id;
    const claimed = await claimOperation(env.DB, intent, permit, authorized, steps);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, request.principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      const upload = await davUploadRow(env.DB, intent.id);
      if (operation.state === "failed" && upload) await settleFailedDavUpload(env, upload);
      await request.body.cancel();
      return { kind: "terminal", operation };
    }
    let upload: DavUploadRow;
    try {
      upload = await startDavUpload(
        env.DB,
        claimed.claim,
        authorized,
        { ...request, name: name.name },
        ownerId,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("quota_exceeded")) {
        try {
          await atomicBatch(env.DB, [
            assertOpenPermit(claimed.claim.permit),
            assertOperationClaim(claimed.claim),
            {
              sql: `UPDATE operations SET state='failed',error_code='quota_exceeded',updated_at=strftime('%s','now')*1000
                WHERE op_id=? AND state='claimed'`,
              values: [intent.id],
            },
            assertOneChange,
          ]);
          terminal = true;
        } catch {
          /* A concurrent permit transition is reconciled by lease recovery. */
        }
      }
      throw error;
    }
    let stored: StoredBody;
    try {
      stored = await storeBody(env.BLOBS, upload, request.body);
      await recordStoredDavUpload(env, upload, stored);
      upload.state = "completing";
    } catch (error) {
      // A response/stream failure cannot prove absence. Keep the durable hold until expiry cleanup.
      try {
        await observePhysicalObject(env, env.BLOBS, upload.blob_id, upload.epoch);
      } catch {
        /* The reservation covers unobserved storage. */
      }
      throw error;
    }
    const hashes = await lockTokenHashes(request.lockTokens);
    let outcome: MutationOutcome;
    if (authorized.operation === "node.create") {
      outcome = await commitMutationStatements(env.DB, claimed.claim, [
        davPublicationFence(upload, stored),
        ...mutationStatements(createPlan(claimed.claim, authorized, request, stored, hashes)),
      ]);
    } else if (authorized.operation === "node.content.write") {
      outcome = await commitMutationStatements(env.DB, claimed.claim, [
        davPublicationFence(upload, stored),
        ...overwriteStatements(claimed.claim, authorized, request, stored, hashes),
      ]);
    } else {
      throw new Error("authorization_denied");
    }
    terminal = outcome.kind === "terminal";
    if (outcome.kind === "terminal" && outcome.operation.state !== "committed") {
      await settleFailedDavUpload(env, upload);
    }
    return outcome;
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* Lease recovery releases it. */
      }
  }
}
