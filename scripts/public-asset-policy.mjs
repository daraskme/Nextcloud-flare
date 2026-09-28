import assert from "node:assert/strict";

/** A public build can contain its own source and the pinned rendering runtime only. */
export function assertPublicModule(id, root) {
  const normalized = id.replaceAll("\\", "/"),
    base = root.replaceAll("\\", "/").replace(/\/$/, "");
  if (
    [
      "\0vite/modulepreload-polyfill.js",
      "\0vite/preload-helper.js",
      "\0commonjsHelpers.js",
    ].includes(normalized)
  )
    return;
  const file = normalized.replace(/^\0/, "").split("?")[0];
  assert.ok(
    file === `${base}/public.html` ||
      file?.startsWith(`${base}/src/public-share/`) ||
      /\/node_modules\/(react|react-dom|scheduler)\//.test(file ?? ""),
    `forbidden public module: ${id}`,
  );
}
export function assertPublicSource(source) {
  for (const forbidden of [
    "dangerouslySetInnerHTML",
    "Cf-Access-Jwt-Assertion",
    "__test__",
    "ACCESS_ISSUER",
    "CSRF_PRIVATE",
    "APP_PASSWORD_PEPPERS",
    "serviceWorker",
    "import.meta.env",
  ])
    assert.ok(!source.includes(forbidden), `forbidden public source: ${forbidden}`);
}
