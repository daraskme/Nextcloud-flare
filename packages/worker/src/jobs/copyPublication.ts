import { portableName, searchName } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode } from "../auth/authorize";
import { assertCreateLocks, assertTrashLocks, lockTokenHashes } from "../auth/locks";
import { destinationPrincipal } from "../auth/transferScope";
import { assertOpenPermit } from "../db/permits";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { audioSearchSuffix } from "../search/projection";
import { COPY_AUDIO_FIELDS } from "../services/copyAudio";
import { copySnapshotAssertions, type PreparedCopy } from "../services/copyPreparation";
import { commitMutationStatements, type MutationOutcome } from "../services/fsMutation";
import { boundedSubtreeCte } from "../services/subtree";
import {
  type CopyJobClaim,
  checkCopyClaim,
  copyAuthorityStatements,
  copyClaimFence,
  copyClaimOffset,
  copyClaimPosition,
} from "./copyClaim";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  type OperationClaim,
  operationIntent,
} from "./operations";

const CLOCK = "strftime('%s','now')*1000";
export const COPY_PUBLICATION_STEPS = 10;
const changes = (count: number): SqlStatement => ({
  sql: "INSERT INTO _assert(v) SELECT 1 WHERE changes()<>?",
  values: [count],
});

function allocations(plan: PreparedCopy, jobId: string) {
  return plan.source.blobs.map((b, i) => ({
    sourceBlobId: b.id,
    destinationBlobId: jobId + "_b" + String(i + 1).padStart(5, "0"),
    pinId: jobId + "_p" + String(i + 1).padStart(5, "0"),
  }));
}

/** 64 KiB groups, or one bounded audio row; preserve parent-before-child order. */
function groups<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  let group: T[] = [],
    bytes = 2;
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength + 1;
    if (size > 512 * 1024) throw new Error("copy_manifest_too_large");
    if (group.length && (bytes + size > 65536 || group.length === 256)) {
      result.push(group);
      group = [];
      bytes = 2;
    }
    group.push(item);
    bytes += size;
  }
  if (group.length) result.push(group);
  return result;
}

/** Compile accepted metadata, never the source's subsequently changed names, props or content. */
function metadata(plan: PreparedCopy, jobId: string) {
  const children = new Map<string | null, PreparedCopy["source"]["entries"][number][]>();
  for (const entry of plan.source.entries) {
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const roots = children.get(null);
  if (roots?.length !== 1 || roots[0]!.id !== plan.source.rootId)
    throw new Error("invalid_copy_manifest");
  const ordered = [...roots];
  for (let i = 0; i < ordered.length; i++) ordered.push(...(children.get(ordered[i]!.id) ?? []));
  if (ordered.length !== plan.source.entries.length) throw new Error("invalid_copy_manifest");
  const ids = new Map(
    ordered.map((entry, i) => [entry.id, jobId + "_n" + String(i + 1).padStart(5, "0")]),
  );
  const blobs = new Map(
    allocations(plan, jobId).map((blob) => [blob.sourceBlobId, blob.destinationBlobId]),
  );
  const nodes = ordered.map((entry, i) => {
    const name = i === 0 ? portableName(plan.name) : null;
    return {
      id: ids.get(entry.id)!,
      parent: i === 0 ? plan.destinationParentId : ids.get(entry.parentId!)!,
      name: name?.name ?? entry.name,
      nameCi: name?.nameCi ?? entry.nameCi,
      kind: entry.kind === "root" ? "folder" : entry.kind,
      blob: entry.blobId === null ? null : blobs.get(entry.blobId)!,
      mtime: entry.mtime,
      hidden: name ? Number(name.hidden) : entry.hidden,
    };
  });
  const props = plan.source.properties.map((p) => ({ ...p, nodeId: ids.get(p.nodeId)! }));
  const audio = (plan.source.audio ?? []).map((a) => ({
    ...a,
    nodeId: ids.get(a.nodeId)!,
    blobId: blobs.get(a.blobId)!,
  }));
  const search = nodes.map((n) => ({ id: n.id, ...searchName(n.name) }));
  return { nodes, props, audio, search, root: nodes[0]!.id };
}

function publicationStatements(
  claim: CopyJobClaim,
  operation: OperationClaim,
  data: ReturnType<typeof metadata>,
  authority: readonly SqlStatement[],
  hashes: readonly string[],
): SqlStatement[] {
  const { plan, id } = claim,
    op = operation.intent.id,
    target = destinationPrincipal(plan.principal, plan.destination);
  const st: SqlStatement[] = [
    assertOpenPermit(operation.permit),
    assertOperationClaim(operation),
    copyClaimFence(claim),
    ...authority,
    assertCreateLocks(plan.destinationParentId, plan.destination.spaceId, target, hashes),
    ...(plan.overwrite
      ? [
          assertTrashLocks(plan.overwrite.rootId, plan.destination.spaceId, target, hashes),
          assertExists(
            "SELECT 1 FROM nodes WHERE id=? AND parent_id=? AND name_ci=? AND deleted_at IS NULL",
            [plan.overwrite.rootId, plan.destinationParentId, plan.nameCi],
          ),
          ...copySnapshotAssertions(plan.overwrite, "infinity"),
        ]
      : []),
    assertExists(
      "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE parent_id=? AND name_ci=? AND deleted_at IS NULL AND id<>COALESCE(?,''))",
      [plan.destinationParentId, plan.nameCi, plan.overwrite?.rootId ?? null],
    ),
    // All fixed members must still be readable under the original source subtree. Content may change.
    assertExists(
      `${boundedSubtreeCte(10001)} SELECT 1 WHERE ?4=(SELECT COUNT(*) FROM json_each(?5) e CROSS JOIN scope s ON s.id=e.value)`,
      [
        plan.source.rootId,
        plan.source.spaceId,
        plan.source.ownerId,
        plan.source.entries.length,
        JSON.stringify(plan.source.entries.map((n) => n.id)),
      ],
    ),
    {
      sql: "UPDATE bulk_jobs SET publish_op_id=?,published_root_id=? WHERE id=? AND publish_op_id IS NULL",
      values: [op, data.root, id],
    },
    assertOneChange,
    {
      sql: "UPDATE reservations SET state='released' WHERE id IN (SELECT reservation_id FROM copy_job_blobs WHERE job_id=?) AND state='reserved'",
      values: [id],
    },
    changes(plan.source.blobs.length),
    {
      sql: "UPDATE blobs SET state='committed' WHERE id IN (SELECT destination_blob_id FROM copy_job_blobs WHERE job_id=?) AND state='staging'",
      values: [id],
    },
    changes(plan.source.blobs.length),
  ];
  let step = 0;
  const mark = (kind: string, affectedId = data.root) =>
    st.push(
      {
        sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
        values: [op, ++step, kind, affectedId],
      },
      assertOneChange,
    );
  if (plan.overwrite) {
    st.push(
      {
        sql: `INSERT INTO trash_ops(op_id,actor_id,space_id,root_node_id,state,reason,created_at,purge_after,epoch) VALUES(?,?,?,?,'pending','copy.publish',${CLOCK},${CLOCK}+3024000000,?)`,
        values: [
          op,
          plan.principal.user_id,
          plan.destination.spaceId,
          plan.overwrite.rootId,
          claim.epoch,
        ],
      },
      assertOneChange,
    );
    for (const group of groups(plan.overwrite.entries.map((n) => n.id)))
      st.push(
        {
          sql: "INSERT INTO trash_members(trash_op_id,node_id) SELECT ?,value FROM json_each(?)",
          values: [op, JSON.stringify(group)],
        },
        changes(group.length),
      );
    const members = "SELECT node_id FROM trash_members WHERE trash_op_id=?";
    st.push(
      {
        sql: `UPDATE nodes SET deleted_at=${CLOCK},deleted_op_id=?,orig_parent_id=parent_id,last_op_id=?,updated_at=MAX(updated_at,${CLOCK}) WHERE id IN (${members}) AND deleted_at IS NULL`,
        values: [op, op, op],
      },
      changes(plan.overwrite.entries.length),
      { sql: `DELETE FROM locks WHERE node_id IN (${members})`, values: [op] },
      {
        sql: `UPDATE shares SET disabled_at=${CLOCK},version=version+1 WHERE root_node_id IN (${members}) AND disabled_at IS NULL`,
        values: [op],
      },
      {
        sql: `UPDATE share_sessions SET revoked_at=${CLOCK} WHERE revoked_at IS NULL AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members}))`,
        values: [op],
      },
      {
        sql: `UPDATE tickets SET cancelled_at=${CLOCK} WHERE cancelled_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [plan.destinationOwnerId],
      },
      {
        sql: `UPDATE content_sessions SET revoked_at=${CLOCK} WHERE revoked_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)`,
        values: [plan.destinationOwnerId],
      },
      assertExists(
        `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM locks WHERE node_id IN (${members}))
        AND NOT EXISTS(SELECT 1 FROM shares WHERE root_node_id IN (${members}) AND disabled_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM share_sessions WHERE revoked_at IS NULL AND share_id IN (SELECT id FROM shares WHERE root_node_id IN (${members})))`,
        [op, op, op],
      ),
      assertExists(
        "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM tickets WHERE cancelled_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)) AND NOT EXISTS(SELECT 1 FROM content_sessions WHERE revoked_at IS NULL AND target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?))",
        [plan.destinationOwnerId, plan.destinationOwnerId],
      ),
      {
        sql: "UPDATE trash_ops SET state='trashed' WHERE op_id=? AND state='pending'",
        values: [op],
      },
      assertOneChange,
    );
  }
  mark("trash");
  for (const group of groups(data.nodes))
    st.push(
      {
        sql: `INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,hidden,last_op_id)
    SELECT json_extract(value,'$.id'),?1,?2,json_extract(value,'$.parent'),json_extract(value,'$.name'),json_extract(value,'$.nameCi'),json_extract(value,'$.kind'),json_extract(value,'$.blob'),1,json_extract(value,'$.mtime'),${CLOCK},${CLOCK},json_extract(value,'$.hidden'),?3 FROM json_each(?4) ORDER BY CAST(key AS INTEGER)`,
        values: [plan.destination.spaceId, plan.destinationOwnerId, op, JSON.stringify(group)],
      },
      changes(group.length),
    );
  mark("node");
  for (const group of groups(data.props))
    st.push(
      {
        sql: "INSERT INTO node_props(node_id,namespace,name,value_xml) SELECT json_extract(value,'$.nodeId'),json_extract(value,'$.namespace'),json_extract(value,'$.name'),json_extract(value,'$.value') FROM json_each(?)",
        values: [JSON.stringify(group)],
      },
      changes(group.length),
    );
  for (const group of groups(data.audio))
    st.push(
      {
        sql: `INSERT INTO node_audio(${Object.values(COPY_AUDIO_FIELDS).join(",")},search_text_norm,search_tokens,search_source,search_version)
          SELECT ${Object.keys(COPY_AUDIO_FIELDS)
            .map((key) => `json_extract(value,'$.${key}')`)
            .join(",")},
          json_extract(value,'$.search.textNorm'),json_extract(value,'$.search.tokens'),json_extract(value,'$.search.source'),json_extract(value,'$.search.version') FROM json_each(?)`,
        values: [JSON.stringify(group)],
      },
      changes(group.length),
    );
  mark("props");
  st.push(
    {
      sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${CLOCK}) WHERE id=? AND deleted_at IS NULL AND kind IN ('root','folder')`,
      values: [op, plan.destinationParentId],
    },
    assertOneChange,
  );
  mark("parent", plan.destinationParentId);
  st.push(
    {
      sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?",
      values: [plan.destination.spaceId],
    },
    assertOneChange,
  );
  mark("tree", plan.destination.spaceId);
  for (const group of groups(data.search))
    st.push(
      {
        // Read only the destination metadata inserted above, never the current source rows.
        sql: `INSERT INTO search_index(node_id,space_id,text_norm,tokens,normalization_version,revision)
          SELECT json_extract(e.value,'$.id'),?,
            json_extract(e.value,'$.textNorm')||${audioSearchSuffix("text_norm", "json_extract(e.value,'$.id')")},
            json_extract(e.value,'$.tokens')||${audioSearchSuffix("tokens", "json_extract(e.value,'$.id')")},
            json_extract(e.value,'$.version'),1 FROM json_each(?) e`,
        values: [plan.destination.spaceId, JSON.stringify(group)],
      },
      changes(group.length),
    );
  mark("search_index");
  st.push(
    {
      sql: "INSERT INTO search_fts(rowid,text_norm,tokens) SELECT rowid,text_norm,tokens FROM search_index WHERE node_id>=? AND node_id<?",
      values: [id + "_n", id + "_o"],
    },
    assertExists(
      "SELECT COUNT(*) FROM search_fts WHERE rowid IN (SELECT rowid FROM search_index WHERE node_id>=? AND node_id<?) HAVING COUNT(*)=?",
      [id + "_n", id + "_o", data.nodes.length],
    ),
  );
  mark("search_fts");
  st.push(
    {
      sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'copy.publish',?,${CLOCK})`,
      values: [op + "_activity", op, plan.principal.user_id, data.root],
    },
    assertOneChange,
  );
  mark("activity");
  st.push(
    {
      sql: `INSERT INTO outbox(outbox_id,op_id,kind,payload_ref,state,epoch,created_at,updated_at) VALUES(?,?,'node.created',?,'pending',?,${CLOCK},${CLOCK})`,
      values: [op + "_event", op, data.root, claim.epoch],
    },
    assertOneChange,
  );
  mark("outbox");
  st.push(
    {
      sql: `UPDATE outbox SET state='completed',claim_token=NULL,claim_expires_at=NULL,updated_at=MAX(updated_at,${CLOCK}) WHERE op_id=? AND kind='copy.requested' AND payload_ref=? AND state IN ('dispatching','sent')`,
      values: ["op_" + id.slice(5), id],
    },
    assertOneChange,
  );
  mark("copy_settlement", id);
  st.push(
    {
      sql: `UPDATE bulk_jobs SET state='completed',updated_at=MAX(updated_at,${CLOCK}) WHERE id=? AND state='running'`,
      values: [id],
    },
    assertOneChange,
    {
      sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${CLOCK}) WHERE op_id=? AND state='claimed'`,
      values: [JSON.stringify({ status: plan.overwrite ? 204 : 201, nodeId: data.root }), op],
    },
    assertOneChange,
    {
      sql: "DELETE FROM copy_multipart_parts WHERE destination_blob_id IN (SELECT destination_blob_id FROM copy_job_blobs WHERE job_id=?)",
      values: [id],
    },
    {
      sql: "DELETE FROM copy_multipart_uploads WHERE destination_blob_id IN (SELECT destination_blob_id FROM copy_job_blobs WHERE job_id=?)",
      values: [id],
    },
    { sql: "DELETE FROM copy_job_blobs WHERE job_id=?", values: [id] },
    changes(plan.source.blobs.length),
  );
  for (const group of groups(allocations(plan, id).map((b) => b.pinId)))
    st.push(
      {
        sql: "DELETE FROM blob_pins WHERE pin_id IN (SELECT value FROM json_each(?))",
        values: [JSON.stringify(group)],
      },
      changes(group.length),
    );
  st.push(
    { sql: "DELETE FROM job_leases WHERE job_id=? AND claim_token=?", values: [id, claim.token] },
    assertOneChange,
  );
  return st;
}

/** Internal completion entry: transfer, quota conversion and all namespace effects commit together. */
export async function publishCopyJob(
  env: Pick<Env, "DB" | "LOCKS">,
  claim: CopyJobClaim,
  lockTokens: readonly string[] = [],
): Promise<MutationOutcome> {
  lockTokens = [...lockTokens];
  if (copyClaimPosition(claim) !== claim.plan.source.blobs.length || copyClaimOffset(claim) !== 0)
    throw new Error("copy_transfer_incomplete");
  const { plan } = claim,
    principal = destinationPrincipal(plan.principal, plan.destination);
  const previous = await primary(env.DB)
    .prepare("SELECT publish_op_id FROM bulk_jobs WHERE id=? AND state='completed'")
    .bind(claim.id)
    .first<string>("publish_op_id");
  if (previous) {
    const operation = await lookupOperation(env.DB, principal, previous);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  checkCopyClaim(claim);
  const data = metadata(plan, claim.id),
    hashes = await lockTokenHashes([...lockTokens]);
  const operands = {
    jobId: claim.id,
    parentId: plan.destinationParentId,
    manifestDigest: plan.digest,
    claimToken: claim.token,
    ...(plan.overwrite ? { overwriteTargetId: plan.overwrite.rootId } : {}),
  };
  const intent = await operationIntent(
    principal,
    "copy-publish:" + claim.id + ":" + claim.token,
    plan.destination.spaceId,
    "copy.publish",
    { ...operands, lockHashes: hashes },
    operands,
  );
  const existing = await findOperationIntent(env.DB, intent, COPY_PUBLICATION_STEPS);
  if (existing && existing.state !== "claimed") {
    const operation = await lookupOperation(env.DB, principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  }
  const authority = await copyAuthorityStatements(env.DB, plan);
  const target = await authorizeNode(env.DB, principal, {
    operation: "node.create",
    parentId: plan.destinationParentId,
    spaceId: plan.destination.spaceId,
    ownerOnly: plan.destination.share === null,
  });
  authority.push(authorizationAssertion(target));
  const lock = env.LOCKS.get(env.LOCKS.idFromName(plan.destination.spaceId));
  const permit = await lock.acquireCreate({
    requestId: intent.id,
    principal,
    spaceId: plan.destination.spaceId,
    parentId: plan.destinationParentId,
    lockTokens: [...lockTokens],
  });
  let terminal = false;
  try {
    checkCopyClaim(claim);
    const claimed = await claimOperation(env.DB, intent, permit, target, COPY_PUBLICATION_STEPS);
    if (claimed.kind === "terminal") {
      const operation = await lookupOperation(env.DB, principal, intent.id);
      if (!operation) throw new Error("authorization_denied");
      terminal = true;
      return { kind: "terminal", operation };
    }
    const outcome = await commitMutationStatements(
      env.DB,
      claimed.claim,
      publicationStatements(claim, claimed.claim, data, authority, hashes),
    );
    terminal = outcome.kind === "terminal";
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
