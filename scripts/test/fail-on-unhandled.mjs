import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: fail-on-unhandled.mjs <node-script> [args...]\n");
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
  let unhandled = 0;
  let expectedDisconnects = 0;
  const fixedLengthPipeContext = { stdout: false, stderr: false };
  let spawnFailed = false;
  const inspect = (line, stream) => {
    const value = line.trimEnd();
    if (
      value ===
      "exception = kj/async-io.c++:2032: disconnected: fixed-length pipe ended prematurely"
    ) {
      fixedLengthPipeContext[stream] = true;
      return;
    }
    if (fixedLengthPipeContext[stream] && value.startsWith("stack:")) return;
    if (/uncaught exception; source = Uncaught \(in promise\)/i.test(value)) {
      if (
        fixedLengthPipeContext[stream] &&
        expectedDisconnects < 2 &&
        value ===
          "uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost."
      ) {
        expectedDisconnects++;
      } else {
        unhandled++;
        fixedLengthPipeContext[stream] = false;
      }
      return;
    }
    fixedLengthPipeContext[stream] = false;
  };
  const forward = (source, destination, stream) => {
    let pending = "";
    source.on("data", (chunk) => {
      destination.write(chunk);
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        inspect(pending.slice(0, newline), stream);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      // Keep a bounded suffix if a tool emits an unusually long line.
      if (pending.length > 16_384) {
        inspect(pending.slice(0, -256), stream);
        pending = pending.slice(-256);
      }
    });
    source.on("end", () => {
      if (pending) inspect(pending, stream);
    });
  };
  forward(child.stdout, process.stdout, "stdout");
  forward(child.stderr, process.stderr, "stderr");
  child.on("error", (error) => {
    spawnFailed = true;
    process.stderr.write(`Integration runner failed: ${error.code ?? "spawn_error"}\n`);
  });
  child.on("close", (code, signal) => {
    process.stderr.write(
      `Workerd diagnostics: platform expected disconnects=${expectedDisconnects}; unhandled rejections=${unhandled}.\n`,
    );
    process.exitCode = spawnFailed || signal || unhandled > 0 ? 1 : (code ?? 1);
  });
}
