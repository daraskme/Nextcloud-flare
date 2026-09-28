import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { shareCoverageAssertion } from "../auth/shareCoverage";
import { assertExists, atomicBatch, primary, type SqlStatement } from "../db/primary";
import { boundedSubtreeCte } from "./subtree";
import {
  encodeZipManifest,
  parseZipManifest,
  type ZipManifestEntry,
  type ZipTargetManifest,
} from "./zipManifest";

type ReadProof = AuthorizedNode & { readonly operation: "node.read" };

interface SnapshotRow {
  id: string;
  parentId: string | null;
  name: string;
  kind: "root" | "folder" | "file";
  revision: number;
  blobId: string | null;
  size: number | null;
}

function selectedShare(principal: Principal) {
  return principal.kind === "link_share"
    ? { id: principal.share_id, version: principal.share_version }
    : principal.kind === "user" || principal.kind === "app_password"
      ? principal.selected_share
      : undefined;
}

/** The same proofs must guard pin acquisition, publication and every later read. */
export function zipSnapshotAssertions(
  proof: ReadProof,
  manifest: ZipTargetManifest,
): readonly SqlStatement[] {
  const { zip } = manifest,
    node = proof.node;
  if (
    proof.operation !== "node.read" ||
    !["root", "folder"].includes(node.kind) ||
    node.id !== zip.rootNodeId ||
    node.space_id !== zip.spaceId ||
    node.revision !== zip.rootRevision ||
    node.tree_generation !== zip.treeGeneration
  )
    throw new Error("zip_snapshot_changed");
  const share = selectedShare(proof.principal);
  const directories = new Map(
    zip.entries
      .filter((entry) => entry.kind === "folder")
      .map((entry) => [entry.path.slice(0, -1), entry.nodeId]),
  );
  const rows = zip.entries.map((entry) => {
    const path = entry.kind === "folder" ? entry.path.slice(0, -1) : entry.path;
    const index = path.lastIndexOf("/");
    return {
      id: entry.nodeId,
      revision: entry.revision,
      blobId: entry.blobId,
      kind: entry.kind,
      parentId: index < 0 ? zip.rootNodeId : directories.get(path.slice(0, index)),
      name: path.slice(index + 1),
      size: entry.size,
    };
  });
  return [
    authorizationAssertion(proof),
    ...(share ? [shareCoverageAssertion(node, share)] : []),
    // Count the bounded walk too: a missing generation bump must not hide added nodes.
    assertExists(
      `${boundedSubtreeCte(1_002)}
      SELECT 1 WHERE (SELECT COUNT(*) FROM scope)=?4`,
      [node.id, node.space_id, node.owner_id, rows.length + 1],
    ),
    assertExists(
      `SELECT 1 WHERE NOT EXISTS (
      SELECT 1 FROM json_each(?1) e WHERE NOT EXISTS (
        SELECT 1 FROM nodes n WHERE n.id=json_extract(e.value,'$.id') AND n.space_id=?2 AND n.owner_id=?3
          AND n.parent_id=json_extract(e.value,'$.parentId') AND n.name=json_extract(e.value,'$.name')
          AND n.revision=json_extract(e.value,'$.revision') AND n.kind=json_extract(e.value,'$.kind')
          AND n.current_blob_id IS json_extract(e.value,'$.blobId') AND n.deleted_at IS NULL
          AND (n.kind='folder' OR EXISTS (
            SELECT 1 FROM blobs b JOIN blob_storage s ON s.blob_id=b.id
            WHERE b.id=n.current_blob_id AND b.owner_id=n.owner_id AND b.state IN ('committed','gc_candidate')
              AND b.r2_key='u/'||n.owner_id||'/b/'||b.id AND b.size=json_extract(e.value,'$.size')
              AND s.bytes=b.size AND s.r2_etag IS NOT NULL AND s.removed_at IS NULL))))`,
      [JSON.stringify(rows), node.space_id, node.owner_id],
    ),
  ];
}

/** A bounded authorized snapshot; paths are built only from D1 parent/name relationships. */
export async function prepareZipSnapshot(db: D1Database, principal: Principal, nodeId: string) {
  if (principal.kind === "service" || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId))
    throw new Error("zip_unavailable");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("zip_unavailable");
  const proof = await authorizeNode(db, principal, { operation: "node.read", nodeId, spaceId });
  if (
    proof.operation !== "node.read" ||
    !["root", "folder"].includes(proof.node.kind) ||
    (principal.kind !== "link_share" &&
      !selectedShare(principal) &&
      proof.node.owner_id !== principal.user_id)
  )
    throw new Error("zip_unavailable");
  const share = selectedShare(principal);
  const result = await atomicBatch(db, [
    authorizationAssertion(proof),
    ...(share ? [shareCoverageAssertion(proof.node, share)] : []),
    {
      sql: `${boundedSubtreeCte(1_002)}
        SELECT n.id,n.parent_id AS parentId,n.name,n.kind,n.revision,n.current_blob_id AS blobId,b.size
        FROM scope JOIN nodes n ON n.id=scope.id LEFT JOIN blobs b ON b.id=n.current_blob_id`,
      values: [nodeId, spaceId, proof.node.owner_id],
    },
  ]);
  const rows = result[result.length - 1]!.results as unknown as SnapshotRow[];
  if (rows.length === 0 || rows.length > 1_001) throw new Error("zip_entry_limit");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const paths = new Map([[nodeId, ""]]);
  const pathFor = (row: SnapshotRow, visiting = new Set<string>()): string => {
    const known = paths.get(row.id);
    if (known !== undefined) return known;
    if (
      !row.parentId ||
      visiting.size >= 64 ||
      visiting.has(row.id) ||
      !row.name ||
      /[\\/]/.test(row.name) ||
      row.name !== row.name.normalize("NFC")
    )
      throw new Error("invalid_zip_manifest");
    const parent = byId.get(row.parentId);
    if (!parent || parent.kind === "file") throw new Error("invalid_zip_manifest");
    visiting.add(row.id);
    const parentPath = pathFor(parent, visiting);
    visiting.delete(row.id);
    const path = `${parentPath}${row.name}${row.kind === "folder" ? "/" : ""}`;
    paths.set(row.id, path);
    return path;
  };
  const entries: ZipManifestEntry[] = rows
    .filter((row) => row.id !== nodeId)
    .map((row) => {
      if (row.kind === "root" || (row.kind === "file" && (row.size === null || !row.blobId)))
        throw new Error("zip_unavailable");
      return {
        nodeId: row.id,
        revision: row.revision,
        path: pathFor(row),
        kind: row.kind,
        blobId: row.blobId,
        size: row.kind === "file" ? row.size! : 0,
      };
    });
  const encoded = await encodeZipManifest({
    spaceId,
    rootNodeId: nodeId,
    rootRevision: proof.node.revision,
    treeGeneration: proof.node.tree_generation,
    entries,
  });
  const manifest = parseZipManifest(JSON.parse(encoded.json), encoded.totalBytes);
  await atomicBatch(db, zipSnapshotAssertions(proof as ReadProof, manifest));
  return Object.freeze({ proof: proof as ReadProof, manifest, encoded });
}
