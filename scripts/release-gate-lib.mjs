import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, posix, sep, win32 } from "node:path";

export const FORMAT = "nextcloud-flare.release-evidence";
export const MANIFEST_VERSION = 1;
export const EXPECTED_NODE = "24.21.0";
export const EXPECTED_PNPM = "12.4.1";

const remoteVerification = Object.freeze([
  { environment: "cloudflare-staging", status: "unverified" },
  { environment: "cloudflare-production", status: "unverified" },
]);

const command = (id, executable, args, timeoutMs, reports = []) =>
  Object.freeze({
    id,
    executable,
    args: Object.freeze(args),
    timeoutMs,
    reports: Object.freeze(reports),
  });

export function buildCommandPlan() {
  return [
    command(
      "frozen-lockfile",
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      600_000,
    ),
    command("repository-check", "pnpm", ["check"], 1_800_000),
    command("backup-drill", "pnpm", ["backup:drill"], 1_800_000, [
      ".wrangler/backup-drill-*/*.log",
    ]),
    command("backup-operator-drill", "pnpm", ["backup:operator-drill"], 1_800_000, [
      ".wrangler/operator-drill-*/report.json",
    ]),
    command("backup-run-drill", "pnpm", ["backup:run-drill"], 1_800_000, [
      ".wrangler/backup-run-drill-*/*.log",
    ]),
    command(
      "playwright-chromium-prerequisite",
      "node",
      ["scripts/release-gate-browser.mjs"],
      30_000,
    ),
    command("browser-tests", "pnpm", ["test:browser"], 1_800_000, ["test-results/"]),
  ];
}

const forbidden = [
  { code: "deploy", test: (tokens) => tokens.includes("deploy") },
  { code: "remote", test: (tokens) => tokens.includes("--remote") },
  {
    code: "migration-apply",
    test: (tokens) => tokens.includes("migrations") && tokens.includes("apply"),
  },
  {
    code: "secret",
    test: (tokens) => tokens.some((token) => /^(?:secret|secrets)(?::|$)/.test(token)),
  },
  { code: "purge", test: (tokens) => tokens.some((token) => /^purge(?::|$)/.test(token)) },
  { code: "restore", test: (tokens) => tokens.some((token) => /^restore(?:-|:|$)/.test(token)) },
  {
    code: "resource-create",
    test: (tokens) =>
      tokens.includes("create") &&
      tokens.some((token) => ["wrangler", "d1", "r2", "queues", "kv"].includes(token)),
  },
  {
    code: "external-notification",
    test: (tokens) =>
      tokens.some((token) =>
        /^(?:curl|webhook|notify|notification|slack|teams|email)(?::|$)/.test(token),
      ),
  },
];

export function assertSafePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error("release_gate_empty_plan");
  const ids = new Set();
  for (const item of plan) {
    if (
      typeof item.id !== "string" ||
      typeof item.executable !== "string" ||
      !Array.isArray(item.args) ||
      !Number.isSafeInteger(item.timeoutMs) ||
      item.timeoutMs <= 0
    ) {
      throw new Error("release_gate_invalid_plan");
    }
    if (ids.has(item.id)) throw new Error("release_gate_duplicate_command");
    ids.add(item.id);
    const tokens = [item.executable, ...item.args].map((token) => String(token).toLowerCase());
    const blocked = forbidden.find(({ test }) => test(tokens));
    if (blocked) throw new Error(`release_gate_forbidden_${blocked.code}`);
    for (const report of item.reports ?? []) assertRelativeReference(report);
  }
  return plan;
}

export function planEvidence(plan = buildCommandPlan()) {
  assertSafePlan(plan);
  return {
    format: FORMAT,
    version: MANIFEST_VERSION,
    mode: "plan",
    passed: false,
    releaseReady: false,
    verdict: "plan-only",
    commands: plan.map(({ id, executable, args, timeoutMs, reports }) => ({
      id,
      executable,
      args: [...args],
      timeoutMs,
      reports: [...reports],
    })),
    verification: {
      local: { status: "not-run" },
      remote: remoteVerification,
    },
  };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function evaluatePreflight({
  expectedRef,
  head,
  ref,
  status,
  nodeVersion,
  pnpmVersion,
  packageNode,
  packagePnpm,
  lockfileSha256,
  committedLockfileSha256,
}) {
  const checks = [
    check("exact-head", /^[a-f0-9]{40}$/.test(expectedRef) && expectedRef === head),
    check("clean-worktree", status === ""),
    check("node-toolchain", nodeVersion === EXPECTED_NODE && packageNode === EXPECTED_NODE),
    check(
      "pnpm-toolchain",
      pnpmVersion === EXPECTED_PNPM && packagePnpm === `pnpm@${EXPECTED_PNPM}`,
    ),
    check("frozen-lockfile", lockfileSha256 === committedLockfileSha256),
  ];
  return {
    passed: checks.every(({ status: checkStatus }) => checkStatus === "passed"),
    ref,
    checks,
  };
}

const check = (id, passed) => ({ id, status: passed ? "passed" : "failed" });

export function notRunResults(plan) {
  return plan.map(({ id, executable, args, timeoutMs, reports }) => ({
    id,
    executable,
    args: [...args],
    timeoutMs,
    reports: [...reports],
    status: "not-run",
    exitCode: null,
    signal: null,
    failure: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }));
}

export async function executePlan(
  plan,
  { cwd, runCommand = spawnCommand, signal, now = () => Date.now() },
) {
  const results = notRunResults(plan);
  for (let index = 0; index < plan.length; index++) {
    const item = plan[index];
    const result = await runCommand(item, { cwd, signal, now });
    results[index] = {
      id: item.id,
      executable: item.executable,
      args: [...item.args],
      timeoutMs: item.timeoutMs,
      reports: [...item.reports],
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      failure: result.failure,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: result.durationMs,
    };
    if (result.status !== "passed") break;
  }
  return results;
}

export async function spawnCommand(item, { cwd, signal, now = () => Date.now() }) {
  const started = now();
  return await new Promise((resolveResult) => {
    let failure = null;
    let settled = false;
    let forceTimer;
    const child = spawn(item.executable, item.args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
    const finish = (exitCode, childSignal, spawnError = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      const completed = now();
      const passed = !spawnError && failure === null && exitCode === 0 && childSignal === null;
      resolveResult({
        status: passed ? "passed" : "failed",
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: failure === "signal" ? (signal?.reason ?? "signal") : childSignal,
        failure: passed ? null : (failure ?? (spawnError ? "spawn" : "command")),
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        durationMs: Math.max(0, completed - started),
      });
    };
    const terminate = (reason) => {
      if (settled || failure !== null) return;
      failure = reason;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceTimer.unref?.();
    };
    const abort = () => terminate("signal");
    const timeout = setTimeout(() => terminate("timeout"), item.timeoutMs);
    timeout.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(null, null, true));
    child.once("exit", (code, childSignal) => finish(code, childSignal));
  });
}

export function buildManifest({
  head,
  ref,
  expectedRef,
  nodeVersion,
  pnpmVersion,
  lockfileSha256,
  preflight,
  commands,
  postflight,
  startedAt,
  completedAt,
}) {
  const commandsPassed = commands.every(({ status }) => status === "passed");
  const passed = preflight.passed && commandsPassed && postflight.passed;
  return {
    format: FORMAT,
    version: MANIFEST_VERSION,
    mode: "full",
    passed,
    releaseReady: false,
    verdict: passed ? "local-gates-passed" : "non-passing",
    commit: { head, expected: expectedRef, ref },
    toolchain: {
      node: { expected: EXPECTED_NODE, actual: nodeVersion },
      pnpm: { expected: EXPECTED_PNPM, actual: pnpmVersion },
      lockfileSha256,
    },
    preflight: preflight.checks,
    commands,
    postflight: postflight.checks,
    verification: {
      local: { status: passed ? "verified" : "failed" },
      remote: remoteVerification,
    },
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: Math.max(0, completedAt - startedAt),
  };
}

export async function writeEvidenceAtomic(path, manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = sha256(serialized);
  const digestPath = `${path}.sha256`;
  await mkdir(dirname(path), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const manifestTemp = `${path}.${nonce}.tmp`;
  const digestTemp = `${digestPath}.${nonce}.tmp`;
  try {
    await writeFile(manifestTemp, serialized, { flag: "wx" });
    await writeFile(digestTemp, `${digest}  ${basename(path)}\n`, { flag: "wx" });
    await rename(manifestTemp, path);
    await rename(digestTemp, digestPath);
  } finally {
    await rm(manifestTemp, { force: true });
    await rm(digestTemp, { force: true });
  }
  return { path, digestPath, digest };
}

export function evidencePath(root, head) {
  return join(root, ".release-evidence", `release-gate-v${MANIFEST_VERSION}-${head}.json`);
}

export function assertRelativeReference(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    normalize(path).split(sep).includes("..") ||
    path.includes("\\")
  ) {
    throw new Error("release_gate_invalid_report_reference");
  }
  return path;
}

export function assertOutputInside(root, output) {
  if (posix.isAbsolute(output) || win32.isAbsolute(output)) {
    throw new Error("release_gate_invalid_output");
  }
  const path = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") ? win32 : posix;
  const absolute = path.resolve(root, output);
  const fromRoot = path.relative(root, absolute);
  if (fromRoot === "" || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot))
    throw new Error("release_gate_invalid_output");
  return absolute;
}

export async function verifyExecutable(path) {
  await access(path, fsConstants.X_OK);
}

export async function runReleaseGate({
  root,
  expectedRef,
  signal,
  capture,
  runCommand = spawnCommand,
  now = () => Date.now(),
  writeEvidence = writeEvidenceAtomic,
}) {
  const startedAt = now();
  const plan = assertSafePlan(buildCommandPlan());
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"));
  const head = await capture("git", ["rev-parse", "HEAD"], root);
  const ref = (await capture("git", ["symbolic-ref", "--short", "-q", "HEAD"], root)) || "HEAD";
  const status = await capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  const committedLockfile = await capture("git", ["show", "HEAD:pnpm-lock.yaml"], root, false);
  const pnpmVersion = await capture("pnpm", ["--version"], root);
  const lockfileSha256 = sha256(lockfile);
  const preflight = evaluatePreflight({
    expectedRef,
    head,
    ref,
    status,
    nodeVersion: process.versions.node,
    pnpmVersion,
    packageNode: packageJson.engines?.node,
    packagePnpm: packageJson.packageManager,
    lockfileSha256,
    committedLockfileSha256: sha256(committedLockfile),
  });
  const commands = preflight.passed
    ? await executePlan(plan, { cwd: root, runCommand, signal, now })
    : notRunResults(plan);
  const finalStatus = await capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  const finalLockfile = await readFile(join(root, "pnpm-lock.yaml"));
  const postflight = {
    checks: [
      check("clean-worktree", finalStatus === ""),
      check("unchanged-lockfile", sha256(finalLockfile) === lockfileSha256),
      check("head-unchanged", (await capture("git", ["rev-parse", "HEAD"], root)) === head),
      check("not-signaled", !signal?.aborted),
    ],
  };
  postflight.passed = postflight.checks.every(
    ({ status: checkStatus }) => checkStatus === "passed",
  );
  const completedAt = now();
  const manifest = buildManifest({
    head,
    ref,
    expectedRef,
    nodeVersion: process.versions.node,
    pnpmVersion,
    lockfileSha256,
    preflight,
    commands,
    postflight,
    startedAt,
    completedAt,
  });
  const output = await writeEvidence(evidencePath(root, head), manifest);
  return { manifest, output };
}
