import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareClient, readLedger } from "./fault-provision.mjs";

const require = createRequire(new URL("../../packages/worker/package.json", import.meta.url));
const { AwsClient } = require("aws4fetch");
const PART_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function xmlTag(xml, name) {
  const hits = [...xml.matchAll(new RegExp(`<${name}>([^<]{1,1024})</${name}>`, "g"))];
  if (hits.length !== 1) throw new Error("fault_r2_xml_invalid");
  return hits[0][1];
}

async function boundedText(response) {
  const size = response.headers.get("Content-Length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_XML_BYTES))
    throw new Error("fault_r2_xml_oversize");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_XML_BYTES) throw new Error("fault_r2_xml_oversize");
  return new TextDecoder().decode(bytes);
}

async function s3Client(env, bucket) {
  const call = cloudflareClient(env);
  const verification = await call("/tokens/verify");
  if (!/^[a-f0-9]{32}$/.test(verification?.id ?? "")) throw new Error("fault_r2_token_unavailable");
  const signer = new AwsClient({
    accessKeyId: verification.id,
    secretAccessKey: digest(env.CLOUDFLARE_API_TOKEN),
    region: "auto",
    service: "s3",
    retries: 0,
  });
  const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/`;
  return async (method, key, query = "", body) => {
    if (!/^fault\/[0-9a-f-]{36}\/(?:complete|abort)$/.test(key))
      throw new Error("fault_r2_key_invalid");
    const headers =
      body === undefined
        ? {}
        : {
            "Content-Type":
              query.includes("uploadId=") && method === "POST"
                ? "application/xml"
                : "application/octet-stream",
            "Content-Length": String(body.length),
            "x-amz-content-sha256": digest(body),
          };
    let response;
    try {
      const signed = await signer.sign(endpoint + key + query, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      response = await fetch(signed);
    } catch {
      throw new Error("fault_r2_unavailable");
    }
    if (response.redirected || ![200, 204, 404].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`fault_r2_http_${response.status}`);
    }
    return response;
  };
}

/** Two-part complete plus separate abort on only this run's synthetic objects. */
export async function drillR2Multipart(ledgerPath, env = process.env) {
  const ledger = await readLedger(ledgerPath);
  if (!ledger.created.some((entry) => entry.kind === "blobs"))
    throw new Error("fault_r2_bucket_not_created");
  const request = await s3Client(env, ledger.names.blobs);
  const completeKey = `fault/${ledger.id}/complete`;
  const abortKey = `fault/${ledger.id}/abort`;
  const first = Buffer.alloc(PART_BYTES, 0x5a);
  const last = Buffer.from(`ncf-fault:${ledger.id}`, "utf8");
  const expected = digest(Buffer.concat([first, last]));
  const start = async (key) => {
    const response = await request("POST", key, "?uploads");
    if (response.status !== 200) throw new Error("fault_r2_initiate_failed");
    const id = xmlTag(await boundedText(response), "UploadId");
    if (!/^[A-Za-z0-9._~+\/=\-]{16,1024}$/.test(id)) throw new Error("fault_r2_upload_id_invalid");
    return id;
  };
  let completeUpload;
  let abortUpload;
  let objectExists = false;
  try {
    completeUpload = await start(completeKey);
    const part = async (number, bytes) => {
      const response = await request(
        "PUT",
        completeKey,
        `?partNumber=${number}&uploadId=${encodeURIComponent(completeUpload)}`,
        bytes,
      );
      if (response.status !== 200) throw new Error("fault_r2_part_failed");
      const etag = response.headers.get("ETag");
      void response.body?.cancel().catch(() => {});
      if (!/^"[A-Za-z0-9._-]{1,256}"$/.test(etag ?? "")) throw new Error("fault_r2_etag_invalid");
      return etag;
    };
    const etag1 = await part(1, first);
    const etag2 = await part(2, last);
    const xml = Buffer.from(
      `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`,
    );
    objectExists = true; // A lost completion response can still have published the object.
    const completed = await request(
      "POST",
      completeKey,
      `?uploadId=${encodeURIComponent(completeUpload)}`,
      xml,
    );
    if (
      completed.status !== 200 ||
      !/CompleteMultipartUploadResult/.test(await boundedText(completed))
    )
      throw new Error("fault_r2_complete_failed");
    completeUpload = undefined;
    const head = await request("HEAD", completeKey);
    if (
      head.status !== 200 ||
      Number(head.headers.get("Content-Length")) !== PART_BYTES + last.length
    )
      throw new Error("fault_r2_head_mismatch");
    const got = await request("GET", completeKey);
    if (got.status !== 200) throw new Error("fault_r2_get_failed");
    const bytes = new Uint8Array(await got.arrayBuffer());
    if (bytes.length !== PART_BYTES + last.length || digest(bytes) !== expected)
      throw new Error("fault_r2_digest_mismatch");
    abortUpload = await start(abortKey);
    const aborted = await request(
      "DELETE",
      abortKey,
      `?uploadId=${encodeURIComponent(abortUpload)}`,
    );
    if (aborted.status !== 204) throw new Error("fault_r2_abort_failed");
    abortUpload = undefined;
    const absent = await request("HEAD", abortKey);
    if (absent.status !== 404) throw new Error("fault_r2_abort_object_present");
    return { completedBytes: bytes.length, sha256: expected, aborted: true, cleaned: true };
  } finally {
    if (completeUpload)
      await request("DELETE", completeKey, `?uploadId=${encodeURIComponent(completeUpload)}`).catch(
        () => {},
      );
    if (abortUpload)
      await request("DELETE", abortKey, `?uploadId=${encodeURIComponent(abortUpload)}`).catch(
        () => {},
      );
    if (objectExists) {
      await request("DELETE", completeKey);
      if ((await request("HEAD", completeKey)).status !== 404)
        throw new Error("fault_r2_cleanup_unconfirmed");
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--execute")
      throw new Error("fault_invalid_action");
    const result = await drillR2Multipart(process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof Error && /^fault_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "fault_r2_unknown_failure";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
