import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createUnhandledClassifier } from "./unhandled-classifier.mjs";

const runner = fileURLToPath(new URL("./fail-on-unhandled.mjs", import.meta.url));
const native =
  "exception = kj/async-io.c++:1713: disconnected: fixed-length pipe ended prematurely";
const canceledPump =
  "exception = workerd/api/streams/internal.c++:2643: disconnected: pump canceled";
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
function classify(shortBody, lines) {
  const result = createUnhandledClassifier(shortBody);
  for (const line of lines) result.inspect(line);
  return { expected: result.expectedDisconnects, unhandled: result.unhandled };
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

  it("forwards handled native stream diagnostics without calling them unhandled promises", () => {
    for (const stream of ["stderr", "stdout"]) {
      const result =
        stream === "stderr" ? emit([native, canceledPump]) : emit([], [native, canceledPump]);
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(canceledPump);
      expect(result.stderr).toContain("unhandled rejections=0");
    }
  });

  it("fails explicit workerd promise markers even beside handled native diagnostics", () => {
    for (const stream of ["stderr", "stdout"]) {
      const result =
        stream === "stderr" ? emit([canceledPump, network]) : emit([], [canceledPump, network]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("platform expected disconnects=0; unhandled rejections=1");
    }
    expect(emit([network]).status).toBe(1);
  });

  it("allows at most two exact network losses in the isolated short-body process", () => {
    expect(classify(true, [network, network])).toEqual({ expected: 2, unhandled: 0 });
    expect(classify(true, [native, "stack: workerd", network, network])).toEqual({
      expected: 2,
      unhandled: 0,
    });
    expect(classify(true, [network, network, network])).toEqual({ expected: 2, unhandled: 1 });
  });

  it("does not excuse other uncaught promises in the isolated process", () => {
    expect(classify(true, [other])).toEqual({ expected: 0, unhandled: 1 });
    expect(classify(true, ["exception = other-native-failure", network, other])).toEqual({
      expected: 1,
      unhandled: 1,
    });
    expect(classify(false, [canceledPump, network])).toEqual({ expected: 0, unhandled: 1 });
  });

  it("preserves a child's nonzero exit even when it only emitted native diagnostics", () => {
    const result = run(
      `process.stderr.write(${JSON.stringify(canceledPump + "\n")});process.exit(17)`,
    );
    expect(result.status).toBe(17);
    expect(result.stderr).toContain("unhandled rejections=0");
  });

  it("fails a Node unhandled rejection under strict mode", () => {
    const result = run('Promise.reject(new Error("unhandled_test")); setTimeout(() => {}, 20)');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unhandled_test");
  });
});
