import { spawn } from "node:child_process";
import { createUnhandledClassifier } from "./unhandled-classifier.mjs";

const requested = process.argv.slice(2);
const shortBody = requested[0] === "--r2-short-body";
const args = shortBody
  ? [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.config.ts",
      "packages/worker/test/integration/r2-short-body.test.ts",
    ]
  : requested;
if (args.length === 0 || (shortBody && requested.length !== 1)) {
  process.stderr.write(
    "Usage: fail-on-unhandled.mjs [--r2-short-body | <node-script> [args...]]\n",
  );
  process.exitCode = 2;
} else {
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --unhandled-rejections=strict`.trim(),
    },
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  const classifier = createUnhandledClassifier(shortBody);
  let spawnFailed = false;
  const forward = (source, destination) => {
    let pending = "";
    source.on("data", (chunk) => {
      destination.write(chunk);
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        classifier.inspect(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      // Keep a bounded suffix if a tool emits an unusually long line.
      if (pending.length > 16_384) {
        classifier.inspect(pending.slice(0, -256));
        pending = pending.slice(-256);
      }
    });
    source.on("end", () => {
      if (pending) classifier.inspect(pending);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("error", (error) => {
    spawnFailed = true;
    process.stderr.write(`Integration runner failed: ${error.code ?? "spawn_error"}\n`);
  });
  child.on("close", (code, signal) => {
    process.stderr.write(
      `Workerd diagnostics: platform expected disconnects=${classifier.expectedDisconnects}; unhandled rejections=${classifier.unhandled}.\n`,
    );
    process.exitCode = spawnFailed || signal || classifier.unhandled > 0 ? 1 : (code ?? 1);
  });
}
