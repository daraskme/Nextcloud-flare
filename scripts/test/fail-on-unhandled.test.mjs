import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = fileURLToPath(new URL("./fail-on-unhandled.mjs", import.meta.url));
const native =
  "exception = kj/async-io.c++:2032: disconnected: fixed-length pipe ended prematurely";
const network =
  "uncaught exception; source = Uncaught (in promise); stack = Error: Network connection lost.";
const other = "uncaught exception; source = Uncaught (in promise); stack = Error: admission_closed";

function run(code) {
  return spawnSync(process.execPath, [runner, "-e", code], {
    encoding: "utf8",
    timeout: 5_000,
  });
}
function emit(stderrLines = [], stdoutLines = []) {
  return run(
    `process.stderr.write(${JSON.stringify(stderrLines.join("\n") + "\n")});process.stdout.write(${JSON.stringify(stdoutLines.join("\n") + "\n")})`,
  );
}

describe("integration unhandled rejection gate", () => {
  it("passes a clean child and preserves its output", () => {
    const result = run('process.stdout.write("clean\\n")');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean\n");
    expect(result.stderr).toContain("platform expected disconnects=0; unhandled rejections=0");
  });

  it("fails even when a child exits zero and the workerd marker is split", () => {
    const result = run(
      'process.stderr.write("uncaught exception; source = Uncaught (in "); process.stderr.write("promise); stack = Error: failed\\n")',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unhandled rejections=1");
  });

  it("counts only two native fixed-length disconnects on one output stream", () => {
    const result = emit([native, "stack: workerd", network, network]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("platform expected disconnects=2; unhandled rejections=0");
    const stdout = emit([], [native, "stack: workerd", network, network]);
    expect(stdout.status).toBe(0);
    expect(stdout.stderr).toContain("platform expected disconnects=2; unhandled rejections=0");
  });

  it("fails an isolated network rejection and a third native-context rejection", () => {
    expect(emit([network]).status).toBe(1);
    const third = emit([native, "stack: workerd", network, network, network]);
    expect(third.status).toBe(1);
    expect(third.stderr).toContain("platform expected disconnects=2; unhandled rejections=1");
  });

  it("fails another rejection or a network rejection after the native context ends", () => {
    expect(emit([native, "stack: workerd", other]).status).toBe(1);
    expect(emit([native, "stack: workerd", "different error", network]).status).toBe(1);
  });

  it("does not transfer the native context across stdout and stderr", () => {
    expect(emit([network], [native]).status).toBe(1);
    expect(emit([native], [network]).status).toBe(1);
  });

  it("fails a Node unhandled rejection under strict mode", () => {
    const result = run('Promise.reject(new Error("unhandled_test")); setTimeout(() => {}, 20)');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unhandled_test");
  });
});
