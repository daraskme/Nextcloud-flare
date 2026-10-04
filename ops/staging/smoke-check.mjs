#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = new URL("../../", import.meta.url);
const APP_ORIGIN = "https://staging-app.darask.date";
const CONTENT_ORIGIN = "https://staging-content.darask.date";
const MAX_PROBES = 9;
const REQUEST_TIMEOUT_MS = 5_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function read(relativePath) {
  return readFileAsync(new URL(relativePath, root), "utf8");
}

function firstManifestAsset(relativePath, prefix) {
  const source = readFileSync(new URL(relativePath, root), "utf8");
  const path = source.match(new RegExp(`"(${prefix}[^\\"]+)"`))?.[1];
  assert(path, `asset_manifest_empty:${prefix}`);
  return path;
}

async function readConfig() {
  const path = `${directory}wrangler.staging.example.jsonc`;
  const text = readFileSync(path, "utf8");
  const parsed = ts.parseConfigFileTextToJson(path, text);
  if (parsed.error) throw new Error("staging_config_invalid");
  return parsed.config;
}

export async function validateStaticContracts() {
  const [config, accessDoc, designDoc, opsDoc, bindings, publicManifest, privateManifest] =
    await Promise.all([
      readConfig(),
      read("docs/STAGING_ACCESS.md"),
      read("docs/DESIGN.md"),
      read("ops/staging/README.md"),
      read("packages/worker/src/routes/bindings.ts"),
      read("packages/worker/src/assets/publicManifest.ts"),
      read("packages/worker/src/assets/privateManifest.ts"),
    ]);

  assert(config.workers_dev === false && config.preview_urls === false, "public_preview_enabled");
  assert(
    JSON.stringify(config.routes) ===
      JSON.stringify([
        { pattern: "staging-app.darask.date", custom_domain: true },
        { pattern: "staging-content.darask.date", custom_domain: true },
      ]),
    "unexpected_staging_hosts",
  );
  assert(
    config.vars?.APP_ORIGIN === APP_ORIGIN && config.vars?.CONTENT_ORIGIN === CONTENT_ORIGIN,
    "unexpected_staging_origins",
  );

  const accessScopes = [
    [accessDoc, "docs/STAGING_ACCESS.md"],
    [designDoc, "docs/DESIGN.md"],
    [opsDoc, "ops/staging/README.md"],
  ];
  for (const [source, name] of accessScopes) {
    assert(
      source.includes("/private-assets/*") || source.includes("/private-assets/:asset"),
      `private_asset_path_missing:${name}`,
    );
    assert(!/(^|[\s,(])\/assets\/\*/m.test(source), `stale_private_asset_path:${name}`);
  }
  assert(accessDoc.includes("staging-app.darask.date/*"), "app_host_wide_allow_missing");
  assert(
    !accessDoc.includes("`staging-app.darask.date` の private app (`/`"),
    "app_root_not_host_wide",
  );
  for (const path of [
    "/s",
    "/s/*",
    "/public-assets/*",
    "/api/v1/public/shares/*",
    "/dav",
    "/dav/*",
  ]) {
    assert(accessDoc.includes(path), `access_bypass_path_missing:${path}`);
  }
  assert(
    accessDoc.includes("staging-content.darask.date") && accessDoc.includes("Host を Bypass"),
    "content_host_bypass_missing",
  );
  assert(
    opsDoc.includes("workers_dev=false") && opsDoc.includes("preview_urls=false"),
    "ops_preview_gate_missing",
  );

  assert(bindings.includes('"app GET /private-assets/:asset"'), "private_asset_route_missing");
  assert(bindings.includes('"app GET /public-assets/:asset"'), "public_asset_route_missing");
  const privateAsset = privateManifest.match(/"(\/private-assets\/[^\"]+)"/)?.[1];
  const publicAsset = publicManifest.match(/"(\/public-assets\/[^\"]+)"/)?.[1];
  assert(privateAsset, "private_asset_manifest_empty");
  assert(publicAsset, "public_asset_manifest_empty");

  return {
    workerDevDisabled: true,
    previewUrlsDisabled: true,
    stagingHostsExact: true,
    privateAssetsMatchBuild: true,
    bypassScopesDocumented: true,
    contentHostBypassDocumented: true,
    privateAsset,
    publicAsset,
  };
}

export function buildProbePlan({ appOrigin = APP_ORIGIN, contentOrigin = CONTENT_ORIGIN } = {}) {
  const privateAsset = firstManifestAsset(
    "packages/worker/src/assets/privateManifest.ts",
    "/private-assets/",
  );
  const publicAsset = firstManifestAsset(
    "packages/worker/src/assets/publicManifest.ts",
    "/public-assets/",
  );
  return [
    {
      name: "private-app-entry",
      method: "GET",
      url: new URL("/", appOrigin).href,
      expectation: "Access login transition; no app body",
    },
    {
      name: "private-bundle",
      method: "HEAD",
      url: new URL(privateAsset, appOrigin).href,
      expectation: "Access login transition; no bundle without identity",
    },
    {
      name: "public-share-shell",
      method: "HEAD",
      url: new URL("/s", appOrigin).href,
      expectation: "200 without Access login",
    },
    {
      name: "public-asset",
      method: "HEAD",
      url: new URL(publicAsset, appOrigin).href,
      expectation: "200 without Access login; body not downloaded",
    },
    {
      name: "public-api-unknown-share",
      method: "GET",
      url: new URL("/api/v1/public/shares/ncf-smoke-no-share", appOrigin).href,
      expectation: "401 problem+json from Worker without a share session; no Access login",
    },
    {
      name: "dav-basic-challenge",
      method: "GET",
      url: new URL("/dav", appOrigin).href,
      expectation: "401 with Basic challenge; no Access login",
    },
    {
      name: "content-no-session",
      method: "GET",
      url: new URL("/c/ncf-smoke-no-node/ncf-smoke-no-blob", contentOrigin).href,
      expectation: "Worker problem+json 404; ambiguous 403 requires manual attribution",
    },
    {
      name: "content-unknown-path",
      method: "HEAD",
      url: new URL("/_ncf-smoke-unknown", contentOrigin).href,
      expectation: "404 from Worker; no Access login",
    },
    {
      name: "app-unknown-path",
      method: "HEAD",
      url: new URL("/_ncf-smoke-unknown", appOrigin).href,
      expectation: "Access login transition; root Allow covers unknown app paths",
    },
  ];
}

export async function buildDryRunReport() {
  return {
    mode: "dry-run",
    networkSent: false,
    staticChecks: await validateStaticContracts(),
    plannedRequests: buildProbePlan(),
    manualGates: [
      "Use two allowed identities in separate browser profiles; verify the invited member account and personal space for each.",
      "Use one identity outside the Allow policy and verify Access denies private app and bundle paths.",
      "Verify unknown host/preview/workers.dev are not alternate private app entry points.",
      "If Access redirects directly to an IdP, confirm its policy result in Access logs; a generic external redirect is not accepted as proof.",
      "Check current-month incremental cost and keep the first run to this bounded GET/HEAD set.",
    ],
  };
}

function isAccessTransition(response, requestUrl) {
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("Location");
  if (!location) return false;
  const destination = new URL(location, requestUrl);
  return (
    (destination.origin === new URL(requestUrl).origin &&
      destination.pathname.startsWith("/cdn-cgi/access/login")) ||
    destination.hostname === "cloudflareaccess.com" ||
    destination.hostname.endsWith(".cloudflareaccess.com")
  );
}

function isWorkerProblem(response) {
  return (response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("application/problem+json");
}

function result(name, response, passed, outcome) {
  return { name, status: response.status, passed, outcome };
}

async function cancelBody(response) {
  if (response.body) await response.body.cancel().catch(() => {});
}

export async function runHttpProbes({ appOrigin, contentOrigin, fetchImpl = fetch }) {
  assert(appOrigin === APP_ORIGIN && contentOrigin === CONTENT_ORIGIN, "staging_target_required");
  const probes = buildProbePlan({ appOrigin, contentOrigin });
  assert(probes.length <= MAX_PROBES, "probe_budget_exceeded");
  const results = [];

  for (const probe of probes) {
    let response;
    try {
      response = await fetchImpl(probe.url, {
        method: probe.method,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      results.push({ name: probe.name, status: null, passed: false, outcome: "request_failed" });
      continue;
    }

    let passed = false;
    let outcome = "unexpected_response";
    if (probe.name === "private-app-entry" || probe.name === "private-bundle") {
      passed = isAccessTransition(response, probe.url);
      outcome = passed ? "access_gate" : response.status === 401 ? "worker_only_denial" : outcome;
    } else if (probe.name === "public-share-shell" || probe.name === "public-asset") {
      passed = response.status === 200;
      outcome = passed ? "public_bypass" : outcome;
    } else if (probe.name === "public-api-unknown-share") {
      passed = response.status === 401 && isWorkerProblem(response);
      outcome = passed ? "worker_share_auth" : outcome;
    } else if (probe.name === "dav-basic-challenge") {
      passed =
        response.status === 401 &&
        /\bBasic\b/i.test(response.headers.get("WWW-Authenticate") ?? "");
      outcome = passed ? "worker_basic_auth" : outcome;
    } else if (probe.name === "content-no-session") {
      passed = response.status === 404 && isWorkerProblem(response);
      outcome = passed
        ? "worker_not_found_without_session"
        : response.status === 403
          ? "access_or_worker_403"
          : outcome;
    } else if (probe.name === "content-unknown-path") {
      passed = response.status === 404 && isWorkerProblem(response);
      outcome = passed ? "worker_not_found" : outcome;
    } else if (probe.name === "app-unknown-path") {
      passed = isAccessTransition(response, probe.url);
      outcome = passed
        ? "access_gate"
        : response.status === 404
          ? "bypass_or_uncovered_path"
          : outcome;
    }
    results.push(result(probe.name, response, passed, outcome));
    await cancelBody(response);
  }
  return {
    mode: "http-read-only",
    requestCount: probes.length,
    methods: [...new Set(probes.map(({ method }) => method))],
    results,
    passed: results.every(({ passed }) => passed),
    note: "No cookies, authorization headers, request bodies, retries, or response bodies are retained.",
  };
}

function parseArgs(args) {
  const options = { execute: false, appOrigin: undefined, contentOrigin: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--app-origin") options.appOrigin = args[++i];
    else if (arg === "--content-origin") options.contentOrigin = args[++i];
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown_option:${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node ops/staging/smoke-check.mjs [--execute --app-origin URL --content-origin URL]",
    );
    return;
  }
  if (!options.execute) {
    console.log(JSON.stringify(await buildDryRunReport(), null, 2));
    return;
  }
  await validateStaticContracts();
  assert(options.appOrigin && options.contentOrigin, "explicit_origins_required_for_execute");
  const result = await runHttpProbes(options);
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        requestCount: result.requestCount,
        results: result.results,
        passed: result.passed,
        note: result.note,
      },
      null,
      2,
    ),
  );
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "smoke_check_failed");
    process.exitCode = 1;
  });
}
