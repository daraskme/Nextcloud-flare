import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const stagingDirectory = join(root, "ops/staging");
const generator = join(stagingDirectory, "staging-config.mjs");
const template = join(stagingDirectory, "wrangler.staging.example.jsonc");

async function generateInFixture(weeklyFlag) {
  const directory = await mkdtemp(join(stagingDirectory, ".staging-config-test-"));
  try {
    const fixtureGenerator = join(directory, "staging-config.mjs");
    await Promise.all([
      copyFile(generator, fixtureGenerator),
      copyFile(template, join(directory, "wrangler.staging.example.jsonc")),
    ]);
    const env = {
      ...process.env,
      STAGING_D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
      STAGING_KV_NAMESPACE_ID: "1234567890abcdef1234567890abcdef",
    };
    if (weeklyFlag === undefined) delete env.STAGING_WEEKLY_BACKUP_ENABLED;
    else env.STAGING_WEEKLY_BACKUP_ENABLED = weeklyFlag;
    const result = spawnSync(process.execPath, [fixtureGenerator, "generate"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    return { directory, result };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("staging generator defaults weekly backup operator off for unset and empty inputs", async () => {
  for (const flag of [undefined, ""]) {
    const fixture = await generateInFixture(flag);
    try {
      assert.equal(fixture.result.status, 0);
      const generated = JSON.parse(
        await readFile(join(fixture.directory, "wrangler.staging.generated.jsonc"), "utf8"),
      );
      assert.equal(generated.vars.BACKUP_OPERATOR_ENABLED, "false");
      assert.equal(generated.vars.STAGING_CONTROL_OPERATOR_ENABLED, "false");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("staging generator preserves only an explicitly enabled weekly backup gate", async () => {
  for (const [flag, expected] of [
    ["true", "true"],
    ["false", "false"],
  ]) {
    const fixture = await generateInFixture(flag);
    try {
      assert.equal(fixture.result.status, 0);
      const generated = JSON.parse(
        await readFile(join(fixture.directory, "wrangler.staging.generated.jsonc"), "utf8"),
      );
      assert.equal(generated.vars.BACKUP_OPERATOR_ENABLED, expected);
      assert.equal(generated.vars.STAGING_CONTROL_OPERATOR_ENABLED, "false");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("staging generator rejects nonliteral weekly backup values", async () => {
  for (const flag of ["1", "yes", "TRUE", " true", "false "]) {
    const fixture = await generateInFixture(flag);
    try {
      assert.notEqual(fixture.result.status, 0);
      assert.match(fixture.result.stderr, /Invalid STAGING_WEEKLY_BACKUP_ENABLED/);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});
