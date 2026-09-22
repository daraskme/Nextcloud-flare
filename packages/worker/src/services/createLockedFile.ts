import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { authorizeNode, type Principal } from "../auth/authorize";
import { lockTokenHashes } from "../auth/locks";
import type { DavLockResult } from "../do/LockDO";
import type { Env } from "../env";
import {
  claimOperation,
  findOperationIntent,
  lookupOperation,
  operationIntent,
} from "../jobs/operations";
import { fsMutation, type MutationOutcome, type MutationPlan } from "./fsMutation";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const CREATE_LOCKED_FILE_STEPS = 10;

export interface CreateLockedFileRequest {
  readonly principal: Principal;
  readonly requestId: string;
  readonly spaceId: string;
  readonly parentId: string;
  readonly name: string;
  readonly displayHref: string;
  readonly depth: "0" | "infinity";
  readonly ownerText: string;
  readonly timeoutSeconds: number;
  readonly lockTokens: readonly string[];
}

export type CreateLockedFileOutcome =
  | {
      readonly kind: "locked";
      readonly outcome: Extract<MutationOutcome, { kind: "terminal" }>;
      readonly lock: DavLockResult;
    }
  | {
      readonly kind: "commit_unknown";
      readonly outcome: Extract<MutationOutcome, { kind: "commit_unknown" }>;
    };

function lockedFilePlan(
  claim: MutationPlan["claim"],
  authorized: MutationPlan["authorized"],
  request: CreateLockedFileRequest,
  object: { readonly etag: string },
  tokenHash: string,
  submittedLockHashes: readonly string[],
): MutationPlan {
  const name = portableName(request.name);
  const search = searchName(name.name);
  const op = claim.intent.id;
  const node = `${op}_node`;
  const blob = `${op}_blob`;
  const lock = `${op}_lock`;
  const parent = authorized.parent;
  const key = `u/${parent.owner_id}/b/${blob}`;
  const clock = "strftime('%s','now')*1000";
  return {
    claim,
    authorized,
    lockHashes: submittedLockHashes,
    result: { status: 201, nodeId: node },
    steps: [
      {
        kind: "blob",
        affectedId: blob,
        statement: {
          sql: `INSERT INTO blobs(id,owner_id,r2_key,size,sha256_verified,content_etag,r2_etag,mime_sniffed,state,created_at,last_op_id)
            VALUES(?,?,?,0,?,?,?,'application/octet-stream','committed',${clock},?)`,
          values: [blob, parent.owner_id, key, EMPTY_SHA256, `"b-${blob}"`, object.etag, op],
        },
      },
      {
        kind: "blob_storage",
        affectedId: blob,
        statement: {
          sql: `INSERT INTO blob_storage(blob_id,bytes,r2_etag,observed_at) VALUES(?,0,?,${clock})`,
          values: [blob, object.etag],
        },
      },
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
          sql: `UPDATE nodes SET revision=revision+1,updated_at=${clock},last_op_id=?
            WHERE id=? AND revision=? AND deleted_at IS NULL`,
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
          sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at)
            VALUES(?,?,?,'node.create',?,${clock})`,
          values: [
            `${op}_activity`,
            op,
            request.principal.kind === "app_password" ? request.principal.user_id : null,
            node,
          ],
        },
      },
      {
        kind: "outbox",
        affectedId: node,
        statement: {
          sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at)
            VALUES(?,?,'node.created',?,'pending',?,${clock},${clock})`,
          values: [`${op}_event`, op, node, claim.permit.epoch],
        },
      },
      {
        kind: "lock",
        affectedId: node,
        statement: {
          sql: `INSERT INTO locks(id,node_id,space_id,creator_credential_id,token_hash,display_href,depth,owner_text,epoch,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,${clock}+?*1000)`,
          values: [
            lock,
            node,
            request.spaceId,
            request.principal.credential_id,
            tokenHash,
            request.displayHref,
            request.depth,
            request.ownerText,
            request.principal.epoch,
            request.timeoutSeconds,
          ],
        },
      },
    ],
  };
}

/** Create RFC 4918's locked empty resource without exposing an unlocked namespace state. */
export async function createLockedEmptyFile(
  env: Pick<Env, "DB" | "BLOBS" | "LOCKS">,
  request: CreateLockedFileRequest,
): Promise<CreateLockedFileOutcome> {
  const name = portableName(request.name);
  if (
    request.principal.kind !== "app_password" ||
    !request.displayHref.startsWith("/dav/") ||
    new TextEncoder().encode(request.displayHref).byteLength > 16_384 ||
    !["0", "infinity"].includes(request.depth) ||
    new TextEncoder().encode(request.ownerText).byteLength > 8_192 ||
    !Number.isSafeInteger(request.timeoutSeconds) ||
    request.timeoutSeconds < 1 ||
    request.timeoutSeconds > 3_600
  )
    throw new Error("invalid_dav_lock");
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const [tokenHash] = await lockTokenHashes([token]);
  const submittedLockHashes = await lockTokenHashes(request.lockTokens);
  const intent = await operationIntent(
    request.principal,
    request.requestId,
    request.spaceId,
    "dav.lock",
    {
      kind: "file",
      parentId: request.parentId,
      name: name.name,
      depth: request.depth,
      displayHref: request.displayHref,
    },
    { parentId: request.parentId },
  );
  const existing = await findOperationIntent(env.DB, intent, CREATE_LOCKED_FILE_STEPS);
  if (existing) throw new Error("idempotency_conflict");
  const lockDo = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lockDo.acquireCreate({
    requestId: intent.id,
    spaceId: request.spaceId,
    parentId: request.parentId,
    principal: request.principal,
    lockTokens: request.lockTokens,
  });
  let claimed = false;
  const blobId = `${intent.id}_blob`;
  const key = `u/${request.principal.user_id}/b/${blobId}`;
  try {
    const authorized = await authorizeNode(env.DB, request.principal, {
      operation: "node.create",
      parentId: request.parentId,
      spaceId: request.spaceId,
    });
    if (authorized.operation !== "node.create") throw new Error("invalid_create_authorization");
    let object: R2Object | null = null;
    try {
      object = await env.BLOBS.put(key, "");
    } catch {
      object = await env.BLOBS.head(key);
    }
    if (!object || object.size !== 0 || !object.etag) throw new Error("empty_blob_write_failed");
    const claim = await claimOperation(
      env.DB,
      intent,
      permit,
      authorized,
      CREATE_LOCKED_FILE_STEPS,
    );
    if (claim.kind !== "claimed") throw new Error("idempotency_conflict");
    claimed = true;
    const outcome = await fsMutation(
      env.DB,
      lockedFilePlan(claim.claim, authorized, request, object, tokenHash!, submittedLockHashes),
    );
    if (outcome.kind === "commit_unknown") return { kind: "commit_unknown", outcome };
    if (outcome.operation.state !== "committed") {
      await env.BLOBS.delete(key).catch(() => undefined);
      return {
        kind: "locked",
        outcome,
        lock: {
          token,
          depth: request.depth,
          ownerText: request.ownerText,
          timeoutSeconds: request.timeoutSeconds,
        },
      };
    }
    return {
      kind: "locked",
      outcome,
      lock: {
        token,
        depth: request.depth,
        ownerText: request.ownerText,
        timeoutSeconds: request.timeoutSeconds,
      },
    };
  } catch (error) {
    if (!claimed) {
      await env.BLOBS.delete(key).catch(() => undefined);
      await lockDo.release(intent.id, permit).catch(() => undefined);
    }
    throw error;
  } finally {
    if (claimed) {
      await lockDo.release(intent.id, permit).catch(() => undefined);
    }
  }
}
