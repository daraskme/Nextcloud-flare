import type { Env } from "../env.js";
import { audioLimits, parseAudioMetadata, type AudioCover } from "../media/audio/parser.js";
import { isEffectiveLive } from "../services/effectiveLive.js";

export const audioGeneratorVersion = "audio-v1";

export interface AudioJobMessage {
  kind: "audio-extract";
  jobId: string;
}

interface AudioJobRow {
  id: string;
  nodeId: string;
  blobId: string;
  ownerId: string;
  generatorVersion: string;
  epoch: number;
  attempt: number;
  claimToken: string;
  rootId: string;
  r2Key: string;
  size: number;
  name: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function supported(name: string): boolean {
  return /\.(?:mp3|flac|ogg|opus|m4a|m4b|mp4|wav)$/iu.test(name);
}

async function range(
  env: Env,
  key: string,
  size: number,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > size
  ) {
    throw new Error("audio_range_invalid");
  }
  if (length === 0) return new Uint8Array();
  const object = await env.BLOBS.get(key, { range: { offset, length } });
  if (object === null) throw new Error("audio_source_missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) throw new Error("audio_range_inconsistent");
  return bytes;
}

function moov(bytes: Uint8Array): Uint8Array | undefined {
  for (let offset = 4; offset + 4 <= bytes.byteLength; offset += 1) {
    if (
      bytes[offset] !== 0x6d ||
      bytes[offset + 1] !== 0x6f ||
      bytes[offset + 2] !== 0x6f ||
      bytes[offset + 3] !== 0x76
    ) {
      continue;
    }
    const start = offset - 4;
    const length = new DataView(bytes.buffer, bytes.byteOffset + start, 4).getUint32(0, false);
    if (length >= 8 && length <= audioLimits.mp4WindowBytes && start + length <= bytes.byteLength) {
      return bytes.subarray(start, start + length);
    }
  }
  return undefined;
}

async function coverDerivative(
  env: Env,
  job: AudioJobRow,
  cover: AudioCover | null,
): Promise<string | null> {
  if (cover === null) return null;
  const stream = new Response(cover.bytes).body;
  if (stream === null) throw new Error("audio_cover_stream_unavailable");
  const result = await env.IMAGES.input(stream)
    .transform({ width: 512, height: 512, fit: "scale-down" })
    .output({ format: "image/webp", quality: 82, anim: false });
  const output = await result.response().arrayBuffer();
  if (output.byteLength > audioLimits.coverBytes) throw new Error("audio_cover_too_large");
  const key = `u/${job.ownerId}/d/${job.blobId}/${job.generatorVersion}/audio-cover/${job.claimToken}.webp`;
  await env.BLOBS.put(key, output, { httpMetadata: { contentType: "image/webp" } });
  return key;
}

async function claimAudioJob(env: Env, jobId: string): Promise<AudioJobRow | null> {
  const token = randomId("claim");
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE audio_jobs SET state='claimed',attempt=attempt+1,claim_token=?1,claim_expires_at=?2,last_error=NULL,updated_at=?3 WHERE id=?4 AND (state='pending' OR state='failed' OR (state='claimed' AND claim_expires_at<=?3)) AND attempt<3 AND epoch=(SELECT epoch FROM control WHERE singleton=1) AND EXISTS(SELECT 1 FROM users WHERE id=audio_jobs.owner_id AND disabled_at IS NULL) AND EXISTS(SELECT 1 FROM nodes WHERE id=audio_jobs.node_id AND owner_id=audio_jobs.owner_id AND current_blob_id=audio_jobs.blob_id AND deleted_at IS NULL)",
  )
    .bind(token, now + 30_000, now, jobId)
    .run();
  return env.DB.prepare(
    "SELECT j.id,j.node_id nodeId,j.blob_id blobId,j.owner_id ownerId,j.generator_version generatorVersion,j.epoch,j.attempt,j.claim_token claimToken,s.root_node_id rootId,b.r2_key r2Key,b.size,n.name FROM audio_jobs j JOIN nodes n ON n.id=j.node_id JOIN spaces s ON s.id=n.space_id JOIN blobs b ON b.id=j.blob_id WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(jobId, token)
    .first<AudioJobRow>();
}

async function failAudioJob(env: Env, job: AudioJobRow, error: unknown): Promise<void> {
  const code = error instanceof Error ? error.message.slice(0, 160) : "audio_job_failed";
  await env.DB.prepare(
    "UPDATE audio_jobs SET state='failed',claim_token=NULL,claim_expires_at=NULL,last_error=?1,updated_at=?2 WHERE id=?3 AND state='claimed' AND claim_token=?4",
  )
    .bind(code, Date.now(), job.id, job.claimToken)
    .run();
}

export async function enqueueAudioJob(
  env: Env,
  nodeId: string,
  send: (message: AudioJobMessage) => Promise<void> = async (message) => {
    await env.JOBS.send(message);
  },
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT n.id nodeId,n.owner_id ownerId,n.current_blob_id blobId,n.name FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(nodeId)
    .first<{ nodeId: string; ownerId: string; blobId: string; name: string }>();
  if (row === null || !supported(row.name)) return null;
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const now = Date.now();
  const jobId = randomId("audio");
  await env.DB.prepare(
    "INSERT INTO audio_jobs(id,node_id,blob_id,owner_id,generator_version,saved_principal_json,epoch,state,attempt,claim_token,claim_expires_at,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',0,NULL,NULL,NULL,?8,?8) ON CONFLICT(node_id,blob_id,generator_version) DO NOTHING",
  )
    .bind(
      jobId,
      row.nodeId,
      row.blobId,
      row.ownerId,
      audioGeneratorVersion,
      JSON.stringify({ kind: "system", systemKind: "audio", ownerId: row.ownerId }),
      control.epoch,
      now,
    )
    .run();
  const job = await env.DB.prepare(
    "SELECT id,state,attempt FROM audio_jobs WHERE node_id=?1 AND blob_id=?2 AND generator_version=?3",
  )
    .bind(row.nodeId, row.blobId, audioGeneratorVersion)
    .first<{ id: string; state: string; attempt: number }>();
  if (job === null || job.state === "completed" || job.attempt >= 3) return job?.id ?? null;
  await send({ kind: "audio-extract", jobId: job.id });
  return job.id;
}

export async function discoverAudioJobs(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT n.id FROM nodes n JOIN blobs b ON b.id=n.current_blob_id LEFT JOIN node_audio a ON a.node_id=n.id AND a.blob_id=n.current_blob_id AND a.generator_version=?1 WHERE n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND a.node_id IS NULL AND (lower(n.name) LIKE '%.mp3' OR lower(n.name) LIKE '%.flac' OR lower(n.name) LIKE '%.ogg' OR lower(n.name) LIKE '%.opus' OR lower(n.name) LIKE '%.m4a' OR lower(n.name) LIKE '%.m4b' OR lower(n.name) LIKE '%.mp4' OR lower(n.name) LIKE '%.wav') ORDER BY n.updated_at,n.id LIMIT ?2",
  )
    .bind(audioGeneratorVersion, limit)
    .all<{ id: string }>();
  for (const row of rows.results) await enqueueAudioJob(env, row.id, () => Promise.resolve());
  return rows.results.length;
}

export async function dispatchPendingAudioJobs(env: Env, limit = 100): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id FROM audio_jobs WHERE state='pending' ORDER BY created_at,id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.JOBS.send({ kind: "audio-extract", jobId: row.id } satisfies AudioJobMessage);
  }
  return rows.results.length;
}

export async function processAudioJob(env: Env, jobId: string): Promise<void> {
  const job = await claimAudioJob(env, jobId);
  if (job === null) {
    const terminal = await env.DB.prepare("SELECT state,attempt FROM audio_jobs WHERE id=?1")
      .bind(jobId)
      .first<{ state: string; attempt: number }>();
    if (
      terminal?.state === "completed" ||
      (terminal?.state === "failed" && terminal.attempt >= 3)
    ) {
      return;
    }
    throw new Error("audio_job_not_claimed");
  }
  let coverKey: string | null = null;
  try {
    if (!(await isEffectiveLive(env, job.nodeId, job.rootId))) throw new Error("node_not_found");
    const headLength = Math.min(job.size, audioLimits.headBytes);
    const head = await range(env, job.r2Key, job.size, 0, headLength);
    const tailLength = Math.min(job.size, audioLimits.tailBytes);
    const tail = await range(env, job.r2Key, job.size, job.size - tailLength, tailLength);
    let mp4Window = moov(head);
    if (mp4Window === undefined && /\.(?:m4a|m4b|mp4)$/iu.test(job.name)) {
      const length = Math.min(job.size, audioLimits.mp4WindowBytes);
      const window = await range(env, job.r2Key, job.size, job.size - length, length);
      mp4Window = moov(window);
    }
    const metadata = parseAudioMetadata({
      name: job.name,
      size: job.size,
      head,
      tail,
      ...(mp4Window === undefined ? {} : { mp4Window }),
    });
    coverKey = await coverDerivative(env, job, metadata.cover);
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM audio_jobs j JOIN nodes n ON n.id=j.node_id JOIN users u ON u.id=j.owner_id JOIN control c ON c.singleton=1 WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND j.epoch=c.epoch AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND u.disabled_at IS NULL)",
        ).bind(job.id, job.claimToken),
        env.DB.prepare(
          "INSERT INTO node_audio(node_id,blob_id,generator_version,title,artist,album,duration_ms,codec,override_json,track_no,disc_no,bitrate,cover_key,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',?9,?10,?11,?12,?13) ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,generator_version=excluded.generator_version,title=excluded.title,artist=excluded.artist,album=excluded.album,duration_ms=excluded.duration_ms,codec=excluded.codec,track_no=excluded.track_no,disc_no=excluded.disc_no,bitrate=excluded.bitrate,cover_key=excluded.cover_key,updated_at=excluded.updated_at",
        ).bind(
          job.nodeId,
          job.blobId,
          job.generatorVersion,
          metadata.title,
          metadata.artist,
          metadata.album,
          metadata.durationMs,
          metadata.codec,
          metadata.trackNo,
          metadata.discNo,
          metadata.bitrate,
          coverKey,
          now,
        ),
        env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
        env.DB.prepare(
          "UPDATE audio_jobs SET state='completed',claim_token=NULL,claim_expires_at=NULL,last_error=NULL,updated_at=?1 WHERE id=?2 AND state='claimed' AND claim_token=?3",
        ).bind(now, job.id, job.claimToken),
        env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
      ]);
    } catch (error) {
      if (coverKey !== null) await env.BLOBS.delete(coverKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await failAudioJob(env, job, error).catch(() => undefined);
    throw error;
  }
}
