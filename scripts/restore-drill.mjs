import { spawnSync } from "node:child_process";

const [mode, database, source, confirmation] = process.argv.slice(2);
if (
  (mode !== "time-travel" && mode !== "logical-export") ||
  database === undefined ||
  source === undefined
) {
  console.error(
    "Usage: node scripts/restore-drill.mjs <time-travel|logical-export> <database> <bookmark-or-file> [--confirm-staging]",
  );
  process.exitCode = 2;
} else if (confirmation !== "--confirm-staging") {
  console.log(
    JSON.stringify({ mode, database, source, action: "dry-run", destructive: true }, null, 2),
  );
  console.log("Re-run with --confirm-staging only after maintenance and GC pause are verified.");
} else {
  const args =
    mode === "time-travel"
      ? ["exec", "wrangler", "d1", "time-travel", "restore", database, "--bookmark", source]
      : ["exec", "wrangler", "d1", "execute", database, "--remote", "--file", source];
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exitCode = result.status ?? 1;
}
