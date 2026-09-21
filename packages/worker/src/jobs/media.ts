import type { Env } from "../env.js";
import { assertImageInputSize } from "../media/images/limits.js";
import { extractExif } from "../media/images/exif.js";
import type { ImageVariant } from "../media/images/derivatives.js";
import { galleryGeneratorVersion } from "../services/gallery.js";
import { isEffectiveLive } from "../services/effectiveLive.js";

export interface MediaJobMessage {
  kind: "media-extract";
  jobId: string;
}

interface MediaJobRow {
  id: string;
  nodeId: string;
  blobId: string;
  ownerId: string;
  variant: "metadata" | "lg1600";
  generatorVersion: string;
  epoch: number;
  state: "pending" | "claimed" | "completed" | "failed";
  attempt: number;
  claimToken: string | null;
  rootId: string;
  r2Key: string;
  size: number;
  mime: string;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const body = new Response(bytes).body;
  if (body === null) throw new Error("image_stream_unavailable");
  return body;
}

export async function enqueueMediaJob(
  env: Env,
  nodeId: string,
  variant: "metadata" | "lg1600" = "metadata",
  send: (message: MediaJobMessage) => Promise<void> = async (message) => {
    await env.JOBS.send(message);
  },
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT n.id nodeId,n.owner_id ownerId,n.current_blob_id blobId,b.size,COALESCE(b.mime_sniffed,'') mime FROM nodes n JOIN blobs b ON b.id=n.current_blob_id WHERE n.id=?1 AND n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND lower(COALESCE(b.mime_sniffed,'')) LIKE 'image/%' AND lower(COALESCE(b.mime_sniffed,''))<>'image/svg+xml'",
  )
    .bind(nodeId)
    .first<{ nodeId: string; ownerId: string; blobId: string; size: number; mime: string }>();
  if (row === null) return null;
  const control = await env.DB.prepare("SELECT epoch FROM control WHERE singleton=1").first<{
    epoch: number;
  }>();
  if (control === null) throw new Error("control_unavailable");
  const now = Date.now();
  const jobId = randomId("media");
  await env.DB.prepare(
    "INSERT INTO media_jobs(id,node_id,blob_id,owner_id,variant,generator_version,saved_principal_json,epoch,state,attempt,claim_token,claim_expires_at,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,NULL,NULL,NULL,?9,?9) ON CONFLICT(node_id,blob_id,variant,generator_version) DO NOTHING",
  )
    .bind(
      jobId,
      row.nodeId,
      row.blobId,
      row.ownerId,
      variant,
      galleryGeneratorVersion,
      JSON.stringify({ kind: "system", systemKind: "media", ownerId: row.ownerId }),
      control.epoch,
      now,
    )
    .run();
  const job = await env.DB.prepare(
    "SELECT id,state,attempt FROM media_jobs WHERE node_id=?1 AND blob_id=?2 AND variant=?3 AND generator_version=?4",
  )
    .bind(row.nodeId, row.blobId, variant, galleryGeneratorVersion)
    .first<{ id: string; state: string; attempt: number }>();
  if (job === null || job.state === "completed" || job.attempt >= 3) return job?.id ?? null;
  await send({ kind: "media-extract", jobId: job.id });
  return job.id;
}

export async function discoverMediaJobs(env: Env, limit = 100): Promise<number> {
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") return 0;
  const rows = await env.DB.prepare(
    "SELECT n.id FROM nodes n JOIN blobs b ON b.id=n.current_blob_id LEFT JOIN node_media m ON m.node_id=n.id AND m.blob_id=n.current_blob_id AND m.generator_version=?1 WHERE n.kind='file' AND n.deleted_at IS NULL AND b.state='committed' AND b.size<=20000000 AND lower(COALESCE(b.mime_sniffed,'')) LIKE 'image/%' AND lower(COALESCE(b.mime_sniffed,''))<>'image/svg+xml' AND m.node_id IS NULL ORDER BY n.updated_at,n.id LIMIT ?2",
  )
    .bind(galleryGeneratorVersion, limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await enqueueMediaJob(env, row.id, "metadata", () => Promise.resolve());
  }
  return rows.results.length;
}

export async function dispatchPendingMediaJobs(env: Env, limit = 100): Promise<number> {
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") return 0;
  const rows = await env.DB.prepare(
    "SELECT id FROM media_jobs WHERE state='pending' ORDER BY created_at,id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const row of rows.results) {
    await env.JOBS.send({ kind: "media-extract", jobId: row.id } satisfies MediaJobMessage);
  }
  return rows.results.length;
}

async function claimMediaJob(env: Env, jobId: string): Promise<MediaJobRow | null> {
  const token = randomId("claim");
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE media_jobs SET state='claimed',attempt=attempt+1,claim_token=?1,claim_expires_at=?2,last_error=NULL,updated_at=?3 WHERE id=?4 AND (state='pending' OR state='failed' OR (state='claimed' AND claim_expires_at<=?3)) AND attempt<3 AND epoch=(SELECT epoch FROM control WHERE singleton=1) AND EXISTS(SELECT 1 FROM users WHERE id=media_jobs.owner_id AND disabled_at IS NULL) AND EXISTS(SELECT 1 FROM nodes WHERE id=media_jobs.node_id AND owner_id=media_jobs.owner_id AND current_blob_id=media_jobs.blob_id AND deleted_at IS NULL)",
  )
    .bind(token, now + 30_000, now, jobId)
    .run();
  return env.DB.prepare(
    "SELECT j.id,j.node_id nodeId,j.blob_id blobId,j.owner_id ownerId,j.variant,j.generator_version generatorVersion,j.epoch,j.state,j.attempt,j.claim_token claimToken,s.root_node_id rootId,b.r2_key r2Key,b.size,COALESCE(b.mime_sniffed,'application/octet-stream') mime FROM media_jobs j JOIN nodes n ON n.id=j.node_id JOIN spaces s ON s.id=n.space_id JOIN blobs b ON b.id=j.blob_id WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND b.state='committed'",
  )
    .bind(jobId, token)
    .first<MediaJobRow>();
}

async function claimDerivative(
  env: Env,
  job: MediaJobRow,
  variant: ImageVariant,
): Promise<{ token: string; published: boolean }> {
  const existing = await env.DB.prepare(
    "SELECT state FROM derivative_results WHERE kind='image-thumbnail' AND blob_id=?1 AND variant=?2 AND generator_version=?3",
  )
    .bind(job.blobId, variant, job.generatorVersion)
    .first<{ state: string }>();
  if (existing?.state === "published") return { token: "", published: true };
  const token = randomId("derivative");
  await env.DB.prepare(
    "INSERT INTO derivative_results(kind,blob_id,variant,generator_version,claim_token,r2_key,state) VALUES('image-thumbnail',?1,?2,?3,?4,NULL,'claimed') ON CONFLICT(kind,blob_id,variant,generator_version) DO UPDATE SET claim_token=excluded.claim_token,r2_key=NULL,state='claimed' WHERE derivative_results.state<>'published'",
  )
    .bind(job.blobId, variant, job.generatorVersion, token)
    .run();
  const claimed = await env.DB.prepare(
    "SELECT claim_token token,state FROM derivative_results WHERE kind='image-thumbnail' AND blob_id=?1 AND variant=?2 AND generator_version=?3",
  )
    .bind(job.blobId, variant, job.generatorVersion)
    .first<{ token: string; state: string }>();
  return { token, published: claimed?.state === "published" || claimed?.token !== token };
}

const widths: Record<ImageVariant, number> = { sm256: 256, md768: 768, lg1600: 1600 };

async function generateDerivative(
  env: Env,
  job: MediaJobRow,
  bytes: Uint8Array,
  variant: ImageVariant,
): Promise<void> {
  const claim = await claimDerivative(env, job, variant);
  if (claim.published) return;
  const result = await env.IMAGES.input(bytesStream(bytes))
    .transform({ width: widths[variant], fit: "scale-down" })
    .output({ format: "image/webp", quality: 82, anim: false });
  const output = await result.response().arrayBuffer();
  if (output.byteLength > 20_000_000) throw new Error("derivative_output_too_large");
  const key = `u/${job.ownerId}/d/${job.blobId}/${job.generatorVersion}/${variant}/${claim.token}.webp`;
  await env.BLOBS.put(key, output, { httpMetadata: { contentType: "image/webp" } });
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM media_jobs j JOIN nodes n ON n.id=j.node_id JOIN control c ON c.singleton=1 WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND j.epoch=c.epoch AND n.id=j.node_id AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL)",
      ).bind(job.id, job.claimToken),
      env.DB.prepare(
        "UPDATE derivative_results SET state='published',r2_key=?1 WHERE kind='image-thumbnail' AND blob_id=?2 AND variant=?3 AND generator_version=?4 AND state='claimed' AND claim_token=?5",
      ).bind(key, job.blobId, variant, job.generatorVersion, claim.token),
      env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    ]);
  } catch (error) {
    await env.BLOBS.delete(key).catch(() => undefined);
    throw error;
  }
}

async function completeMetadata(
  env: Env,
  job: MediaJobRow,
  metadata: {
    width: number;
    height: number;
    takenAt: number | null;
    orientation: number | null;
    cameraMake: string | null;
    cameraModel: string | null;
  },
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM media_jobs j JOIN nodes n ON n.id=j.node_id JOIN users u ON u.id=j.owner_id JOIN control c ON c.singleton=1 WHERE j.id=?1 AND j.state='claimed' AND j.claim_token=?2 AND j.epoch=c.epoch AND n.id=j.node_id AND n.owner_id=j.owner_id AND n.current_blob_id=j.blob_id AND n.deleted_at IS NULL AND u.disabled_at IS NULL)",
    ).bind(job.id, job.claimToken),
    env.DB.prepare(
      "INSERT INTO node_media(node_id,blob_id,generator_version,width,height,taken_at,duration_ms,orientation,dominant_color,camera_make,camera_model) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,NULL,?8,?9) ON CONFLICT(node_id) DO UPDATE SET blob_id=excluded.blob_id,generator_version=excluded.generator_version,width=excluded.width,height=excluded.height,taken_at=excluded.taken_at,duration_ms=NULL,orientation=excluded.orientation,dominant_color=NULL,camera_make=excluded.camera_make,camera_model=excluded.camera_model",
    ).bind(
      job.nodeId,
      job.blobId,
      job.generatorVersion,
      metadata.width,
      metadata.height,
      metadata.takenAt,
      metadata.orientation,
      metadata.cameraMake,
      metadata.cameraModel,
    ),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
    env.DB.prepare(
      "UPDATE media_jobs SET state='completed',claim_token=NULL,claim_expires_at=NULL,updated_at=?1 WHERE id=?2 AND state='claimed' AND claim_token=?3",
    ).bind(now, job.id, job.claimToken),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

async function completeDerivativeJob(env: Env, job: MediaJobRow): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM nodes n JOIN control c ON c.singleton=1 WHERE n.id=?1 AND n.current_blob_id=?2 AND n.deleted_at IS NULL AND c.epoch=?3)",
    ).bind(job.nodeId, job.blobId, job.epoch),
    env.DB.prepare(
      "UPDATE media_jobs SET state='completed',claim_token=NULL,claim_expires_at=NULL,updated_at=?1 WHERE id=?2 AND state='claimed' AND claim_token=?3",
    ).bind(Date.now(), job.id, job.claimToken),
    env.DB.prepare("INSERT INTO _assert(v) SELECT 1 WHERE changes()<>1"),
  ]);
}

async function failMediaJob(env: Env, job: MediaJobRow, error: unknown): Promise<void> {
  const code = error instanceof Error ? error.message.slice(0, 160) : "media_job_failed";
  await env.DB.prepare(
    "UPDATE media_jobs SET state='failed',claim_token=NULL,claim_expires_at=NULL,last_error=?1,updated_at=?2 WHERE id=?3 AND state='claimed' AND claim_token=?4",
  )
    .bind(code, Date.now(), job.id, job.claimToken)
    .run();
}

export async function processMediaJob(env: Env, jobId: string): Promise<void> {
  const job = await claimMediaJob(env, jobId);
  if (job === null) {
    const terminal = await env.DB.prepare("SELECT state,attempt FROM media_jobs WHERE id=?1")
      .bind(jobId)
      .first<{ state: string; attempt: number }>();
    if (
      terminal?.state === "completed" ||
      (terminal?.state === "failed" && terminal.attempt >= 3)
    ) {
      return;
    }
    throw new Error("media_job_not_claimed");
  }
  try {
    if (!(await isEffectiveLive(env, job.nodeId, job.rootId))) throw new Error("node_not_found");
    assertImageInputSize(job.size);
    const object = await env.BLOBS.get(job.r2Key);
    if (object === null || object.size !== job.size) throw new Error("media_source_missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (job.variant === "lg1600") {
      await generateDerivative(env, job, bytes, "lg1600");
      await completeDerivativeJob(env, job);
      return;
    }
    const info = await env.IMAGES.info(bytesStream(bytes));
    if (!("width" in info)) throw new Error("svg_media_forbidden");
    const { width, height } = info;
    if (
      width < 1 ||
      height < 1 ||
      width > 12_000 ||
      height > 12_000 ||
      width * height > 40_000_000
    ) {
      throw new Error("image_dimensions_invalid");
    }
    const exif = extractExif(bytes);
    await generateDerivative(env, job, bytes, "sm256");
    await generateDerivative(env, job, bytes, "md768");
    await completeMetadata(env, job, { width, height, ...exif });
  } catch (error) {
    await failMediaJob(env, job, error).catch(() => undefined);
    throw error;
  }
}
