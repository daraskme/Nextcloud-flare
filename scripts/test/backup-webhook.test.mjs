import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { sendStdoutEvent, sendWebhookEvent, validateWebhookUrl } from "../backup/webhookSink.mjs";

const event = {
  version: 1,
  kind: "backup.unhealthy",
  eventId: "backup-monitor-v1-test",
  observedAt: 1,
  status: {
    version: 1,
    command: "maintain",
    state: "unhealthy",
    codes: ["backup_generations_insufficient"],
  },
  summary: {
    complete: true,
    eligible: 1,
    missing: 4,
    scanned: 1,
    verified: 1,
    cleanupComplete: null,
    cleanupHealthy: null,
  },
};

async function server(handler) {
  const app = createServer(handler);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  return {
    url: `http://127.0.0.1:${app.address().port}`,
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

it("accepts loopback 2xx JSON delivery and sends no endpoint in the payload", async () => {
  let body = "";
  const app = await server((request, response) => {
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.end("ok");
    });
  });
  try {
    await sendWebhookEvent({ event, endpoint: app.url });
    expect(JSON.parse(body)).toMatchObject({ eventId: event.eventId });
    expect(body).not.toContain(app.url);
  } finally {
    await app.close();
  }
});

it("rejects non-HTTPS external endpoints before connecting", () => {
  expect(() => validateWebhookUrl("http://example.invalid/hook")).toThrow(
    "backup_webhook_insecure_endpoint",
  );
});

it.each([
  ["redirect", (response) => response.writeHead(302, { location: "/other" }).end("secret")],
  ["non-2xx", (response) => response.writeHead(500).end("provider secret")],
  ["oversized response", (response) => response.end("x".repeat(5000))],
])("rejects %s responses without exposing response content", async (_name, respond) => {
  const app = await server((_request, response) => respond(response));
  try {
    await expect(sendWebhookEvent({ event, endpoint: app.url })).rejects.toThrow(
      /^backup_webhook_/,
    );
  } finally {
    await app.close();
  }
});

it("rejects timeout without logging endpoint or response content", async () => {
  const app = await server(() => {});
  try {
    await expect(sendWebhookEvent({ event, endpoint: app.url, timeoutMs: 10 })).rejects.toThrow(
      "backup_webhook_timeout",
    );
  } finally {
    await app.close();
  }
});

it("prints dry-run events only to the provided stdout sink", async () => {
  let output = "";
  await sendStdoutEvent(event, { write: (chunk) => (output += chunk) });
  expect(JSON.parse(output)).toMatchObject({ sink: "stdout", event: { eventId: event.eventId } });
  expect(output).not.toMatch(/https?:\/\//);
});
