import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import {
  principalSelection,
  type SelectedShareRecord,
  storedPrincipal,
} from "../auth/selectedShare";
import {
  destinationPrincipal,
  storedDestination,
  type TransferDestination,
  type TransferDestinationRecord,
} from "../auth/transferScope";
import { UPLOAD_OPERATION_PRINCIPAL } from "../auth/uploadPrincipal";
import { assertExists, primary, type SqlStatement } from "../db/primary";
import { copyPublicationAuthority } from "./copyPublicationAuthority";

export interface EventRow extends SelectedShareRecord, TransferDestinationRecord {
  state: string;
  kind: string;
  payload_ref: string;
  epoch: number;
  op_id: string;
  op_kind: string;
  op_state: string;
  principal_kind: string;
  principal_id: string;
  credential_id: string | null;
  credential_version: number | null;
  space_id: string;
  owner_id: string;
  operands_json: string;
  result_json: string | null;
}

export async function readOutboxEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return primary(db)
    .prepare(`SELECT b.state,b.kind,b.payload_ref,b.epoch,o.op_id,o.kind AS op_kind,
      o.state AS op_state,o.principal_kind,o.principal_id,o.credential_id,
      o.credential_version,o.selected_share_id,o.selected_share_version,o.destination_space_id,o.destination_share_id,o.destination_share_version,o.space_id,s.owner_id,o.operands_json,o.result_json FROM outbox b JOIN operations o ON o.op_id=b.op_id
      JOIN spaces s ON s.id=o.space_id
      WHERE b.outbox_id=?`)
    .bind(id)
    .first<EventRow>();
}

function savedPrincipal(row: EventRow): Principal | null {
  try {
    if (!row.credential_id) return null;
    if (row.principal_kind === "user" || row.principal_kind === "app_password") {
      return storedPrincipal(
        {
          kind: row.principal_kind,
          user_id: row.principal_id,
          credential_id: row.credential_id,
          epoch: row.epoch,
        },
        row,
      );
    }
    if (row.principal_kind === "link_share" && row.credential_version !== null) {
      return storedPrincipal(
        {
          kind: "link_share",
          share_id: row.principal_id,
          share_version: row.credential_version,
          credential_id: row.credential_id,
          epoch: row.epoch,
        },
        row,
      );
    }
    return null;
  } catch {
    return null;
  }
}

/** Current saved actor/credential, exact selected scopes, immutable operands and result. */
export async function nodeEventAuthority(
  db: D1Database,
  row: EventRow,
): Promise<SqlStatement[] | null> {
  if (
    !(
      (row.kind === "node.created" &&
        [
          "node.create",
          "node.copy",
          "copy.publish",
          "dav.mkcol",
          "dav.lock",
          "dav.put",
          "dav.copy",
          "upload.complete",
        ].includes(row.op_kind)) ||
      (row.kind === "node.updated" && ["dav.put", "upload.complete"].includes(row.op_kind)) ||
      (row.kind === "node.trashed" && ["node.trash", "dav.delete"].includes(row.op_kind)) ||
      (row.kind === "node.restored" && row.op_kind === "node.restore") ||
      (row.kind === "node.purged" && row.op_kind === "node.purge") ||
      (row.kind === "node.renamed" &&
        ["node.rename", "node.move", "dav.move"].includes(row.op_kind))
    ) ||
    row.op_state !== "committed"
  )
    return null;
  let destination: TransferDestination | undefined;
  try {
    destination = storedDestination(row);
    if (
      destination &&
      (!["user", "app_password"].includes(row.principal_kind) ||
        !["node.copy", "node.move", "dav.copy", "dav.move"].includes(row.op_kind) ||
        destination.spaceId !== row.space_id)
    )
      return null;
  } catch {
    return null;
  }
  const principal = savedPrincipal(row);
  if (!principal) return null;
  const targetPrincipal = destinationPrincipal(principal, destination);
  const sourceOwnerOnly = !!destination && !principalSelection(principal),
    targetOwnerOnly = !!destination && !destination.share;
  let parentId: string;
  let nodeId: string | undefined;
  let sourceNodeId: string | undefined;
  let sourceParentId: string | undefined;
  let uploadId: string | undefined;
  try {
    const operands = JSON.parse(row.operands_json) as {
      parentId?: unknown;
      overwriteTargetId?: unknown;
      nodeId?: unknown;
      sourceNodeId?: unknown;
      sourceParentId?: unknown;
      uploadId?: unknown;
    };
    const result = JSON.parse(row.result_json ?? "null") as {
      status?: unknown;
      nodeId?: unknown;
    } | null;
    if (typeof operands.parentId !== "string") return null;
    if (
      !result ||
      result.nodeId !== row.payload_ref ||
      result.status !==
        (row.kind === "node.created"
          ? ["node.copy", "dav.copy", "copy.publish"].includes(row.op_kind) &&
            typeof operands.overwriteTargetId === "string"
            ? 204
            : 201
          : row.kind === "node.updated" || row.kind === "node.trashed"
            ? 204
            : row.kind === "node.restored" || row.kind === "node.purged"
              ? 200
              : ["node.move", "dav.move"].includes(row.op_kind)
                ? typeof operands.overwriteTargetId === "string"
                  ? 204
                  : 201
                : 200)
    )
      return null;
    parentId = operands.parentId;
    if (typeof operands.uploadId === "string") uploadId = operands.uploadId;
    if (principalSelection(principal) || destination) {
      if (["node.copy", "dav.copy"].includes(row.op_kind)) {
        if (typeof operands.sourceNodeId !== "string") return null;
        sourceNodeId = operands.sourceNodeId;
      }
      if (["node.move", "dav.move"].includes(row.op_kind)) {
        if (typeof operands.sourceParentId !== "string") return null;
        sourceParentId = operands.sourceParentId;
      }
    }
    if (
      row.kind === "node.renamed" ||
      row.kind === "node.updated" ||
      row.kind === "node.trashed" ||
      row.kind === "node.restored" ||
      row.kind === "node.purged"
    ) {
      if (typeof operands.nodeId !== "string" || operands.nodeId !== row.payload_ref) return null;
      if (row.kind !== "node.trashed" && row.kind !== "node.purged") nodeId = operands.nodeId;
    } else if (operands.nodeId !== undefined) {
      return null;
    }
  } catch {
    return null;
  }
  let uploadOnly = false;
  const uploadAuthority: SqlStatement[] = [];
  if (row.op_kind === "upload.complete" && principal.kind === "link_share") {
    if (!uploadId) return null;
    const sql = `SELECT u.upload_only FROM uploads u JOIN operations o ON o.op_id=u.completion_op_id
      WHERE u.id=? AND o.op_id=? AND u.state='completed' AND u.credential_id=?
        AND u.owner_id=? AND u.space_id=? AND u.parent_id=? AND u.epoch=?
        AND u.link_share_id=? AND u.link_share_version=?
        AND o.kind='upload.complete' AND o.state='committed' AND o.epoch=u.epoch
        AND o.credential_id=u.credential_id AND o.space_id=u.space_id
        AND o.operands_json=? AND o.result_json=? AND ${UPLOAD_OPERATION_PRINCIPAL}`;
    const values = [
      uploadId,
      row.op_id,
      row.credential_id,
      row.owner_id,
      row.space_id,
      parentId,
      row.epoch,
      principal.share_id,
      principal.share_version,
      row.operands_json,
      row.result_json,
    ];
    const stored = await primary(db)
      .prepare(sql)
      .bind(...values)
      .first<{ upload_only: number }>();
    if (!stored || ![0, 1].includes(stored.upload_only)) return null;
    uploadOnly = stored.upload_only === 1;
    uploadAuthority.push(
      assertExists(sql + " AND u.upload_only=?", [...values, stored.upload_only]),
    );
  }
  const publicationAuthorities =
    row.op_kind === "copy.publish"
      ? await copyPublicationAuthority(db, row.op_id, principal).catch(() => null)
      : [];
  if (!publicationAuthorities) return null;
  let authorized: Awaited<ReturnType<typeof authorizeNode>>;
  const originalAuthorities: Awaited<ReturnType<typeof authorizeNode>>[] = [];
  try {
    if (sourceNodeId)
      originalAuthorities.push(
        await authorizeNode(db, principal, {
          ownerOnly: sourceOwnerOnly,
          operation: "node.read",
          nodeId: sourceNodeId,
          spaceId: row.space_id,
        }),
      );
    if (sourceParentId)
      originalAuthorities.push(
        await authorizeNode(db, principal, {
          operation: "node.create",
          parentId: sourceParentId,
          spaceId: row.space_id,
          ownerOnly: sourceOwnerOnly,
        }),
        await authorizeNode(db, targetPrincipal, {
          operation: "node.create",
          parentId,
          spaceId: row.space_id,
          ownerOnly: targetOwnerOnly,
        }),
      );
    authorized =
      row.kind === "node.trashed" || row.kind === "node.purged"
        ? await authorizeNode(db, targetPrincipal, {
            ownerOnly: targetOwnerOnly,
            operation:
              row.kind === "node.trashed" && targetPrincipal.kind === "link_share"
                ? "node.props.write"
                : "node.read",
            nodeId: parentId,
            spaceId: row.space_id,
          })
        : nodeId
          ? await authorizeNode(db, targetPrincipal, {
              ownerOnly: targetOwnerOnly,
              operation: row.kind === "node.updated" ? "node.content.write" : "node.rename",
              nodeId,
              spaceId: row.space_id,
            })
          : await authorizeNode(db, targetPrincipal, {
              ownerOnly: targetOwnerOnly,
              operation: "node.create",
              parentId,
              spaceId: row.space_id,
              ...(uploadOnly ? { upload: true } : {}),
            });
    if (
      (authorized.operation === "node.rename" || authorized.operation === "node.content.write") &&
      authorized.parentId !== parentId
    )
      return null;
  } catch {
    return null;
  }
  return [
    authorizationAssertion(authorized),
    ...originalAuthorities.map(authorizationAssertion),
    ...publicationAuthorities,
    ...uploadAuthority,
  ];
}
