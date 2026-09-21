import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { hasBindings, REQUIRED_BINDINGS } from "../../src/env";
import worker from "../../src/index";

it("provides every required local binding", () => {
  expect(hasBindings(env)).toBe(true);
  expect(env.ENVIRONMENT).toBe("development");
  for (const name of REQUIRED_BINDINGS)
    expect(hasBindings({ ...env, [name]: undefined })).toBe(false);
});

it.each(["/", "/s/x", "/api/v1/automation/unknown", "/public-assets/x.js", "/dav", "/c/x"])(
  "does not expose unimplemented surface %s or fall through to assets",
  async (path) => {
    const response = worker.fetch(new Request(`https://example.invalid${path}`), env);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  },
);

it("persists SQLite DO storage through eviction without issuing permits", async () => {
  const stub = env.CONTROL.get(env.CONTROL.idFromName("phase-0-binding-probe"));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("CREATE TABLE probe(value INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT INTO probe VALUES(7)");
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT value FROM probe").one().value).toBe(7);
  });
  expect((await stub.fetch("https://do.invalid/")).status).toBe(503);
});

it("does not ack unfinished queue work", () => {
  let retried = false;
  worker.queue({
    queue: "probe",
    messages: [],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll() {
      retried = true;
    },
    ackAll() {
      throw new Error("must not ack");
    },
  });
  expect(retried).toBe(true);
});

it("transforms a PNG with the local Images binding", async () => {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const result = await env.IMAGES.input(new Blob([bytes]).stream())
    .transform({ width: 1, height: 1 })
    .output({ format: "image/webp" });
  expect(result.contentType()).toBe("image/webp");
  expect((await result.response().arrayBuffer()).byteLength).toBeGreaterThan(0);
});
