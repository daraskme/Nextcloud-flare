import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOutputInside,
  assertSafePlan,
  buildCommandPlan,
  buildManifest,
  EXPECTED_NODE,
  EXPECTED_PNPM,
  evaluatePreflight,
  executePlan,
  notRunResults,
  planEvidence,
  sha256,
  verifyExecutable,
  writeEvidenceAtomic,
} from "../release-gate-lib.mjs";

const head = "a".repeat(40);
const lockfileSha256 = "b".repeat(64);
const basePreflight = {
  expectedRef: head,
  head,
  ref: "devin/example",
  status: "",
  nodeVersion: EXPECTED_NODE,
  pnpmVersion: EXPECTED_PNPM,
  packageNode: EXPECTED_NODE,
  packagePnpm: `pnpm@${EXPECTED_PNPM}`,
  lockfileSha256,
  committedLockfileSha256: lockfileSha256,
};
const passedResult = (item, offset = 0) => ({
  id: item.id,
  executable: item.executable,
  args: [...item.args],
  timeoutMs: item.timeoutMs,
  reports: [...item.reports],
  status: "passed",
  exitCode: 0,
  signal: null,
  failure: null,
  startedAt: new Date(1_000 + offset).toISOString(),
  completedAt: new Date(1_001 + offset).toISOString(),
  durationMs: 1,
});
const postflight = {
  passed: true,
  checks: [
    { id: "clean-worktree", status: "passed" },
    { id: "unchanged-lockfile", status: "passed" },
    { id: "head-unchanged", status: "passed" },
    { id: "not-signaled", status: "passed" },
  ],
};
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release gate plan", () => {
  it("has one deterministic sequential command set", () => {
    const plan = assertSafePlan(buildCommandPlan());
    expect(plan.map(({ id }) => id)).toEqual([
      "frozen-lockfile",
      "repository-check",
      "backup-drill",
      "backup-operator-drill",
      "backup-run-drill",
      "playwright-chromium-prerequisite",
      "browser-tests",
    ]);
    expect(buildCommandPlan()).toEqual(plan);
    expect(planEvidence(plan)).toMatchObject({
      mode: "plan",
      passed: false,
      releaseReady: false,
      verdict: "plan-only",
      verification: {
        local: { status: "not-run" },
        remote: [
          { environment: "cloudflare-staging", status: "unverified" },
          { environment: "cloudflare-production", status: "unverified" },
        ],
      },
    });
  });

  it.each([
    ["deploy", ["wrangler", "deploy"]],
    ["remote", ["wrangler", "d1", "execute", "--remote"]],
    ["migration apply", ["wrangler", "d1", "migrations", "apply"]],
    ["secret", ["wrangler", "secret:bulk"]],
    ["purge", ["pnpm", "purge"]],
    ["restore", ["node", "restore-live"]],
    ["resource create", ["wrangler", "queues", "create"]],
    ["notification", ["curl", "https://hooks.invalid"]],
  ])("rejects forbidden %s commands", (_label, [executable, ...args]) => {
    expect(() =>
      assertSafePlan([{ id: "unsafe", executable, args, timeoutMs: 1, reports: [] }]),
    ).toThrow(/release_gate_forbidden/);
  });
});

describe("release gate preflight", () => {
  it("passes only the exact clean pinned checkout", () => {
    expect(evaluatePreflight(basePreflight)).toEqual({
      passed: true,
      ref: "devin/example",
      checks: [
        { id: "exact-head", status: "passed" },
        { id: "clean-worktree", status: "passed" },
        { id: "node-toolchain", status: "passed" },
        { id: "pnpm-toolchain", status: "passed" },
        { id: "frozen-lockfile", status: "passed" },
      ],
    });
  });

  it.each([
    ["dirty tree", { status: " M package.json" }, "clean-worktree"],
    ["wrong ref", { expectedRef: "c".repeat(40) }, "exact-head"],
    ["wrong Node", { nodeVersion: "24.20.0" }, "node-toolchain"],
    ["wrong pnpm", { pnpmVersion: "12.4.0" }, "pnpm-toolchain"],
    ["changed lockfile", { lockfileSha256: "d".repeat(64) }, "frozen-lockfile"],
  ])("fails for %s", (_label, change, failedId) => {
    const result = evaluatePreflight({ ...basePreflight, ...change });
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({ id: failedId, status: "failed" });
  });
});

describe("release gate execution", () => {
  it.each([
    ["command", { exitCode: 2, signal: null, failure: "command" }],
    ["timeout", { exitCode: null, signal: "SIGTERM", failure: "timeout" }],
    ["signal", { exitCode: null, signal: "SIGINT", failure: "signal" }],
  ])("stops after a %s failure", async (_label, failure) => {
    const plan = buildCommandPlan().slice(0, 3);
    const seen = [];
    const results = await executePlan(plan, {
      cwd: ".",
      runCommand: async (item) => {
        seen.push(item.id);
        if (item.id === plan[1].id) {
          return {
            status: "failed",
            ...failure,
            startedAt: new Date(1_000).toISOString(),
            completedAt: new Date(1_010).toISOString(),
            durationMs: 10,
          };
        }
        return passedResult(item);
      },
    });
    expect(seen).toEqual([plan[0].id, plan[1].id]);
    expect(results.map(({ status }) => status)).toEqual(["passed", "failed", "not-run"]);
  });

  it("never turns a partial run into a passing manifest", () => {
    const plan = buildCommandPlan();
    const commands = notRunResults(plan);
    commands[0] = passedResult(plan[0]);
    const manifest = buildManifest({
      head,
      ref: "devin/example",
      expectedRef: head,
      nodeVersion: EXPECTED_NODE,
      pnpmVersion: EXPECTED_PNPM,
      lockfileSha256,
      preflight: evaluatePreflight(basePreflight),
      commands,
      postflight,
      startedAt: 1_000,
      completedAt: 2_000,
    });
    expect(manifest).toMatchObject({
      passed: false,
      releaseReady: false,
      verdict: "non-passing",
      verification: { local: { status: "failed" } },
    });
  });

  it("treats a missing browser prerequisite as mandatory failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-gate-browser-"));
    directories.push(directory);
    await expect(verifyExecutable(join(directory, "missing-chromium"))).rejects.toThrow();
    const plan = buildCommandPlan();
    const commands = plan.map(passedResult);
    const browser = commands.find(({ id }) => id === "playwright-chromium-prerequisite");
    Object.assign(browser, {
      status: "failed",
      exitCode: 1,
      failure: "command",
    });
    expect(
      buildManifest({
        head,
        ref: "devin/example",
        expectedRef: head,
        nodeVersion: EXPECTED_NODE,
        pnpmVersion: EXPECTED_PNPM,
        lockfileSha256,
        preflight: evaluatePreflight(basePreflight),
        commands,
        postflight,
        startedAt: 1_000,
        completedAt: 2_000,
      }).passed,
    ).toBe(false);
  });
});

describe("release evidence manifest", () => {
  it("contains allowlisted local evidence and explicit unverified remote scope", () => {
    const plan = buildCommandPlan();
    const manifest = buildManifest({
      head,
      ref: "devin/example",
      expectedRef: head,
      nodeVersion: EXPECTED_NODE,
      pnpmVersion: EXPECTED_PNPM,
      lockfileSha256,
      preflight: evaluatePreflight(basePreflight),
      commands: plan.map(passedResult),
      postflight,
      startedAt: 1_000,
      completedAt: 2_000,
    });
    expect(manifest).toMatchObject({
      passed: true,
      releaseReady: false,
      verdict: "local-gates-passed",
      commit: { head, expected: head, ref: "devin/example" },
      verification: {
        local: { status: "verified" },
        remote: [
          { environment: "cloudflare-staging", status: "unverified" },
          { environment: "cloudflare-production", status: "unverified" },
        ],
      },
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
    expect(Object.keys(manifest)).toEqual([
      "format",
      "version",
      "mode",
      "passed",
      "releaseReady",
      "verdict",
      "commit",
      "toolchain",
      "preflight",
      "commands",
      "postflight",
      "verification",
      "startedAt",
      "completedAt",
      "durationMs",
    ]);
  });

  it("writes an atomic manifest and matching digest sidecar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-gate-evidence-"));
    directories.push(directory);
    const path = join(directory, "evidence", "manifest.json");
    const manifest = { version: 1, passed: false };
    const output = await writeEvidenceAtomic(path, manifest);
    const bytes = await readFile(path);
    expect(output.digest).toBe(sha256(bytes));
    expect(await readFile(`${path}.sha256`, "utf8")).toBe(`${output.digest}  manifest.json\n`);
    expect((await readdir(join(directory, "evidence"))).sort()).toEqual([
      "manifest.json",
      "manifest.json.sha256",
    ]);
  });

  it("replaces prior evidence without changing its shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-gate-repeat-"));
    directories.push(directory);
    const path = join(directory, "manifest.json");
    await writeFile(path, "{}\n");
    await writeEvidenceAtomic(path, { version: 1, passed: false, durationMs: 1 });
    const first = JSON.parse(await readFile(path, "utf8"));
    await writeEvidenceAtomic(path, { version: 1, passed: false, durationMs: 2 });
    const second = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(second)).toEqual(Object.keys(first));
    expect(second.durationMs).toBe(2);
  });

  it("keeps operator-selected output inside the repository", () => {
    expect(assertOutputInside("/repo", ".release-evidence/result.json")).toBe(
      "/repo/.release-evidence/result.json",
    );
    expect(() => assertOutputInside("/repo", "/outside/result.json")).toThrow(
      "release_gate_invalid_output",
    );
    expect(() => assertOutputInside("/repo", "../outside/result.json")).toThrow(
      "release_gate_invalid_output",
    );
  });
});
