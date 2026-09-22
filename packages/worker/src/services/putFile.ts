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
import {
  commitMutationStatements,
  fsMutation,
  type MutationOutcome,
  type MutationPlan,
  type MutationStep,
} from "./fsMutation";
import { finishReservationStatements, reservationStatements } from "./quota";

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

interface StoredBody {
  readonly object: R2Object;
  readonly sha256: string;
}

/** Hash and write the request concurrently without buffering the body in Worker memory. */
async function storeBody(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  size: number,
): Promise<StoredBody> {
  const DigestStream = (
    crypto as unknown as {
      DigestStream: new (
        algorithm: "SHA-256",
      ) => WritableStream<Uint8Array> & {
        readonly digest: Promise<ArrayBuffer>;
      };
    }
  ).DigestStream;
  if (!DigestStream) throw new Error("digest_stream_unavailable");
  const fixed = new FixedLengthStream(size);
  const digest = new DigestStream("SHA-256");
  const objectPromise = bucket.put(key, fixed.readable);
  const source = body.getReader();
  const objectWriter = fixed.writable.getWriter();
  const digestWriter = digest.getWriter();
  try {
    for (;;) {
      const chunk = await source.read();
      if (chunk.done) break;
      await Promise.all([objectWriter.write(chunk.value), digestWriter.write(chunk.value)]);
    }
    await Promise.all([objectWriter.close(), digestWriter.close()]);
  } catch (error) {
    await Promise.allSettled([
      objectWriter.abort(error),
      digestWriter.abort(error),
      source.cancel(error),
    ]);
    throw error;
  }
  const [object, hash] = await Promise.all([objectPromise, digest.digest]);
  if (!object || object.size !== size || !object.etag) throw new Error("dav_put_write_failed");
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { object, sha256 };
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
        sql: `INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,content_etag,r2_etag,mime_sniffed,state,created_at,last_op_id)
          VALUES(?,?,?,?,?,?,?,?,'committed',${clock},?)`,
        values: [
          blob,
          ownerId,
          key,
          size,
          stored.sha256,
          `"b-${blob}"`,
          stored.object.etag,
          mime,
          op,
        ],
      },
    },
    {
      kind: "blob_storage",
      affectedId: blob,
      statement: {
        sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,?,?,${clock})`,
        values: [blob, size, stored.object.etag],
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
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS">,
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
    return { kind: "terminal", operation };
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
  let reserved = false;
  let ownerId: string | undefined;
  let key: string | undefined;
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
    ownerId =
      authorized.operation === "node.create"
        ? authorized.parent.owner_id
        : authorized.node.owner_id;
    key = `u/${ownerId}/b/${intent.id}_blob`;
    const claimed = await claimOperation(env.DB, intent, permit, authorized, steps);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, request.principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const reservationId = `${intent.id}_reservation`;
    try {
      await atomicBatch(env.DB, [
        assertOpenPermit(claimed.claim.permit),
        assertOperationClaim(claimed.claim),
        authorizationAssertion(authorized),
        ...reservationStatements({
          id: reservationId,
          ownerId,
          bytes: request.size,
          expiresAt: Date.now() + 86_400_000,
          epoch: request.principal.epoch,
          operationId: intent.id,
        }),
      ]);
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
    reserved = true;
    const stored = await storeBody(env.BLOBS, key, request.body, request.size);
    const hashes = await lockTokenHashes(request.lockTokens);
    let outcome: MutationOutcome;
    if (authorized.operation === "node.create") {
      outcome = await fsMutation(
        env.DB,
        createPlan(claimed.claim, authorized, request, stored, hashes),
      );
    } else if (authorized.operation === "node.content.write") {
      outcome = await commitMutationStatements(
        env.DB,
        claimed.claim,
        overwriteStatements(claimed.claim, authorized, request, stored, hashes),
      );
    } else {
      throw new Error("authorization_denied");
    }
    terminal = outcome.kind === "terminal";
    if (outcome.kind === "terminal" && outcome.operation.state !== "committed") {
      await env.BLOBS.delete(key);
      try {
        await atomicBatch(
          env.DB,
          finishReservationStatements(reservationId, ownerId, request.principal.epoch, "released"),
        );
        reserved = false;
      } catch {
        /* Expiry cleanup releases a reservation when this response is lost. */
      }
    }
    return outcome;
  } catch (error) {
    try {
      if (key) await env.BLOBS.delete(key);
    } catch {
      /* orphan audit handles an ambiguous R2 delete. */
    }
    if (reserved && ownerId)
      try {
        await atomicBatch(
          env.DB,
          finishReservationStatements(
            `${intent.id}_reservation`,
            ownerId,
            request.principal.epoch,
            "released",
          ),
        );
      } catch {
        /* Expiry cleanup releases a reservation when this response is lost. */
      }
    throw error;
  } finally {
    if (terminal)
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* Lease recovery releases it. */
      }
  }
}
