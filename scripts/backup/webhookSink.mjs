import { isIP } from "node:net";
import { assertNoSensitiveText } from "./alertEvent.mjs";

export const MAX_WEBHOOK_REQUEST_BYTES = 64 * 1024;
export const MAX_WEBHOOK_RESPONSE_BYTES = 4096;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

function loopback(hostname) {
  const name = hostname.toLowerCase();
  if (name === "localhost") return true;
  const ip = isIP(name);
  return ip === 4
    ? name.startsWith("127.")
    : ip === 6 && (name === "::1" || name === "0:0:0:0:0:0:0:1");
}

export function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("backup_webhook_invalid_endpoint");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))
    throw new Error("backup_webhook_insecure_endpoint");
  if (url.username || url.password) throw new Error("backup_webhook_invalid_endpoint");
  return url;
}

async function readBoundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    bytes += value.byteLength;
    if (bytes > MAX_WEBHOOK_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("backup_webhook_response_too_large");
    }
  }
}

export async function sendStdoutEvent(event, output = process.stdout) {
  assertNoSensitiveText(event);
  output.write(`${JSON.stringify({ sink: "stdout", event })}\n`);
}

export async function sendWebhookEvent({
  event,
  endpoint,
  authorization,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  assertNoSensitiveText(event);
  const url = validateWebhookUrl(endpoint);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("backup_webhook_invalid_timeout");
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_REQUEST_BYTES)
    throw new Error("backup_webhook_request_too_large");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("backup_webhook_redirect_rejected");
    await readBoundedResponse(response);
    if (response.status < 200 || response.status > 299) throw new Error("backup_webhook_non_2xx");
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("backup_webhook_timeout");
    if (error instanceof Error && /^backup_webhook_/.test(error.message)) throw error;
    throw new Error("backup_webhook_delivery_failed");
  } finally {
    clearTimeout(timer);
  }
}
