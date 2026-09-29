import type { AudioMetadata, AudioMetadataUpdate, AudioTags } from "../../../shared/src/audio";
import { authorizationAssertion, authorizeNode, type Principal } from "../auth/authorize";
import { assertCreateLocks } from "../auth/locks";
import { assertOpenPermit } from "../db/permits";
import {
  assertExists,
  assertOneChange,
  atomicBatch,
  primary,
  type SqlStatement,
} from "../db/primary";
import type { Env } from "../env";
import {
  assertOperationClaim,
  claimOperation,
  findOperationIntent,
  lookupOperation,
  operationIntent,
} from "../jobs/operations";
import { TRACK_METADATA_GENERATOR } from "../media/tracks/common";
import { audioSearchTags } from "../search/audio";
import { nodeSearchSteps } from "../search/projection";
import { AUDIO_MATCH, AUDIO_METADATA, audioStatement } from "./audio";
import { commitMutationStatements, type MutationOutcome, type MutationStep } from "./fsMutation";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const AUDIO_METADATA_STEPS = 7;
export function audioMetadataUpdate(input: AudioMetadataUpdate): AudioMetadataUpdate {
  const invalid = () => new Error("invalid_audio_metadata");
  if (
    !input ||
    typeof input.blobId !== "string" ||
    !ID.test(input.blobId) ||
    input.generator !== TRACK_METADATA_GENERATOR ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision >= Number.MAX_SAFE_INTEGER
  )
    throw invalid();
  const tags = {} as AudioTags;
  for (const key of ["title", "artist", "album"] as const) {
    const value = input[key];
    if (
      value !== null &&
      (typeof value !== "string" || value.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(value))
    )
      throw invalid();
    const text = value?.normalize("NFC").trim() || null;
    if (text && new TextEncoder().encode(text).length > 1024) throw invalid();
    tags[key] = text;
  }
  return { blobId: input.blobId, generator: input.generator, revision: input.revision, ...tags };
}
export class AudioMetadataConflict extends Error {
  constructor() {
    super("audio_metadata_conflict");
  }
}
async function current(db: D1Database, principal: Principal, nodeId: string) {
  if (principal.kind !== "user" || !ID.test(nodeId)) throw new Error("authorization_denied");
  const spaceId = await primary(db)
    .prepare("SELECT space_id FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<string>("space_id");
  if (!spaceId) throw new Error("authorization_denied");
  const proof = await authorizeNode(db, principal, {
    operation: "audio.metadata.write",
    nodeId,
    spaceId,
  });
  if (proof.operation !== "audio.metadata.write") throw new Error("authorization_denied");
  return proof;
}

/** Metadata uses the same durable permit, operation receipt and atomic node/audit protocol as Files. */
export async function editAudioMetadata(
  env: Pick<Env, "DB" | "LOCKS">,
  principal: Principal,
  nodeId: string,
  key: string,
  value: AudioMetadataUpdate,
): Promise<MutationOutcome> {
  const input = audioMetadataUpdate(value),
    initial = await current(env.DB, principal, nodeId),
    spaceId = initial.node.space_id;
  const intent = await operationIntent(
    principal,
    key,
    spaceId,
    "audio.metadata.write",
    { nodeId, ...input },
    { nodeId, blobId: input.blobId },
  );
  const terminal = async (): Promise<MutationOutcome> => {
    const operation = await lookupOperation(env.DB, principal, intent.id);
    if (!operation) throw new Error("authorization_denied");
    return { kind: "terminal", operation };
  };
  const conflictOrReceipt = async (): Promise<MutationOutcome> => {
    // The identical intent may have committed while this request was waiting for its permit.
    const row = await findOperationIntent(env.DB, intent, AUDIO_METADATA_STEPS);
    if (row && row.state !== "claimed") return terminal();
    throw new AudioMetadataConflict();
  };
  const existing = await findOperationIntent(env.DB, intent, AUDIO_METADATA_STEPS);
  if (existing && existing.state !== "claimed") return terminal();
  if (initial.node.current_blob_id !== input.blobId || initial.node.revision !== input.revision)
    return conflictOrReceipt();
  const lock = env.LOCKS.get(env.LOCKS.idFromName(spaceId));
  const permit = await lock.acquireNodeWrite({
    requestId: intent.id,
    spaceId,
    nodeId,
    principal,
    lockTokens: [],
    operation: "audio.metadata.write",
  });
  let outcome: MutationOutcome | undefined;
  let dispatched = false;
  try {
    const proof = await current(env.DB, principal, nodeId);
    if (proof.node.current_blob_id !== input.blobId || proof.node.revision !== input.revision) {
      outcome = await conflictOrReceipt();
      return outcome;
    }
    const read = await atomicBatch(env.DB, [
      authorizationAssertion(proof),
      {
        sql: audioStatement(true, 1),
        values: [nodeId, spaceId, proof.node.owner_id, input.generator, null, null, null],
      },
    ]);
    const metadata = (read.at(-1)!.results[0] as { metadataJson?: unknown } | undefined)
      ?.metadataJson;
    if (typeof metadata !== "string") throw new AudioMetadataConflict();
    const extracted = (JSON.parse(metadata) as AudioMetadata).extracted;
    const search = audioSearchTags({
      title: input.title ?? extracted.title,
      artist: input.artist ?? extracted.artist,
      album: input.album ?? extracted.album,
    });
    const claimed = await claimOperation(env.DB, intent, permit, proof, AUDIO_METADATA_STEPS);
    if (claimed.kind !== "claimed") {
      outcome = await terminal();
      return outcome;
    }
    const claim = claimed.claim,
      op = intent.id,
      clock = "strftime('%s','now')*1000";
    const steps: MutationStep[] = [
      {
        kind: "audio_metadata",
        affectedId: nodeId,
        statement: {
          sql: "UPDATE node_audio SET title_override=?,artist_override=?,album_override=?,search_text_norm=?,search_tokens=?,search_source=?,search_version=? WHERE node_id=? AND blob_id=? AND generator_version=?",
          values: [
            input.title,
            input.artist,
            input.album,
            search.textNorm,
            search.tokens,
            search.source,
            search.version,
            nodeId,
            input.blobId,
            input.generator,
          ],
        },
      },
      {
        kind: "node",
        affectedId: nodeId,
        statement: {
          sql: `UPDATE nodes SET revision=revision+1,last_op_id=?,updated_at=MAX(updated_at,${clock}) WHERE id=? AND revision=? AND current_blob_id=?`,
          values: [op, nodeId, input.revision, input.blobId],
        },
      },
      {
        kind: "tree",
        affectedId: spaceId,
        statement: {
          sql: "UPDATE spaces SET tree_generation=tree_generation+1 WHERE id=? AND tree_generation=?",
          values: [spaceId, proof.node.tree_generation],
        },
      },
      ...nodeSearchSteps(nodeId, spaceId, proof.node.name, input.revision),
      {
        kind: "activity",
        affectedId: nodeId,
        statement: {
          sql: `INSERT INTO activity(id,op_id,actor_id,kind,affected_id,created_at) VALUES(?,?,?,'audio.metadata.write',?,${clock})`,
          values: [
            `${op}_activity`,
            op,
            principal.kind === "user" ? principal.user_id : null,
            nodeId,
          ],
        },
      },
    ];
    const statements: SqlStatement[] = [
      assertOpenPermit(permit),
      assertOperationClaim(claim),
      authorizationAssertion(proof),
      assertCreateLocks(nodeId, spaceId, principal, []),
      assertExists(
        `SELECT 1 FROM nodes n JOIN node_audio a ON a.node_id=n.id JOIN blobs b ON ${AUDIO_MATCH}
        WHERE n.id=?1 AND n.space_id=?2 AND n.owner_id=?3 AND ${AUDIO_METADATA}=?5`,
        [nodeId, spaceId, proof.node.owner_id, input.generator, metadata],
      ),
      assertExists("SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM operation_steps WHERE op_id=?)", [op]),
    ];
    for (const [index, step] of steps.entries())
      statements.push(
        step.statement,
        assertOneChange,
        {
          sql: "INSERT INTO operation_steps(op_id,step_no,kind,affected_id) VALUES(?,?,?,?)",
          values: [op, index + 1, step.kind, step.affectedId],
        },
        assertOneChange,
      );
    statements.push(
      {
        sql: `UPDATE operations SET state='committed',result_json=?,updated_at=MAX(updated_at,${clock}) WHERE op_id=? AND state='claimed' AND (SELECT COUNT(*) FROM operation_steps WHERE op_id=?)=expected_steps`,
        values: [JSON.stringify({ status: 200, nodeId, revision: input.revision + 1 }), op, op],
      },
      assertOneChange,
    );
    dispatched = true;
    outcome = await commitMutationStatements(env.DB, claim, statements);
    return outcome;
  } finally {
    // Unknown commits keep their permit until the durable receipt or lease recovery settles them.
    if (!dispatched || outcome?.kind === "terminal") {
      try {
        await lock.release(intent.id, permit);
      } catch {
        /* Lease recovery releases it. */
      }
    }
  }
}
