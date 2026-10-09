import { ClientMediaWorker, privateMediaClient } from "./lib/clientMediaServiceWorker";

interface WindowClientLike {
  readonly id: string;
  readonly type: string;
  readonly url: string;
}
interface MediaWorkerScope {
  readonly location: Location;
  skipWaiting(): Promise<void>;
  readonly clients: {
    get(id: string): Promise<WindowClientLike | undefined>;
    claim(): Promise<void>;
  };
  addEventListener(
    type: "activate",
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: {
      readonly source: { readonly id?: string } | null;
      readonly data: unknown;
      readonly ports: readonly MessagePort[];
      waitUntil(promise: Promise<unknown>): void;
    }) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: {
      readonly request: Request;
      readonly clientId: string;
      respondWith(response: Promise<Response>): void;
    }) => void,
  ): void;
}

const scope = globalThis as unknown as MediaWorkerScope;
const accountEndpoint = `${scope.location.origin}/api/v1/me`;
let core: ClientMediaWorker | undefined;
let fixedContentOrigin: string | undefined;

async function account(): Promise<{ id: string; contentOrigin: string }> {
  const response = await fetch(accountEndpoint, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (response.status !== 200 || response.redirected || response.url !== accountEndpoint)
    throw new Error("client_media_account_unavailable");
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("contentOrigin" in value) ||
    typeof value.id !== "string" ||
    typeof value.contentOrigin !== "string"
  )
    throw new Error("client_media_account_unavailable");
  const origin = new URL(value.contentOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value.contentOrigin ||
    origin.origin === scope.location.origin
  )
    throw new Error("client_media_account_unavailable");
  return { id: value.id, contentOrigin: origin.origin };
}

async function mediaWorker(): Promise<ClientMediaWorker> {
  const current = await account();
  if (!core) {
    fixedContentOrigin = current.contentOrigin;
    core = new ClientMediaWorker({
      hostOrigin: scope.location.origin,
      contentOrigin: current.contentOrigin,
      lookupClient: async (id) => {
        const client = await scope.clients.get(id);
        return client?.type === "window" ? { url: client.url } : undefined;
      },
      lookupAccountId: async () => {
        const found = await account();
        return found.contentOrigin === fixedContentOrigin ? found.id : undefined;
      },
    });
  }
  if (current.contentOrigin !== fixedContentOrigin) throw new Error("client_media_origin_changed");
  return core;
}

scope.addEventListener("activate", (event) => {
  event.waitUntil(scope.clients.claim());
});
scope.addEventListener("message", (event) => {
  const port = event.ports[0];
  const id = event.source?.id;
  if (!id) return;
  if (
    event.data &&
    typeof event.data === "object" &&
    "kind" in event.data &&
    event.data.kind === "ncf-client-media-activate"
  ) {
    event.waitUntil(
      (async () => {
        const client = await scope.clients.get(id);
        if (client?.type === "window" && privateMediaClient(client.url, scope.location.origin))
          await scope.skipWaiting();
      })(),
    );
    return;
  }
  if (!port) return;
  event.waitUntil(
    (async () => {
      try {
        if (
          event.data &&
          typeof event.data === "object" &&
          "kind" in event.data &&
          event.data.kind === "ncf-client-media-clear"
        ) {
          core?.clear(id);
          port.postMessage({ ok: true });
          return;
        }
        port.postMessage(await (await mediaWorker()).handleMessage(id, event.data));
      } catch {
        port.postMessage({ ok: false });
      }
    })(),
  );
});
scope.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.location.origin || !url.pathname.startsWith("/__client_media/")) return;
  event.respondWith(
    (async () => {
      try {
        return await (await mediaWorker()).handleFetch(event.request, event.clientId);
      } catch {
        return new Response(null, {
          status: 404,
          headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
    })(),
  );
});
