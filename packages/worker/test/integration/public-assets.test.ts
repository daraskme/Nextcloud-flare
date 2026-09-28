import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { publicAssetRoute, servePublicApp } from "../../src/assets/publicApp";
import { publicManifest } from "../../src/assets/publicManifest";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const app = {
  ...env,
  APP_ORIGIN: "https://app.invalid",
  CONTENT_ORIGIN: "https://content.invalid",
};
it.each(["https://content.invalid", "https://app.invalid"])(
  "serves exact public assets without Access or content keys with content origin %s",
  async (contentOrigin) => {
    const layout = { ...app, CONTENT_ORIGIN: contentOrigin };
    for (const path of ["/s/unknown-share", ...publicManifest.assets.map((a) => a.path)]) {
      const response = await worker.fetch(new Request(`${app.APP_ORIGIN}${path}`), layout);
      expect(response.status).toBe(200);
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
      if (path.startsWith("/s/")) {
        const html = await response.text();
        expect(html).not.toContain("private-assets");
        for (const record of publicManifest.assets) {
          expect(record.auth).toBe("public");
          expect(html).toContain(`integrity="${record.integrity}"`);
        }
        expect(html.match(/crossorigin="anonymous"/g)).toHaveLength(2);
      } else await response.arrayBuffer();
      const head = await worker.fetch(
        new Request(`${app.APP_ORIGIN}${path}`, { method: "HEAD" }),
        layout,
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    for (const path of [
      "/public.html",
      "/public-assets/unknown.js",
      "/private-assets/unknown.js",
      "/s/a/b",
      "/s/a/",
    ])
      expect(publicAssetRoute(new Request(`${app.APP_ORIGIN}${path}`))).toBe(false);
    expect((await servePublicApp(new Request(`${app.APP_ORIGIN}/s/a?secret=x`), app)).status).toBe(
      404,
    );
  },
);
it.each(["altered", "missing", "oversized"])("withholds %s public bytes", async (kind) => {
  const assets = {
    fetch: async () =>
      new Response(
        kind === "oversized"
          ? "x".repeat(524289)
          : "altered".padEnd(publicManifest.page.bytes, " "),
        {
          status: kind === "missing" ? 404 : 200,
        },
      ),
  } as unknown as Env["ASSETS"];
  const response = await servePublicApp(new Request(`${app.APP_ORIGIN}/s/a`), {
    ...app,
    ASSETS: assets,
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("altered");
});
