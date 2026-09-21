import type { Env } from "../env.js";
import { normalizePortableName } from "./fsMutation.js";
import {
  assertChanged,
  auditAndOutbox,
  finishMutation,
  mutationGuards,
  operationStep,
  type UserMutationContext,
} from "./mutation.js";

export interface CopyManifestEntry {
  sourceId: string;
  destinationId: string;
  sourceParentId: string | null;
  destinationParentId: string;
  name: string;
  nameCi: string;
  kind: "folder" | "file";
  blobId: string | null;
  revision: number;
  depth: number;
}

export interface CopyManifest {
  sourceId: string;
  destinationParentId: string;
  entries: CopyManifestEntry[];
  properties: { sourceId: string; namespace: string; name: string; value: string }[];
}

export async function buildCopyManifest(
  env: Env,
  input: {
    sourceId: string;
    destinationParentId: string;
    userId: string;
    name?: string;
    idFactory: () => string;
  },
): Promise<CopyManifest> {
  const destination = await env.DB.prepare(
    "SELECT id,space_id,owner_id,kind FROM nodes WHERE id=?1 AND owner_id=?2 AND kind IN ('root','folder') AND deleted_at IS NULL",
  )
    .bind(input.destinationParentId, input.userId)
    .first<{ id: string; space_id: string; owner_id: string; kind: string }>();
  if (destination === null) {
    throw new Error("not_a_folder");
  }
  const rows = await env.DB.prepare(
    "WITH RECURSIVE sub(id,parent_id,name,name_ci,kind,current_blob_id,revision,space_id,owner_id,depth) AS (SELECT id,parent_id,name,name_ci,kind,current_blob_id,revision,space_id,owner_id,0 FROM nodes WHERE id=?1 AND owner_id=?2 AND deleted_at IS NULL UNION ALL SELECT n.id,n.parent_id,n.name,n.name_ci,n.kind,n.current_blob_id,n.revision,n.space_id,n.owner_id,sub.depth+1 FROM nodes n JOIN sub ON n.parent_id=sub.id WHERE n.deleted_at IS NULL AND sub.depth<64 LIMIT 1001) SELECT * FROM sub ORDER BY depth,id",
  )
    .bind(input.sourceId, input.userId)
    .all<{
      id: string;
      parent_id: string | null;
      name: string;
      name_ci: string;
      kind: "root" | "folder" | "file";
      current_blob_id: string | null;
      revision: number;
      space_id: string;
      owner_id: string;
      depth: number;
    }>();
  if (rows.results.length === 0 || rows.results.length > 1000 || rows.results[0]?.kind === "root") {
    throw new Error(rows.results.length > 1000 ? "copy_limit_exceeded" : "copy_source_invalid");
  }
  if (
    rows.results.some(
      (row) => row.space_id !== destination.space_id || row.owner_id !== input.userId,
    )
  ) {
    throw new Error("cross_space_copy_forbidden");
  }
  const destinationDepth = await env.DB.prepare(
    "WITH RECURSIVE a(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM nodes WHERE id=?1 UNION ALL SELECT n.id,n.parent_id,a.depth+1 FROM nodes n JOIN a ON n.id=a.parent_id WHERE a.depth<64) SELECT MAX(depth) value FROM a",
  )
    .bind(input.destinationParentId)
    .first<{ value: number }>();
  const maxSourceDepth = Math.max(...rows.results.map((row) => row.depth));
  if ((destinationDepth?.value ?? 65) + maxSourceDepth + 1 > 64) {
    throw new Error("copy_depth_exceeded");
  }
  const ids = new Map(rows.results.map((row) => [row.id, input.idFactory()]));
  const rootName = normalizePortableName(input.name ?? rows.results[0]?.name ?? "Copy");
  const entries = rows.results.map((row) => {
    const destinationId = ids.get(row.id);
    if (destinationId === undefined) {
      throw new Error("copy_manifest_invalid");
    }
    const parent = row.depth === 0 ? input.destinationParentId : ids.get(row.parent_id ?? "");
    if (parent === undefined) {
      throw new Error("copy_manifest_invalid");
    }
    return {
      sourceId: row.id,
      destinationId,
      sourceParentId: row.parent_id,
      destinationParentId: parent,
      name: row.depth === 0 ? rootName.name : row.name,
      nameCi: row.depth === 0 ? rootName.nameCi : row.name_ci,
      kind: row.kind as "folder" | "file",
      blobId: row.current_blob_id,
      revision: row.revision,
      depth: row.depth,
    };
  });
  const sourceIds = rows.results.map((row) => row.id);
  const properties: { sourceId: string; namespace: string; name: string; value: string }[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += 90) {
    const chunk = sourceIds.slice(offset, offset + 90);
    const result = await env.DB.prepare(
      `SELECT node_id sourceId,namespace_uri namespace,local_name name,value_xml value FROM node_props WHERE node_id IN (${chunk.map((_, index) => `?${index + 1}`).join(",")})`,
    )
      .bind(...chunk)
      .all<{ sourceId: string; namespace: string; name: string; value: string }>();
    properties.push(...result.results);
  }
  return {
    sourceId: input.sourceId,
    destinationParentId: input.destinationParentId,
    entries,
    properties,
  };
}

interface CommitCopyInput extends UserMutationContext {
  expectedTreeGeneration: number;
  expectedDestinationRevision: number;
  manifest: CopyManifest;
}

export async function commitSameOwnerCopy(env: Env, input: CommitCopyInput): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [...mutationGuards(env, input)];
  let step = 1;
  const idMap = new Map(
    input.manifest.entries.map((entry) => [entry.sourceId, entry.destinationId]),
  );
  for (const entry of input.manifest.entries) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE id=?1 AND revision=?2 AND owner_id=?3 AND deleted_at IS NULL)",
      ).bind(entry.sourceId, entry.revision, input.userId),
    );
    if (entry.blobId !== null) {
      statements.push(
        env.DB.prepare(
          "UPDATE blobs SET ref_count=ref_count+1,last_op_id=?1 WHERE id=?2 AND owner_id=?3 AND state='committed'",
        ).bind(input.operationId, entry.blobId, input.userId),
        assertChanged(env),
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO nodes(id,space_id,owner_id,parent_id,name,name_ci,kind,current_blob_id,revision,client_mtime,created_at,updated_at,deleted_at,deleted_op_id,orig_parent_id,hidden,last_op_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,NULL,?9,?9,NULL,NULL,NULL,0,?10)",
      ).bind(
        entry.destinationId,
        input.spaceId,
        input.userId,
        entry.destinationParentId,
        entry.name,
        entry.nameCi,
        entry.kind,
        entry.blobId,
        now,
        input.operationId,
      ),
      assertChanged(env),
      ...operationStep(env, input.operationId, step, "node.copy", entry.destinationId),
    );
    step += 1;
  }
  for (const property of input.manifest.properties) {
    const destinationId = idMap.get(property.sourceId);
    if (destinationId === undefined) {
      throw new Error("copy_manifest_invalid");
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO node_props(node_id,namespace_uri,local_name,value_xml) VALUES(?1,?2,?3,?4)",
      ).bind(destinationId, property.namespace, property.name, property.value),
      assertChanged(env),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE nodes SET revision=revision+1,updated_at=?1,last_op_id=?2 WHERE id=?3 AND owner_id=?4 AND revision=?5 AND deleted_at IS NULL",
    ).bind(
      now,
      input.operationId,
      input.manifest.destinationParentId,
      input.userId,
      input.expectedDestinationRevision,
    ),
    assertChanged(env),
    ...operationStep(
      env,
      input.operationId,
      step,
      "destination.revision",
      input.manifest.destinationParentId,
    ),
    env.DB.prepare(
      "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=?1 AND owner_id=?2 AND tree_generation=?3",
    ).bind(input.spaceId, input.userId, input.expectedTreeGeneration),
    assertChanged(env),
    ...operationStep(env, input.operationId, step + 1, "space.generation", input.spaceId),
    ...auditAndOutbox(
      env,
      input,
      "node.copied",
      input.manifest.entries[0]?.destinationId ?? "",
      step + 2,
      now,
    ),
    ...finishMutation(
      env,
      input,
      { node_id: input.manifest.entries[0]?.destinationId, copied: input.manifest.entries.length },
      now,
    ),
  );
  await env.DB.batch(statements);
}
