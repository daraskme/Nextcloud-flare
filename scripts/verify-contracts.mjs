import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { OPERATIONS } from "../packages/shared/src/contracts.ts";
import { LIMITS } from "../packages/shared/src/limits.ts";
import { ROUTES } from "../packages/worker/src/routes/manifest.ts";
import { routeContracts } from "./route-contract-source.mjs";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const toolchain = await readJson("docs/toolchain.json");
const manifests = [
  "package.json",
  "packages/worker/package.json",
  "packages/web/package.json",
  "packages/shared/package.json",
];
for (const path of manifests) {
  const pkg = await readJson(path);
  assert.equal(pkg.private, true, `${path}: package must be private`);
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (version === "workspace:*") continue;
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: exact version required`);
    const record = toolchain.versions[name];
    assert.equal(record?.version, version, `${name}: missing version evidence`);
    assert.ok(
      Date.parse(record.publishedAt) <= Date.parse(toolchain.cutoff),
      `${name}: release too new`,
    );
  }
}
const pkg = await readJson("package.json");
assert.equal(pkg.engines.node, toolchain.versions.node.version);
assert.equal(pkg.packageManager, `pnpm@${toolchain.versions.pnpm.version}`);
assert.equal((await readFile(new URL(".node-version", root), "utf8")).trim(), pkg.engines.node);
assert.equal(LIMITS.d1Bindings, 100);
assert.equal(LIMITS.requestBytes, 95_000_000);
assert.equal(LIMITS.zipBytes, 4_294_967_295);
assert.equal(LIMITS.imageBytes, 20_000_000);
assert.equal(LIMITS.pbkdf2Iterations, 100_000);

for (const file of await readdir(new URL("packages/worker/src/", root), { recursive: true })) {
  if (!file.endsWith(".ts")) continue;
  const source = await readFile(
    new URL(`packages/worker/src/${file.replaceAll("\\", "/")}`, root),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:ZipDeflate|AsyncZipDeflate|AsyncZipInflate|unzipSync|hash-wasm)\b/,
    file,
  );
  assert.doesNotMatch(source, /\.tee\s*\(/, `${file}: unbounded stream fork`);
}
const design = await readFile(new URL("docs/DESIGN.md", root), "utf8");
assert.deepEqual(
  ROUTES,
  routeContracts(design),
  "Route manifest drift: regenerate after reviewing DESIGN/brief changes",
);
const keys = new Set();
for (const route of ROUTES) {
  assert.ok(Object.hasOwn(OPERATIONS, route.operation), `Unknown operation: ${route.operation}`);
  const key = `${route.host} ${route.method} ${route.template}`;
  assert.ok(!keys.has(key), `Duplicate route: ${key}`);
  keys.add(key);
  if (route.auth.includes("service")) assert.equal(route.method, "GET", "Automation is read-only");
  assert.ok(!route.operation.includes("client_thumb"));
}
console.log("Toolchain, limits, route/operation contracts and forbidden stream APIs verified.");
