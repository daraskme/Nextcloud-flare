import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { BINDING_PROBE_BYTES, BINDING_PROBE_KEY, isProbeNonce } from "./bindingProbe";
import {
  type MultipartMarker,
  multipartLifecycle,
  multipartPage,
  partPage,
} from "./s3InventoryPages";
import { MAX_S3_XML_BYTES, utf8 } from "./s3Xml";

export type InventoryConfigEnv = Pick<
  Env,
  | "R2_INVENTORY_ACCOUNT_ID"
  | "R2_INVENTORY_BUCKET"
  | "R2_INVENTORY_JURISDICTION"
  | "R2_INVENTORY_ACCESS_KEY_ID"
  | "R2_INVENTORY_SECRET_ACCESS_KEY"
>;
export interface InventorySource {
  accountId: string;
  bucket: string;
  jurisdiction: "default" | "eu" | "fedramp" | "us";
}
type Transport = (request: Request) => Promise<Response>;

function invalidRequest(): never {
  throw new Error("invalid_s3_inventory_request");
}
function boundedString(value: string, min: number, max: number): string {
  if (typeof value !== "string") invalidRequest();
  try {
    return utf8(value, min, max);
  } catch {
    return invalidRequest();
  }
}
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) invalidRequest();
  return value;
}
function prefix(value: string): string {
  if (!boundedString(value, 2, 1024).startsWith("u/")) invalidRequest();
  return value;
}

/** Read-only S3 transport. Credentials/endpoint never come from HTTP or a recovery RPC argument. */
export class R2S3Inventory {
  readonly #source: InventorySource;
  readonly #endpoint: string;
  readonly #signer: AwsClient;
  readonly #fetch: Transport;
  readonly #timeoutMs: number;

  constructor(env: InventoryConfigEnv, options: { fetch?: Transport; timeoutMs?: number } = {}) {
    const accountId = env.R2_INVENTORY_ACCOUNT_ID;
    const bucket = env.R2_INVENTORY_BUCKET;
    const jurisdiction = env.R2_INVENTORY_JURISDICTION ?? "default";
    const accessKeyId = env.R2_INVENTORY_ACCESS_KEY_ID;
    const secretAccessKey = env.R2_INVENTORY_SECRET_ACCESS_KEY;
    if (
      !accountId ||
      !/^[a-f\d]{32}$/.test(accountId) ||
      !bucket ||
      !/^[a-z\d][a-z\d-]{1,61}[a-z\d]$/.test(bucket) ||
      !["default", "eu", "fedramp", "us"].includes(jurisdiction) ||
      !accessKeyId ||
      !/^[A-Za-z\d_-]{16,128}$/.test(accessKeyId) ||
      !secretAccessKey ||
      !/^[A-Za-z\d+/=_-]{32,128}$/.test(secretAccessKey)
    )
      throw new Error("s3_inventory_unconfigured");
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 10_000)
      invalidRequest();
    this.#source = {
      accountId,
      bucket,
      jurisdiction: jurisdiction as InventorySource["jurisdiction"],
    };
    this.#endpoint = `https://${accountId}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com`;
    this.#signer = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 0,
    });
    this.#fetch = options.fetch ?? ((request) => fetch(request));
  }

  get source(): InventorySource {
    return { ...this.#source };
  }

  async #get(
    path: string,
    query: Record<string, string>,
    maxBytes = MAX_S3_XML_BYTES,
  ): Promise<string> {
    const url = new URL(`${this.#endpoint}/${this.#source.bucket}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new Error("s3_inventory_timeout"));
      }, this.#timeoutMs);
    });
    const request = async () => {
      // AwsClient.fetch has retry behavior; only sign and perform exactly one explicit fetch.
      const signed = await this.#signer.sign(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error("s3_inventory_timeout");
      const response = await this.#fetch(signed);
      if (controller.signal.aborted || response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        if (controller.signal.aborted) throw new Error("s3_inventory_timeout");
        throw new Error(`s3_inventory_http_${response.status}`);
      }
      const declared = response.headers.get("Content-Length");
      if (
        !response.body ||
        (declared !== null &&
          (!/^(?:0|[1-9]\d{0,6})$/.test(declared) || Number(declared) > maxBytes))
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error("s3_inventory_body_limit");
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (controller.signal.aborted) throw new Error("s3_inventory_timeout");
          if (next.done) break;
          length += next.value.byteLength;
          if (length > maxBytes) {
            void reader.cancel().catch(() => {});
            throw new Error("s3_inventory_body_limit");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
        reader = undefined;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        throw new Error("invalid_s3_inventory_xml");
      }
    };
    try {
      return await Promise.race([request(), timedOut]);
    } catch (error) {
      // Neither a signed request URL nor an upstream error body/message crosses this boundary.
      const code =
        error instanceof Error &&
        /^(?:s3_inventory_(?:http_\d{3}|timeout|body_limit)|invalid_s3_inventory_xml)$/.test(
          error.message,
        )
          ? error.message
          : "s3_inventory_unavailable";
      throw new Error(code);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fixed private protocol key only; this is not a general-purpose object reader. */
  async readBindingProbe(): Promise<string> {
    const nonce = await this.#get(`/${BINDING_PROBE_KEY}`, {}, BINDING_PROBE_BYTES);
    if (!isProbeNonce(nonce)) throw new Error("invalid_r2_binding_probe");
    return nonce;
  }

  async listMultipartUploads(
    options: { prefix?: string; limit?: number; marker?: MultipartMarker | null } = {},
  ) {
    const expected = {
      bucket: this.#source.bucket,
      prefix: prefix(options.prefix ?? "u/"),
      limit: limit(options.limit ?? 20),
      marker: options.marker ? { ...options.marker } : null,
    };
    const query: Record<string, string> = {
      uploads: "",
      "encoding-type": "url",
      prefix: expected.prefix,
      "max-uploads": String(expected.limit),
    };
    if (expected.marker) {
      const key = boundedString(expected.marker.key, 1, 1024);
      if (!key.startsWith(expected.prefix)) invalidRequest();
      query["key-marker"] = key;
      query["upload-id-marker"] = boundedString(expected.marker.uploadId, 1, 2048);
    }
    return multipartPage(await this.#get("", query), expected);
  }

  async listParts(options: { key: string; uploadId: string; limit?: number; marker?: number }) {
    const expected = {
      bucket: this.#source.bucket,
      key: prefix(options.key),
      uploadId: boundedString(options.uploadId, 1, 2048),
      limit: limit(options.limit ?? 20),
      marker: options.marker ?? 0,
    };
    if (
      !Number.isSafeInteger(expected.marker) ||
      expected.marker < 0 ||
      expected.marker >= 10000 ||
      expected.key.split("/").some((segment) => segment === "." || segment === "..")
    )
      invalidRequest();
    const path = `/${expected.key.split("/").map(encodeURIComponent).join("/")}`;
    return partPage(
      await this.#get(path, {
        uploadId: expected.uploadId,
        "max-parts": String(expected.limit),
        "part-number-marker": String(expected.marker),
      }),
      expected,
    );
  }

  async getMultipartLifecycle() {
    return multipartLifecycle(await this.#get("", { lifecycle: "" }), "u/");
  }
}
