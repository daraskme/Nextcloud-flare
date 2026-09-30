import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { authorizeNode, type Principal } from "../auth/authorize";
import { lockTokenHashes } from "../auth/locks";
import type { Env } from "../env";
import {
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
} from "../jobs/operations";
import {
  fsMutation,
  type MutationOutcome,
  type MutationPlan,
  type MutationStep,
} from "./fsMutation";

export const CREATE_FOLDER_STEPS = 7;
export interface CreateFolderRequest {
  readonly principal: Principal;
  readonly idempotencyKey: string;
  readonly spaceId: string;
  readonly parentId: string;
  readonly name: string;
  readonly lockTokens: readonly string[];
  readonly operation?: "node.create" | "dav.mkcol";
}

/** Pure plan construction; no D1, R2, Queue or clock side effects. */
export function folderMutationPlan(
  claim: OperationClaim,
  authorized: MutationPlan["authorized"],
  inputName: string,
  lockHashes: readonly string[],
): MutationPlan {
  const name = portableName(inputName);
  const search = searchName(name.name);
  const op = claim.intent.id;
  const node = `${op}_node`;
  const parent = authorized.parent;
  const clock = "strftime('%s','now')*1000";
  const steps: MutationStep[] = [
    {
      kind: "node",
      affectedId: node,
      statement: {
        sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,hidden,last_op_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'folder',?,?,${clock},${clock})`,
        values: [
          node,
          parent.space_id,
          parent.owner_id,
          parent.id,
          name.name,
          name.nameCi,
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
        sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'node.create',?,${clock})`,
        values: [
          `${op}_activity`,
          op,
          authorized.principal.kind === "link_share" ? null : authorized.principal.user_id,
          node,
        ],
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
  ];
  return { claim, authorized, lockHashes, steps, result: { status: 201, nodeId: node } };
}

/** The first namespace service. Public HTTP stays closed until the Foundation admission gate passes. */
export async function createFolder(
  env: Pick<Env, "DB" | "LOCKS">,
  request: CreateFolderRequest,
): Promise<MutationOutcome> {
  const name = portableName(request.name);
  const hashes = await lockTokenHashes(request.lockTokens);
  const intent = await operationIntent(
    request.principal,
    request.idempotencyKey,
    request.spaceId,
    request.operation ?? "node.create",
    { kind: "folder", parentId: request.parentId, name: name.name },
    { parentId: request.parentId },
  );
  const existing = await findOperationIntent(env.DB, intent, CREATE_FOLDER_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, request.principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const lock = env.LOCKS.get(env.LOCKS.idFromName(request.spaceId));
  const permit = await lock.acquireCreate({
    requestId: intent.id,
    spaceId: request.spaceId,
    parentId: request.parentId,
    principal: request.principal,
    lockTokens: request.lockTokens,
  });
  const authorized = await authorizeNode(env.DB, request.principal, {
    operation: "node.create",
    parentId: request.parentId,
    spaceId: request.spaceId,
  });
  if (authorized.operation !== "node.create") throw new Error("invalid_create_authorization");
  const claimed = await claimOperation(env.DB, intent, permit, authorized, CREATE_FOLDER_STEPS);
  const result =
    claimed.kind === "claimed"
      ? await fsMutation(env.DB, folderMutationPlan(claimed.claim, authorized, name.name, hashes))
      : await (async (): Promise<MutationOutcome> => {
          const operation = await lookupOperation(env.DB, request.principal, intent.id);
          if (!operation) throw new Error("authorization_denied");
          return { kind: "terminal", operation };
        })();
  if (result.kind === "terminal") {
    try {
      await lock.release(intent.id, permit);
    } catch {
      /* Lease recovery releases a permit when the release response is lost. */
    }
  }
  return result;
}
