import type {
  ClientMediaMessage,
  ClientMediaMessageResult,
  ClientMediaRegistration,
} from "./clientMediaServiceWorker";

const WORKER_PATH = "/public-assets/client-media-worker.js";
let preparation: Promise<void> | undefined;

/** Check for updates once per document and wait for that worker to claim this window. */
export function ensureClientMediaWorker(): Promise<void> {
  preparation ??= prepareClientMediaWorker().catch((error) => {
    preparation = undefined;
    throw error;
  });
  return preparation;
}

async function prepareClientMediaWorker(): Promise<void> {
  if (!navigator.serviceWorker) throw new Error("client_media_worker_unavailable");
  const script = new URL(WORKER_PATH, location.origin);
  if (script.origin !== location.origin || script.pathname !== WORKER_PATH)
    throw new Error("client_media_worker_invalid_asset");
  const registration = await navigator.serviceWorker.register(script.href, {
    scope: "/",
    type: "module",
    updateViaCache: "none",
  });
  await registration.update();
  const target = registration.installing ?? registration.waiting ?? registration.active;
  if (!target) throw new Error("client_media_worker_unavailable");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      target.removeEventListener("statechange", changed);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("client_media_worker_unavailable")), 30_000);
    const changed = () => {
      if (target.state === "redundant") return finish(new Error("client_media_worker_unavailable"));
      if (target.state === "installed") target.postMessage({ kind: "ncf-client-media-activate" });
      if (target.state === "activated" && navigator.serviceWorker.controller === target) finish();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    target.addEventListener("statechange", changed);
    changed();
  });
}

function controller(): ServiceWorker {
  const found = navigator.serviceWorker?.controller;
  if (!found) throw new Error("client_media_worker_unavailable");
  return found;
}

function exchange(message: ClientMediaMessage): Promise<ClientMediaMessageResult> {
  const worker = controller();
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("client_media_worker_timeout"));
    }, 30_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      const value = event.data;
      if (
        !value ||
        typeof value !== "object" ||
        !("ok" in value) ||
        typeof value.ok !== "boolean"
      ) {
        reject(new Error("client_media_worker_invalid_reply"));
        return;
      }
      resolve(value as ClientMediaMessageResult);
    };
    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      clearTimeout(timer);
      channel.port1.close();
      reject(error);
    }
  });
}

/** The caller keeps the nonextractable cipher in memory and supplies a pinned content ETag. */
export async function registerClientMedia(input: ClientMediaRegistration): Promise<string> {
  await ensureClientMediaWorker();
  const result = await exchange({ kind: "ncf-client-media-register", input });
  if (
    !result.ok ||
    typeof result.url !== "string" ||
    !/^https?:\/\/[^/]+\/__client_media\/[a-f0-9]{64}$/.test(result.url)
  )
    throw new Error("client_media_registration_rejected");
  return result.url;
}

export async function clearClientMedia(): Promise<void> {
  const result = await exchange({ kind: "ncf-client-media-clear" });
  if (!result.ok) throw new Error("client_media_clear_failed");
}

export async function revokeClientMedia(url: string): Promise<void> {
  const result = await exchange({ kind: "ncf-client-media-revoke", url });
  if (!result.ok) throw new Error("client_media_revoke_failed");
}

/** Renew the existing virtual URL after obtaining a fresh content ticket for the same blob. */
export async function renewClientMedia(url: string, expiresAt: number): Promise<void> {
  const result = await exchange({ kind: "ncf-client-media-renew", url, expiresAt });
  if (!result.ok) throw new Error("client_media_renew_failed");
}

/** Call from logout/account switching. Pagehide cleanup is best effort; client-ID and TTL checks still apply. */
export function installClientMediaPagehideCleanup(): () => void {
  const clear = () => {
    void clearClientMedia().catch(() => undefined);
  };
  window.addEventListener("pagehide", clear);
  return () => window.removeEventListener("pagehide", clear);
}

export interface ClientMediaWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Stream a download from the same controlled window; navigation lacks a reliable client ID. */
export async function saveClientMedia(
  url: string,
  expectedBytes: number,
  destination: ClientMediaWritable,
): Promise<void> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
    throw new Error("invalid_download_size");
  let received = 0;
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (
      response.status !== 200 ||
      response.headers.get("Content-Length") !== String(expectedBytes) ||
      response.headers.get("Cache-Control") !== "no-store" ||
      !response.body
    )
      throw new Error("client_media_download_failed");
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.length;
        if (received > expectedBytes) throw new Error("client_media_download_overflow");
        await destination.write(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (received !== expectedBytes) throw new Error("client_media_download_truncated");
    await destination.close();
  } catch (error) {
    await destination.abort(error).catch(() => undefined);
    throw error;
  }
}
