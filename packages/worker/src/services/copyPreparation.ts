import { portableName } from "@next-cloud-flare/shared/names";
import {
  type AuthorizedNode,
  authorizationAssertion,
  authorizeNode,
  type Principal,
} from "../auth/authorize";
import { freezePrincipal, principalSelection } from "../auth/selectedShare";
import {
  destinationPrincipal,
  type TransferDestination,
  transferDestination,
} from "../auth/transferScope";
import { assertExists, atomicBatch, type SqlStatement } from "../db/primary";
import { boundedSubtreeCte } from "./subtree";

export const COPY_PREPARATION_LIMITS = Object.freeze({
  nodes: 10_000,
  properties: 10_000,
  metadataBytes: 8 * 1024 * 1024,
  transferBytes: Number.MAX_SAFE_INTEGER,
});
const CLOCK = "strftime('%s','now')*1000";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
type User = Extract<Principal, { kind: "user" }>;
export interface CopyPreparationInput {
  readonly principal: Principal;
  readonly sourceSpaceId: string;
  readonly sourceNodeId: string;
  readonly destination: TransferDestination;
  readonly destinationParentId: string;
  readonly name: string;
  readonly depth: "0" | "infinity";
  readonly overwriteTargetId?: string;
}
interface Entry {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly nameCi: string;
  readonly kind: "root" | "folder" | "file";
  readonly revision: number;
  readonly blobId: string | null;
  readonly mtime: number | null;
  readonly hidden: number;
}
interface Blob {
  readonly id: string;
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentEtag: string;
  readonly sha256: string | null;
  readonly mime: string | null;
}
interface Property {
  readonly nodeId: string;
  readonly namespace: string;
  readonly name: string;
  readonly value: string;
}
export interface CopySnapshot {
  readonly rootId: string;
  readonly spaceId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly entries: readonly Entry[];
  readonly blobs: readonly Blob[];
  readonly properties: readonly Property[];
}
export interface PreparedCopy {
  readonly version: 1;
  readonly principal: User;
  readonly destination: TransferDestination;
  readonly destinationParentId: string;
  readonly destinationOwnerId: string;
  readonly name: string;
  readonly nameCi: string;
  readonly depth: "0" | "infinity";
  readonly source: CopySnapshot;
  readonly overwrite: CopySnapshot | null;
  readonly transferBytes: number;
  readonly logicalBytes: number;
  readonly digest: string;
}
const proofs = new WeakMap<PreparedCopy, readonly SqlStatement[]>();

function snapshotCte(depth: "0" | "infinity") {
  return depth === "infinity"
    ? boundedSubtreeCte(COPY_PREPARATION_LIMITS.nodes + 1)
    : "WITH scope AS MATERIALIZED (SELECT id,kind,0 AS depth FROM nodes WHERE id=?1 AND space_id=?2 AND owner_id=?3 AND deleted_at IS NULL)";
}
function dataCte(depth: "0" | "infinity") {
  return `${snapshotCte(depth)}, members AS MATERIALIZED (
    SELECT n.* FROM scope s CROSS JOIN nodes n ON n.id=s.id
  ), source_blobs AS MATERIALIZED (
    SELECT DISTINCT b.id,b.r2_key AS key,b.size,s.r2_etag AS etag,b.content_etag AS contentEtag,b.sha256_verified AS sha256,b.mime_sniffed AS mime
    FROM members n CROSS JOIN blobs b ON b.id=n.current_blob_id CROSS JOIN blob_storage s ON s.blob_id=b.id
    WHERE b.owner_id=?3 AND b.state IN ('committed','gc_candidate') AND s.removed_at IS NULL
      AND s.bytes=b.size AND s.r2_etag IS NOT NULL AND b.r2_key='u/'||b.owner_id||'/b/'||b.id
  ), props AS MATERIALIZED (
    SELECT p.node_id AS nodeId,p.namespace,p.name,p.value_xml AS value FROM scope s
      CROSS JOIN node_props p ON p.node_id=s.id LIMIT ${COPY_PREPARATION_LIMITS.properties + 1}
  )`;
}
function censusSql(depth: "0" | "infinity") {
  return `${dataCte(depth)} SELECT
    (SELECT COUNT(*) FROM members) AS nodes,
    (SELECT COUNT(*) FROM props) AS properties,
    (SELECT COUNT(*) FROM source_blobs) AS blobs,
    (SELECT COUNT(*) FROM members n WHERE n.kind='file' AND NOT EXISTS(SELECT 1 FROM source_blobs b WHERE b.id=n.current_blob_id)) AS unavailable,
    EXISTS(SELECT 1 FROM scope s JOIN nodes c ON c.parent_id=s.id AND c.deleted_at IS NULL
      WHERE ${depth === "infinity" ? "s.depth=64 OR" : ""} c.space_id<>?2 OR c.owner_id<>?3) AS incomplete,
    (SELECT COALESCE(SUM(512+length(CAST(name AS BLOB))+length(CAST(name_ci AS BLOB))),0) FROM members)
      +(SELECT COALESCE(SUM(512+length(CAST(key AS BLOB))+length(CAST(etag AS BLOB))+length(CAST(contentEtag AS BLOB))+length(CAST(COALESCE(mime,'') AS BLOB))),0) FROM source_blobs)
      +(SELECT COALESCE(SUM(128+length(CAST(namespace AS BLOB))+length(CAST(name AS BLOB))+length(CAST(value AS BLOB))),0) FROM props) AS metadataBytes`;
}
interface Census {
  nodes: number;
  properties: number;
  blobs: number;
  unavailable: number;
  incomplete: number;
  metadataBytes: number;
}
const withinBudget = `nodes BETWEEN 1 AND ${COPY_PREPARATION_LIMITS.nodes}
  AND properties<=${COPY_PREPARATION_LIMITS.properties} AND metadataBytes<=${COPY_PREPARATION_LIMITS.metadataBytes}
  AND unavailable=0 AND incomplete=0`;

async function snapshot(db: D1Database, authority: AuthorizedNode, depth: "0" | "infinity") {
  if (!("node" in authority)) throw new Error("invalid_copy_preparation");
  const node = authority.node,
    values = [node.id, node.space_id, node.owner_id];
  const census = censusSql(depth);
  const first = await atomicBatch(db, [authorizationAssertion(authority), { sql: census, values }]);
  const counts = first[1]?.results[0] as unknown as Census | undefined;
  if (!counts || counts.unavailable || counts.incomplete)
    throw new Error("copy_source_unavailable");
  if (
    counts.nodes < 1 ||
    counts.nodes > COPY_PREPARATION_LIMITS.nodes ||
    counts.properties > COPY_PREPARATION_LIMITS.properties ||
    counts.metadataBytes > COPY_PREPARATION_LIMITS.metadataBytes
  )
    throw new Error("copy_manifest_too_large");
  // The budget assertion precedes materializing property values in this same transaction.
  const rows = await atomicBatch(db, [
    authorizationAssertion(authority),
    assertExists(`SELECT 1 FROM (${census}) WHERE ${withinBudget}`, values),
    {
      sql: `${dataCte(depth)} SELECT id,CASE WHEN id=?1 THEN NULL ELSE parent_id END AS parentId,name,name_ci AS nameCi,kind,revision,current_blob_id AS blobId,client_mtime AS mtime,hidden FROM members ORDER BY id`,
      values,
    },
    { sql: `${dataCte(depth)} SELECT * FROM source_blobs ORDER BY id`, values },
    { sql: `${dataCte(depth)} SELECT * FROM props ORDER BY nodeId,namespace,name`, values },
  ]);
  const result: CopySnapshot = Object.freeze({
    rootId: node.id,
    spaceId: node.space_id,
    ownerId: node.owner_id,
    generation: node.tree_generation,
    entries: Object.freeze(
      (rows[2]!.results as unknown as Entry[]).map((row) => Object.freeze(row)),
    ),
    blobs: Object.freeze((rows[3]!.results as unknown as Blob[]).map((row) => Object.freeze(row))),
    properties: Object.freeze(
      (rows[4]!.results as unknown as Property[]).map((row) => Object.freeze(row)),
    ),
  });
  return result;
}

function grouped<T>(
  items: readonly T[],
  compile: (json: string, count: number) => SqlStatement,
): SqlStatement[] {
  const result: SqlStatement[] = [];
  for (let i = 0; i < items.length; i += 48) {
    const group = items.slice(i, i + 48);
    result.push(compile(JSON.stringify(group), group.length));
  }
  return result;
}
export function copySnapshotAssertions(
  value: CopySnapshot,
  depth: "0" | "infinity",
): SqlStatement[] {
  // Drive each join from the bounded ID set. A space-first plan rescans all nodes per group.
  return [
    assertExists(
      `SELECT 1 FROM (${censusSql(depth)}) WHERE ${withinBudget} AND nodes=?4 AND properties=?5 AND blobs=?6`,
      [
        value.rootId,
        value.spaceId,
        value.ownerId,
        value.entries.length,
        value.properties.length,
        value.blobs.length,
      ],
    ),
    ...grouped(value.entries, (json, count) =>
      assertExists(
        `SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?1) e CROSS JOIN nodes n ON n.id=json_extract(e.value,'$.id')
      WHERE n.space_id=?2 AND n.owner_id=?3 AND n.deleted_at IS NULL
        AND (CASE WHEN n.id=?4 THEN NULL ELSE n.parent_id END) IS json_extract(e.value,'$.parentId')
        AND n.name=json_extract(e.value,'$.name') AND n.name_ci=json_extract(e.value,'$.nameCi') AND n.kind=json_extract(e.value,'$.kind')
        AND n.revision=json_extract(e.value,'$.revision') AND n.current_blob_id IS json_extract(e.value,'$.blobId')
        AND n.client_mtime IS json_extract(e.value,'$.mtime') AND n.hidden=json_extract(e.value,'$.hidden'))=?5`,
        [json, value.spaceId, value.ownerId, value.rootId, count],
      ),
    ),
    ...grouped(value.blobs, (json, count) =>
      assertExists(
        `SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?1) e CROSS JOIN blobs b ON b.id=json_extract(e.value,'$.id')
      CROSS JOIN blob_storage s ON s.blob_id=b.id WHERE b.owner_id=?2 AND b.state IN ('committed','gc_candidate')
        AND b.r2_key=json_extract(e.value,'$.key') AND b.size=json_extract(e.value,'$.size')
        AND b.content_etag=json_extract(e.value,'$.contentEtag') AND b.sha256_verified IS json_extract(e.value,'$.sha256') AND b.mime_sniffed IS json_extract(e.value,'$.mime')
        AND s.removed_at IS NULL AND s.bytes=b.size AND s.r2_etag=json_extract(e.value,'$.etag'))=?3`,
        [json, value.ownerId, count],
      ),
    ),
    ...grouped(value.properties, (json, count) =>
      assertExists(
        `SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?1) e CROSS JOIN node_props p
      ON p.node_id=json_extract(e.value,'$.nodeId') AND p.namespace=json_extract(e.value,'$.namespace') AND p.name=json_extract(e.value,'$.name')
      WHERE p.value_xml=json_extract(e.value,'$.value'))=?2`,
        [json, count],
      ),
    ),
  ];
}
function immutableStatements(statements: readonly SqlStatement[]): readonly SqlStatement[] {
  return Object.freeze(
    statements.map((s) =>
      Object.freeze({ sql: s.sql, ...(s.values ? { values: Object.freeze([...s.values]) } : {}) }),
    ),
  );
}

/** Preflight for a cross-owner job. No pins, reservations, R2 writes or visible nodes are created. */
export async function prepareCrossOwnerCopy(
  db: D1Database,
  input: CopyPreparationInput,
): Promise<PreparedCopy> {
  const principal = freezePrincipal(input.principal),
    destination = transferDestination(input.destination);
  input = { ...input, principal, destination: destination! };
  if (
    principal.kind !== "user" ||
    !destination ||
    !ID.test(input.sourceSpaceId) ||
    !ID.test(input.sourceNodeId) ||
    !ID.test(input.destinationParentId) ||
    !["0", "infinity"].includes(input.depth) ||
    (input.overwriteTargetId !== undefined && !ID.test(input.overwriteTargetId))
  )
    throw new Error("invalid_copy_preparation");
  const name = portableName(input.name),
    targetPrincipal = destinationPrincipal(principal, destination);
  const source = await authorizeNode(db, principal, {
    operation: "node.read",
    nodeId: input.sourceNodeId,
    spaceId: input.sourceSpaceId,
    ownerOnly: !principalSelection(principal),
  });
  const target = await authorizeNode(db, targetPrincipal, {
    operation: "node.create",
    parentId: input.destinationParentId,
    spaceId: destination.spaceId,
    ownerOnly: !destination.share,
  });
  if (
    source.operation !== "node.read" ||
    target.operation !== "node.create" ||
    source.node.owner_id === target.parent.owner_id ||
    source.node.space_id === target.spaceId
  )
    throw new Error("cross_owner_copy_required");
  const overwrite = input.overwriteTargetId
    ? await authorizeNode(db, targetPrincipal, {
        operation: "node.trash",
        nodeId: input.overwriteTargetId,
        spaceId: destination.spaceId,
        ownerOnly: !destination.share,
      })
    : null;
  if (
    overwrite &&
    (overwrite.operation !== "node.trash" ||
      overwrite.parentId !== target.parent.id ||
      portableName(overwrite.node.name).nameCi !== name.nameCi)
  )
    throw new Error("invalid_copy_overwrite");
  const tree = await snapshot(db, source, input.depth),
    replaced = overwrite ? await snapshot(db, overwrite, "infinity") : null;
  if (
    tree.entries.length + (replaced?.entries.length ?? 0) > COPY_PREPARATION_LIMITS.nodes ||
    tree.properties.length + (replaced?.properties.length ?? 0) > COPY_PREPARATION_LIMITS.properties
  )
    throw new Error("copy_manifest_too_large");
  const transferBytes = tree.blobs.reduce((sum, b) => sum + b.size, 0);
  const sizes = new Map(tree.blobs.map((b) => [b.id, b.size]));
  const logicalBytes = tree.entries.reduce(
    (sum, n) => sum + (n.blobId ? sizes.get(n.blobId)! : 0),
    0,
  );
  if (
    !Number.isSafeInteger(transferBytes) ||
    transferBytes > COPY_PREPARATION_LIMITS.transferBytes ||
    !Number.isSafeInteger(logicalBytes)
  )
    throw new Error("copy_manifest_too_large");
  const body = Object.freeze({
    version: 1 as const,
    principal,
    destination,
    destinationParentId: target.parent.id,
    destinationOwnerId: target.parent.owner_id,
    name: name.name,
    nameCi: name.nameCi,
    depth: input.depth,
    source: tree,
    overwrite: replaced,
    transferBytes,
    logicalBytes,
  });
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  if (encoded.byteLength > COPY_PREPARATION_LIMITS.metadataBytes)
    throw new Error("copy_manifest_too_large");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const plan: PreparedCopy = Object.freeze({ ...body, digest });
  const assertions = immutableStatements([
    authorizationAssertion(source),
    authorizationAssertion(target),
    ...(overwrite ? [authorizationAssertion(overwrite)] : []),
    assertExists(`SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0`, [
      principal.epoch,
    ]),
    assertExists(
      `SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes WHERE parent_id=? AND name_ci=? AND deleted_at IS NULL AND id<>COALESCE(?,''))`,
      [target.parent.id, name.nameCi, overwrite && "node" in overwrite ? overwrite.node.id : null],
    ),
    ...copySnapshotAssertions(tree, input.depth),
    ...(replaced ? copySnapshotAssertions(replaced, "infinity") : []),
  ]);
  await atomicBatch(db, assertions);
  proofs.set(plan, assertions);
  return plan;
}

/** Request-local proof: append to the same admitted batch that durably records the job. */
export function copyPreparationAssertions(plan: PreparedCopy): readonly SqlStatement[] {
  const statements = proofs.get(plan);
  if (!statements) throw new Error("invalid_copy_preparation_proof");
  return statements;
}

export interface CopyBlobAllocation {
  readonly sourceBlobId: string;
  readonly destinationBlobId: string;
  readonly pinId: string;
  readonly reservationId: string;
  readonly bytes: number;
}
/** Stable per-blob identities; source aliases share one transfer and one reservation. */
export function preparedCopyBlobs(
  plan: PreparedCopy,
  jobId: string,
): readonly CopyBlobAllocation[] {
  copyPreparationAssertions(plan);
  if (!/^copy_[a-f0-9]{64}$/.test(jobId)) throw new Error("invalid_copy_reservation");
  return Object.freeze(
    plan.source.blobs.map((b, i) => {
      const suffix = String(i + 1).padStart(5, "0");
      return Object.freeze({
        sourceBlobId: b.id,
        destinationBlobId: jobId + "_b" + suffix,
        pinId: jobId + "_p" + suffix,
        reservationId: jobId + "_r" + suffix,
        bytes: b.size,
      });
    }),
  );
}
/** Append to the same admitted batch as the durable job/manifest. Never dispatch on its own.
 * Reserve each distinct destination blob and pin its source in one atomic transaction. */
export function reservePreparedCopyStatements(
  plan: PreparedCopy,
  jobId: string,
  expiresAt: number,
): readonly SqlStatement[] {
  const assertions = copyPreparationAssertions(plan),
    allocations = preparedCopyBlobs(plan, jobId);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 86400000
  )
    throw new Error("invalid_copy_reservation");
  const statements: SqlStatement[] = [
    ...assertions,
    assertExists(
      "SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0 AND ?>" + CLOCK,
      [plan.principal.epoch, expiresAt],
    ),
  ];
  for (let start = 0; start < allocations.length; start += 256) {
    const group = allocations.slice(start, start + 256),
      json = JSON.stringify(group);
    statements.push(
      {
        sql: "INSERT INTO reservations(id,owner_id,bytes,state,expires_at,epoch) SELECT json_extract(value,'$.reservationId'),?,json_extract(value,'$.bytes'),'reserved',?,? FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING",
        values: [plan.destinationOwnerId, expiresAt, plan.principal.epoch, json],
      },
      assertExists(
        "SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?) e CROSS JOIN reservations r ON r.id=json_extract(e.value,'$.reservationId') WHERE r.owner_id=? AND r.bytes=json_extract(e.value,'$.bytes') AND r.state='reserved' AND r.expires_at=? AND r.epoch=? AND r.share_id IS NULL AND r.op_id IS NULL)=?",
        [json, plan.destinationOwnerId, expiresAt, plan.principal.epoch, group.length],
      ),
      {
        sql:
          "INSERT INTO blob_pins(pin_id,blob_id,purpose,expires_at,created_at) SELECT json_extract(value,'$.pinId'),json_extract(value,'$.sourceBlobId'),'copy',?," +
          CLOCK +
          " FROM json_each(?) WHERE true ON CONFLICT(pin_id) DO NOTHING",
        values: [expiresAt, json],
      },
      assertExists(
        "SELECT 1 WHERE (SELECT COUNT(*) FROM json_each(?) e CROSS JOIN blob_pins p ON p.pin_id=json_extract(e.value,'$.pinId') AND p.blob_id=json_extract(e.value,'$.sourceBlobId') WHERE p.purpose='copy' AND p.expires_at=?)=?",
        [json, expiresAt, group.length],
      ),
    );
  }
  return immutableStatements(statements);
}
