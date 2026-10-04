import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { verifyExecutable } from "./release-gate-lib.mjs";

const executable = chromium.executablePath();
try {
  await verifyExecutable(executable);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: "ignore" });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("playwright_chromium_timeout"));
    }, 10_000);
    child.once("error", () => finish(new Error("playwright_chromium_missing")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) finish();
      else finish(new Error("playwright_chromium_unavailable"));
    });
  });
  console.log("Playwright Chromium prerequisite verified.");
} catch {
  console.error("Playwright Chromium prerequisite is missing or unusable.");
  process.exitCode = 1;
}
