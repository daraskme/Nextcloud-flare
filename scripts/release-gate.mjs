#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { planEvidence, runReleaseGate } from "./release-gate-lib.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

function parseArgs(args) {
  let plan = false;
  let ref = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--" && index === 0) {
      continue;
    } else if (arg === "--plan") {
      if (plan) throw new Error("release_gate_duplicate_plan");
      plan = true;
    } else if (arg === "--ref") {
      if (ref !== null || !args[index + 1]) throw new Error("release_gate_invalid_ref");
      ref = args[++index];
    } else {
      throw new Error("release_gate_unknown_option");
    }
  }
  if (!plan && !/^[a-f0-9]{40}$/.test(ref ?? ""))
    throw new Error("release_gate_exact_ref_required");
  if (plan && ref !== null && !/^[a-f0-9]{40}$/.test(ref)) {
    throw new Error("release_gate_invalid_ref");
  }
  return { plan, ref };
}

async function capture(executable, args, cwd, trim = true) {
  const result = await exec(executable, args, {
    cwd,
    encoding: trim ? "utf8" : null,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return trim ? result.stdout.trim() : result.stdout;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.plan) {
    console.log(JSON.stringify(planEvidence(), null, 2));
  } else {
    const controller = new AbortController();
    const onSigint = () => controller.abort("SIGINT");
    const onSigterm = () => controller.abort("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const result = await runReleaseGate({
      root,
      expectedRef: options.ref,
      signal: controller.signal,
      capture,
    });
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    console.log(
      JSON.stringify({
        passed: result.manifest.passed,
        verdict: result.manifest.verdict,
        commit: result.manifest.commit.head,
        manifest: ".release-evidence/" + result.output.path.split("/").at(-1),
        digest: result.output.digest,
        remote: result.manifest.verification.remote,
      }),
    );
    if (!result.manifest.passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "release_gate_failed");
  process.exitCode = 1;
}
