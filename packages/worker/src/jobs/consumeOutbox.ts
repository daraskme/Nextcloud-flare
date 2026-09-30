import { searchText } from "@next-cloud-flare/shared/names";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertExists, assertOneChange, primary, type SqlStatement } from "../db/primary";
import type { Env } from "../env";
import { AUDIO_GENERATOR_VERSION, type AudioInspection, inspectAudioObject } from "../media/audio";
import {
  acquireSystemMutation,
  commitSystemMutation,
  type SystemMutationSource,
} from "../services/systemMutation";
import { epubCompletionStatements, prepareEpubProjection } from "./epub";
import { type MediaJobEnv, processImageOutbox } from "./media";
import { processVideoOutbox, type VideoJobEnv } from "./video";

export const OUTBOX_CLAIM_LEASE_MS = 30_000;
export type ConsumeResult = "completed" | "failed" | "retry";
type OutboxSource = SystemMutationSource & Partial<Pick<Env, "BLOBS" | "IMAGES">>;

interface EventRow {
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

interface AudioSource {
  kind: string;
  name: string;
  revision: number;
  blob_id: string | null;
  r2_key: string | null;
  size: number | null;
  r2_etag: string | null;
  blob_state: string | null;
}

async function eventRow(db: D1Database, id: string): Promise<EventRow | null> {
  return primary(db)
    .prepare(`SELECT b.state,b.kind,b.payload_ref,b.epoch,o.op_id,o.kind AS op_kind,
      o.state AS op_state,o.principal_kind,o.principal_id,o.credential_id,
      o.credential_version,o.space_id,s.owner_id,o.operands_json,o.result_json FROM outbox b JOIN operations o ON o.op_id=b.op_id
      JOIN spaces s ON s.id=o.space_id
      WHERE b.outbox_id=?`)
    .bind(id)
    .first<EventRow>();
}

function savedPrincipal(row: EventRow): Principal | null {
  if (!row.credential_id) return null;
  if (row.principal_kind === "user" || row.principal_kind === "app_password") {
    return {
      kind: row.principal_kind,
      user_id: row.principal_id,
      credential_id: row.credential_id,
      epoch: row.epoch,
    };
  }
  if (row.principal_kind === "link_share" && row.credential_version !== null) {
    return {
      kind: "link_share",
      share_id: row.principal_id,
      share_version: row.credential_version,
      credential_id: row.credential_id,
      epoch: row.epoch,
    };
  }
  return null;
}

function isAudioEvent(row: EventRow): boolean {
  return (
    row.kind === "node.updated" ||
    (row.kind === "node.created" && ["dav.put", "upload.complete"].includes(row.op_kind))
  );
}

async function audioSource(db: D1Database, row: EventRow): Promise<AudioSource | null> {
  if (!isAudioEvent(row)) return null;
  return primary(db)
    .prepare(
      `SELECT n.kind,n.name,n.revision,n.current_blob_id AS blob_id,b.r2_key,b.size,
        bs.r2_etag,b.state AS blob_state
      FROM nodes n
      LEFT JOIN blobs b ON b.id=n.current_blob_id
      LEFT JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
      WHERE n.id=? AND n.space_id=? AND n.deleted_at IS NULL`,
    )
    .bind(row.payload_ref, row.space_id)
    .first<AudioSource>();
}

function audioCompletionStatements(
  source: AudioSource,
  row: EventRow,
  inspection: Exclude<AudioInspection, { kind: "transient" }>,
): SqlStatement[] {
  if (
    source.kind !== "file" ||
    !source.blob_id ||
    !source.r2_key ||
    source.size === null ||
    !source.r2_etag
  )
    return [];
  const metadata = inspection.kind === "metadata" ? inspection.metadata : null;
  const search = searchText(source.name, [
    metadata?.title ?? null,
    metadata?.artist ?? null,
    metadata?.album ?? null,
  ]);
  return [
    assertExists(
      `SELECT 1 FROM nodes n
      JOIN blobs b ON b.id=n.current_blob_id
      JOIN blob_storage bs ON bs.blob_id=b.id AND bs.removed_at IS NULL
      WHERE n.id=? AND n.space_id=? AND n.kind='file' AND n.name=? AND n.revision=?
        AND n.current_blob_id=? AND n.deleted_at IS NULL
        AND b.r2_key=? AND b.size=? AND b.state IN ('committed','gc_candidate')
        AND bs.bytes=b.size AND bs.r2_etag=?`,
      [
        row.payload_ref,
        row.space_id,
        source.name,
        source.revision,
        source.blob_id,
        source.r2_key,
        source.size,
        source.r2_etag,
      ],
    ),
    {
      sql: `INSERT INTO search_fts(search_fts,rowid,text_norm,tokens)
        SELECT 'delete',rowid,text_norm,tokens FROM search_index
        WHERE node_id=? AND space_id=? AND revision=?`,
      values: [row.payload_ref, row.space_id, source.revision],
    },
    assertOneChange,
    ...(metadata
      ? [
          {
            sql: `INSERT INTO node_audio(
              node_id,blob_id,generator_version,codec,title_extracted,artist_extracted,album_extracted
            ) VALUES(?,?,?,'mp3',?,?,?)
            ON CONFLICT(node_id) DO UPDATE SET
              blob_id=excluded.blob_id,generator_version=excluded.generator_version,
              duration_ms=NULL,codec=excluded.codec,
              title_extracted=excluded.title_extracted,artist_extracted=excluded.artist_extracted,
              album_extracted=excluded.album_extracted,track_number=NULL,disc_number=NULL`,
            values: [
              row.payload_ref,
              source.blob_id,
              AUDIO_GENERATOR_VERSION,
              metadata.title,
              metadata.artist,
              metadata.album,
            ],
          },
        ]
      : [
          {
            sql: "DELETE FROM node_audio WHERE node_id=?",
            values: [row.payload_ref],
          },
        ]),
    {
      sql: `UPDATE search_index
        SET text_norm=?,tokens=?,normalization_version=?
        WHERE node_id=? AND space_id=? AND revision=?`,
      values: [
        search.textNorm,
        search.tokens,
        search.version,
        row.payload_ref,
        row.space_id,
        source.revision,
      ],
    },
    assertOneChange,
    {
      sql: `INSERT INTO search_fts(rowid,text_norm,tokens)
        SELECT rowid,text_norm,tokens FROM search_index
        WHERE node_id=? AND space_id=? AND revision=?`,
      values: [row.payload_ref, row.space_id, source.revision],
    },
    assertOneChange,
  ];
}

/** Complete a node event only after a fenced D1 claim and current authorization. */
export async function consumeOutbox(
  env: OutboxSource,
  outboxId: string,
  deadline = Date.now() + 25_000,
): Promise<ConsumeResult> {
  const { DB: db } = env;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 25_000)
    return "retry";
  if (!outboxId || outboxId.length > 128) return "retry";
  const row = await eventRow(db, outboxId);
  if (row?.state === "completed") return "completed";
  if (row?.state === "failed") return "failed";
  if (
    !row ||
    !(
      (row.kind === "node.created" &&
        [
          "node.create",
          "node.copy",
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
    row.op_state !== "committed" ||
    !["dispatching", "sent"].includes(row.state)
  )
    return "retry";
  const principal = savedPrincipal(row);
  if (!principal) return "retry";
  let parentId: string;
  let nodeId: string | undefined;
  try {
    const operands = JSON.parse(row.operands_json) as {
      parentId?: unknown;
      overwriteTargetId?: unknown;
      nodeId?: unknown;
    };
    const result = JSON.parse(row.result_json ?? "null") as {
      status?: unknown;
      nodeId?: unknown;
    } | null;
    if (typeof operands.parentId !== "string") return "retry";
    if (
      !result ||
      result.nodeId !== row.payload_ref ||
      result.status !==
        (row.kind === "node.created"
          ? ["node.copy", "dav.copy"].includes(row.op_kind) &&
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
      return "retry";
    parentId = operands.parentId;
    if (
      row.kind === "node.renamed" ||
      row.kind === "node.updated" ||
      row.kind === "node.trashed" ||
      row.kind === "node.restored" ||
      row.kind === "node.purged"
    ) {
      if (typeof operands.nodeId !== "string" || operands.nodeId !== row.payload_ref)
        return "retry";
      if (row.kind !== "node.trashed" && row.kind !== "node.purged") nodeId = operands.nodeId;
    } else if (operands.nodeId !== undefined) {
      return "retry";
    }
  } catch {
    return "retry";
  }
  let authorized: Awaited<ReturnType<typeof authorizeNode>>;
  try {
    authorized =
      row.kind === "node.trashed" || row.kind === "node.purged"
        ? await authorizeNode(db, principal, {
            operation: "node.read",
            nodeId: parentId,
            spaceId: row.space_id,
          })
        : nodeId
          ? await authorizeNode(db, principal, {
              operation: row.kind === "node.updated" ? "node.content.write" : "node.rename",
              nodeId,
              spaceId: row.space_id,
            })
          : await authorizeNode(db, principal, {
              operation: "node.create",
              parentId,
              spaceId: row.space_id,
            });
    if (
      (authorized.operation === "node.rename" || authorized.operation === "node.content.write") &&
      authorized.parentId !== parentId
    )
      return "retry";
  } catch {
    return "retry";
  }
  const token = crypto.randomUUID();
  const clock = "strftime('%s','now')*1000";
  try {
    const claim = await acquireSystemMutation(env, row.owner_id, "outbox.consume-claim", deadline);
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await commitSystemMutation(db, claim, row.owner_id, [
      authorizationAssertion(authorized),
      {
        sql: `UPDATE outbox SET claim_token=?,claim_expires_at=${clock}+?,updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND epoch=? AND state IN ('dispatching','sent')
            AND (claim_token IS NULL OR claim_expires_at<=${clock})
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind=? AND o.operands_json=? AND o.result_json=?
                AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [
          token,
          OUTBOX_CLAIM_LEASE_MS,
          outboxId,
          row.epoch,
          row.epoch,
          row.op_kind,
          row.operands_json,
          row.result_json,
        ],
      },
      assertOneChange,
    ]);
    const source = await audioSource(db, row);
    let inspection: Exclude<AudioInspection, { kind: "transient" }> | null = null;
    if (isAudioEvent(row) && !source) return "retry";
    if (source?.kind === "file" && source.blob_id !== null) {
      if (
        !env.BLOBS ||
        source.r2_key === null ||
        source.size === null ||
        source.r2_etag === null ||
        !["committed", "gc_candidate"].includes(source.blob_state ?? "") ||
        source.size < 0
      )
        return "retry";
      const inspected = await inspectAudioObject(
        env.BLOBS,
        {
          key: source.r2_key,
          size: source.size,
          r2Etag: source.r2_etag,
        },
        deadline - 6000,
      );
      if (inspected.kind === "transient") return "retry";
      inspection = inspected;
    }
    const epub = await prepareEpubProjection(env, row, deadline - 4000);
    if (epub === "retry") return "retry";
    if ((row.kind === "node.created" || row.kind === "node.updated") && env.BLOBS) {
      try {
        const mediaAuthorized = await authorizeNode(db, principal, {
          operation: "node.read",
          nodeId: row.payload_ref,
          spaceId: row.space_id,
        });
        const mediaClaim = {
          outboxId,
          outboxToken: token,
          epoch: row.epoch,
          ownerId: row.owner_id,
          nodeId: row.payload_ref,
          operationKind: row.op_kind,
          operandsJson: row.operands_json,
          resultJson: row.result_json,
        };
        const video = await processVideoOutbox(
          env as VideoJobEnv,
          mediaClaim,
          mediaAuthorized,
          deadline,
        );
        if (video === "retry") return "retry";
        if (video === "not-video" && env.IMAGES) {
          const media = await processImageOutbox(
            env as MediaJobEnv,
            mediaClaim,
            mediaAuthorized,
            deadline,
          );
          if (media === "retry") return "retry";
        }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "authorization_denied") return "retry";
      }
    }
    const completion = await acquireSystemMutation(env, row.owner_id, "outbox.complete", deadline);
    if (Date.now() >= deadline) throw new Error("outbox_budget");
    await commitSystemMutation(db, completion, row.owner_id, [
      authorizationAssertion(authorized),
      ...(source && inspection ? audioCompletionStatements(source, row, inspection) : []),
      ...epubCompletionStatements(epub),
      {
        sql: `UPDATE outbox SET state='completed',updated_at=MAX(updated_at,${clock})
          WHERE outbox_id=? AND claim_token=? AND claim_expires_at>${clock}
            AND epoch=? AND state IN ('dispatching','sent')
            AND EXISTS(SELECT 1 FROM control WHERE singleton=1 AND epoch=? AND maintenance=0)
            AND EXISTS(SELECT 1 FROM operations o JOIN operation_steps s ON s.op_id=o.op_id
              WHERE o.op_id=outbox.op_id AND o.state='committed' AND o.epoch=outbox.epoch
                AND o.kind=? AND o.operands_json=? AND o.result_json=?
                AND s.kind='node'
                AND s.affected_id=outbox.payload_ref)`,
        values: [
          outboxId,
          token,
          row.epoch,
          row.epoch,
          row.op_kind,
          row.operands_json,
          row.result_json,
        ],
      },
      assertOneChange,
    ]);
    return "completed";
  } catch {
    // A lost D1 acknowledgement is safe to ack only when the terminal row is visible.
    return (await eventRow(db, outboxId))?.state === "completed" ? "completed" : "retry";
  }
}
