import assert from "node:assert/strict";
import { test } from "vitest";
import {
  automationPlan,
  parseProtectedCredentials,
  renderAutomationUnits,
  selectReleaseFiles,
} from "../../ops/backup/install-user-automation.mjs";

const plan = () =>
  automationPlan({
    root: "/home/operator/.local/share/ncf-automation",
    repo: "/home/operator/Nextcloud-flare",
    systemdDirectory: "/home/operator/.config/systemd/user",
    credentialsFile: "/home/operator/private/cloudflare.env",
    publicKeyFile: "/home/operator/private/admin-public.json",
    monitorConfigFile: "/home/operator/private/monitor.json",
    node: "/home/operator/toolchain/node",
    pnpm: "/home/operator/toolchain/pnpm",
    workerd: "/home/operator/toolchain/workerd",
    mountPoint: "/media/operator/volume",
    externalRoot: "/media/operator/volume/backups",
    volumeUuid: "ABCD1234",
    cloudflareAccountId: "a".repeat(32),
    databaseId: "00000000-0000-0000-0000-000000000001",
    adminAccountId: "admin_fixture",
  });
const posixTest = test.skipIf(process.platform === "win32");
const windowsTest = test.skipIf(process.platform !== "win32");

posixTest(
  "weekly and monitoring timers have fixed schedule, persistent catch-up and isolated locks",
  () => {
    const units = renderAutomationUnits(plan());
    assert.match(units["ncf-weekly-backup.timer"], /OnCalendar=Sun \*-\*-\* 03:30:00 Asia\/Tokyo/);
    assert.match(units["ncf-weekly-backup.timer"], /Persistent=true/);
    assert.match(units["ncf-backup-monitor.timer"], /OnCalendar=hourly/);
    assert.match(units["ncf-backup-monitor.timer"], /Persistent=true/);
    assert.match(
      units["ncf-weekly-backup.service"],
      /toolchain\/bin\/flock -n .*\/locks\/backup\.lock/,
    );
    assert.match(
      units["ncf-backup-monitor.service"],
      /toolchain\/bin\/flock -n .*\/locks\/monitor\.lock/,
    );
    assert.match(units["ncf-weekly-backup.service"], /config\/credentials\.env/);
    assert.match(units["ncf-weekly-backup.service"], /Restart=on-failure\nRestartSec=30min/);
    assert.match(units["ncf-backup-monitor.service"], /config\/monitor-credentials\.env/);
    assert.ok(!units["ncf-backup-monitor.service"].includes("/config/credentials.env"));
    assert.ok(
      Object.values(units).every((unit) => !unit.includes("/tmp/") && !unit.includes("/run/")),
    );
  },
);

posixTest("rejects ephemeral release roots and external-overlapping paths", () => {
  assert.equal(plan().maxObjects, 10_000);
  assert.equal(plan().maxBytes, 10 * 1024 * 1024 * 1024);
  assert.throws(
    () => automationPlan({ ...plan(), maxBytes: 536_870_912_001 }),
    /automation_install_invalid/,
  );
  assert.throws(() => automationPlan({ ...plan(), root: "/tmp/ncf" }), /persistent_root_required/);
  assert.throws(
    () => automationPlan({ ...plan(), root: "/media/operator/volume/backups/internal" }),
    /automation_install_invalid/,
  );
});

test("protected credential parser rejects extra environment injection and duplicate keys", () => {
  const input = [
    "CLOUDFLARE_API_TOKEN=secret-token",
    "R2_INVENTORY_ACCESS_KEY_ID=fixture-access",
    "R2_INVENTORY_SECRET_ACCESS_KEY=fixture-secret/+=",
  ].join("\n");
  assert.equal(parseProtectedCredentials(input), input + "\n");
  assert.throws(
    () => parseProtectedCredentials(input + "\nNODE_OPTIONS=--require=/tmp/evil"),
    /credentials_invalid/,
  );
  assert.throws(
    () => parseProtectedCredentials(input + "\nCLOUDFLARE_API_TOKEN=second"),
    /credentials_invalid/,
  );
});

test("release allowlist requires the runtime, smoke manifests and crypto sources", () => {
  const required = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "ops/backup/run-weekly.mjs",
    "ops/backup/archive-storage.mjs",
    "ops/staging/weekly-backup-runner.mjs",
    "ops/staging/weekly-backup-runtime.mjs",
    "ops/staging/backup-cron.mjs",
    "ops/staging/backup-cron.wrangler.example.jsonc",
    "ops/staging/smoke-check.mjs",
    "ops/monitoring/run-monitor.mjs",
    "scripts/backup/encryptedArchive.mjs",
    "packages/worker/src/db/schemaContract.ts",
    "packages/worker/src/assets/privateManifest.ts",
    "packages/worker/src/assets/publicManifest.ts",
    "packages/web/src/lib/encryptedContainer.ts",
  ];
  const selected = selectReleaseFiles([
    ...required,
    ".env.production",
    ".dev.vars",
    "docs/private.txt",
    "packages/shared/src/signedContainer.ts",
  ]);
  assert.deepEqual(selected, [...required, "packages/shared/src/signedContainer.ts"].sort());
  assert.throws(
    () => selectReleaseFiles(required.filter((path) => path !== "ops/staging/smoke-check.mjs")),
    /source_incomplete/,
  );
});

windowsTest("POSIX installer rejects Windows before inspecting paths or credentials", () => {
  assert.throws(() => automationPlan({}), /automation_install_posix_required/);
});
