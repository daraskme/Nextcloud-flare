import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDryRunReport,
  buildProbePlan,
  runHttpProbes,
  validateStaticContracts,
} from "./smoke-check.mjs";

const appOrigin = "https://staging-app.darask.date";
const contentOrigin = "https://staging-content.darask.date";

test("static contracts match staging hosts, asset manifests, and private host-wide Access scope", async () => {
  const checks = await validateStaticContracts();
  assert.equal(checks.workerDevDisabled, true);
  assert.equal(checks.previewUrlsDisabled, true);
  assert.equal(checks.stagingHostsExact, true);
  assert.match(checks.privateAsset, /^\/private-assets\//);
  assert.match(checks.publicAsset, /^\/public-assets\//);
});

test("default dry-run report does not send network requests", async () => {
  const report = await buildDryRunReport();
  assert.equal(report.mode, "dry-run");
  assert.equal(report.networkSent, false);
  assert.equal(report.plannedRequests.length, 9);
  assert.ok(report.manualGates.some((gate) => gate.includes("two allowed identities")));
});

test("probe plan stays bounded, read-only, and targets only the two staging origins", () => {
  const probes = buildProbePlan();
  assert.equal(probes.length, 9);
  assert.ok(probes.every(({ method }) => method === "GET" || method === "HEAD"));
  assert.ok(probes.every(({ url }) => url.startsWith(appOrigin) || url.startsWith(contentOrigin)));
  assert.ok(
    probes.some(({ name, url }) => name === "private-bundle" && /\/private-assets\//.test(url)),
  );
  assert.ok(
    probes.some(({ name, url }) => name === "public-asset" && /\/public-assets\//.test(url)),
  );
});

function fakeFetchForHealthyBoundary(calls) {
  return async (input, options) => {
    const url = new URL(input);
    calls.push({ url: url.href, ...options });
    if (
      url.origin === appOrigin &&
      (url.pathname === "/" ||
        url.pathname.startsWith("/private-assets/") ||
        url.pathname === "/_ncf-smoke-unknown")
    ) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/cdn-cgi/access/login/staging-app.darask.date" },
      });
    }
    if (url.pathname === "/s" || url.pathname.startsWith("/public-assets/"))
      return new Response(null, { status: 200 });
    if (url.pathname.startsWith("/api/v1/public/shares/"))
      return new Response(null, {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      });
    if (url.pathname === "/dav")
      return new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="DAV"' },
      });
    if (url.pathname.startsWith("/c/") || url.pathname === "/_ncf-smoke-unknown")
      return new Response(null, {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      });
    throw new Error(`unexpected_probe:${url.pathname}`);
  };
}

test("live probe runner sends only bounded unauthenticated GET/HEAD and retains no content", async () => {
  const calls = [];
  const report = await runHttpProbes({
    appOrigin,
    contentOrigin,
    fetchImpl: fakeFetchForHealthyBoundary(calls),
  });
  assert.equal(report.passed, true);
  assert.equal(report.requestCount, 9);
  assert.equal(calls.length, 9);
  for (const call of calls) {
    assert.ok(["GET", "HEAD"].includes(call.method));
    assert.equal(call.redirect, "manual");
    assert.equal(call.body, undefined);
    assert.equal(call.headers, undefined);
    assert.ok(call.signal);
  }
});

test("runner refuses to send requests to arbitrary origins", async () => {
  let sent = false;
  await assert.rejects(
    runHttpProbes({
      appOrigin: "https://example.invalid",
      contentOrigin,
      fetchImpl: async () => {
        sent = true;
        throw new Error("must_not_send");
      },
    }),
    /staging_target_required/,
  );
  assert.equal(sent, false);
});

test("runner fails if private root or bundle reaches only Worker denial", async () => {
  const report = await runHttpProbes({
    appOrigin,
    contentOrigin,
    fetchImpl: async (input) =>
      new URL(input).pathname === "/" || new URL(input).pathname.startsWith("/private-assets/")
        ? new Response(null, { status: 401 })
        : fakeFetchForHealthyBoundary([])(input, { method: "GET" }),
  });
  assert.equal(report.passed, false);
  assert.equal(
    report.results.find((item) => item.name === "private-bundle")?.outcome,
    "worker_only_denial",
  );
});

test("runner fails when an unknown app path is not intercepted by the host-wide Access app", async () => {
  const report = await runHttpProbes({
    appOrigin,
    contentOrigin,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === "/_ncf-smoke-unknown") return new Response(null, { status: 404 });
      return fakeFetchForHealthyBoundary([])(input, options);
    },
  });
  assert.equal(report.passed, false);
  assert.equal(
    report.results.find((item) => item.name === "app-unknown-path")?.outcome,
    "bypass_or_uncovered_path",
  );
});

test("runner does not treat an arbitrary external redirect as proof of Access", async () => {
  const report = await runHttpProbes({
    appOrigin,
    contentOrigin,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.origin === appOrigin && ["/", "/_ncf-smoke-unknown"].includes(url.pathname))
        return new Response(null, {
          status: 302,
          headers: { Location: "https://idp.example.invalid/login" },
        });
      return fakeFetchForHealthyBoundary([])(input, options);
    },
  });
  assert.equal(report.passed, false);
  assert.equal(
    report.results.find((item) => item.name === "private-app-entry")?.outcome,
    "unexpected_response",
  );
});

test("runner does not accept an ambiguous Access/Worker 403 for content", async () => {
  const report = await runHttpProbes({
    appOrigin,
    contentOrigin,
    fetchImpl: async (input, options) =>
      new URL(input).pathname.startsWith("/c/")
        ? new Response(null, { status: 403, headers: { "Content-Type": "text/html" } })
        : fakeFetchForHealthyBoundary([])(input, options),
  });
  assert.equal(report.passed, false);
  assert.equal(
    report.results.find((item) => item.name === "content-no-session")?.outcome,
    "access_or_worker_403",
  );
});
