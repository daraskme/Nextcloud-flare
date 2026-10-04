#!/usr/bin/env node
import { execFile as execute } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assessBilling } from "../monitoring/monitor-core.mjs";

const execFile = promisify(execute);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const VOLUME = /^[A-Za-z0-9-]{4,128}$/;
const MAX_AUDIT_OBJECTS = 100_000;
const MAX_AUDIT_BYTES = 536_870_912_000;
const SECRET_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "R2_INVENTORY_ACCESS_KEY_ID",
  "R2_INVENTORY_SECRET_ACCESS_KEY",
];
const UNITS = [
  "ncf-weekly-backup.service",
  "ncf-weekly-backup.timer",
  "ncf-backup-monitor.service",
  "ncf-backup-monitor.timer",
];
const REQUIRED_RELEASE = [
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

function fail(code = "automation_install_invalid") {
  throw new Error(code);
}
function exactPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value)
    fail("automation_install_path_invalid");
  return value;
}
function persistentRoot(path) {
  exactPath(path);
  if (
    ["/tmp", "/var/tmp", "/run", "/dev/shm"].some(
      (prefix) => path === prefix || path.startsWith(prefix + sep),
    ) ||
    /[\s%\n\r]/.test(path)
  )
    fail("automation_install_persistent_root_required");
  return path;
}
function within(root, path) {
  const diff = relative(root, path);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}
function releaseFile(name) {
  return (
    ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(name) ||
    [
      "ops/backup/",
      "ops/staging/",
      "ops/monitoring/",
      "scripts/backup/",
      "packages/shared/src/",
      "packages/worker/migrations/",
      "packages/web/src/lib/",
    ].some((prefix) => name.startsWith(prefix)) ||
    [
      "packages/worker/package.json",
      "packages/shared/package.json",
      "packages/web/package.json",
      "packages/worker/src/db/schemaContract.ts",
      "packages/worker/src/assets/privateManifest.ts",
      "packages/worker/src/assets/publicManifest.ts",
    ].includes(name)
  );
}

export function selectReleaseFiles(tracked) {
  const selected = tracked.filter((name) => releaseFile(name));
  if (
    selected.some(
      (name) =>
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").some((part) => part === ".." || part === ""),
    ) ||
    REQUIRED_RELEASE.some((name) => !selected.includes(name))
  )
    fail("automation_install_source_incomplete");
  return selected.sort();
}

export function parseProtectedCredentials(contents) {
  if (typeof contents !== "string" || Buffer.byteLength(contents) > 16_384)
    fail("automation_install_credentials_invalid");
  const found = new Map();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._~+/=-]+)$/.exec(trimmed);
    if (!match || !SECRET_KEYS.includes(match[1]) || found.has(match[1]))
      fail("automation_install_credentials_invalid");
    found.set(match[1], match[2]);
  }
  if (SECRET_KEYS.some((name) => !found.has(name))) fail("automation_install_credentials_invalid");
  return SECRET_KEYS.map((name) => `${name}=${found.get(name)}`).join("\n") + "\n";
}

export function automationPlan(options) {
  if (process.platform === "win32") fail("automation_install_posix_required");
  const root = persistentRoot(options.root);
  const repo = exactPath(options.repo);
  const systemdDirectory = exactPath(options.systemdDirectory);
  const externalRoot = exactPath(options.externalRoot);
  const mountPoint = exactPath(options.mountPoint);
  const credentialsFile = exactPath(options.credentialsFile);
  const publicKeyFile = exactPath(options.publicKeyFile);
  const monitorConfigFile = exactPath(options.monitorConfigFile);
  const node = exactPath(options.node);
  const pnpm = exactPath(options.pnpm);
  const workerd = exactPath(options.workerd);
  const maxObjects = options.maxObjects === undefined ? 10_000 : Number(options.maxObjects);
  const maxBytes =
    options.maxBytes === undefined ? 10 * 1024 * 1024 * 1024 : Number(options.maxBytes);
  if (
    !ACCOUNT.test(options.cloudflareAccountId ?? "") ||
    !UUID.test(options.databaseId ?? "") ||
    !OWNER.test(options.adminAccountId ?? "") ||
    !VOLUME.test(options.volumeUuid ?? "") ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > MAX_AUDIT_OBJECTS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_AUDIT_BYTES ||
    !within(mountPoint, externalRoot) ||
    mountPoint === externalRoot ||
    [repo, systemdDirectory, mountPoint, credentialsFile, publicKeyFile, monitorConfigFile].some(
      (path) => within(root, path) || within(path, root),
    ) ||
    [node, pnpm, workerd].some((path) => within(root, path))
  )
    fail();
  return {
    ...options,
    root,
    repo,
    systemdDirectory,
    externalRoot,
    mountPoint,
    credentialsFile,
    publicKeyFile,
    monitorConfigFile,
    node,
    pnpm,
    workerd,
    maxObjects,
    maxBytes,
  };
}

export function renderAutomationUnits(plan) {
  const root = plan.root;
  const executable = `${root}/toolchain/bin/node`;
  const flock = `${root}/toolchain/bin/flock`;
  const release = `${root}/release`;
  const runtime = `${root}/config/runtime.env`;
  const common = `EnvironmentFile=${runtime}\nWorkingDirectory=${release}\nUMask=0077\nNoNewPrivileges=true\nStandardOutput=journal\nStandardError=journal`;
  return {
    "ncf-weekly-backup.service": `[Unit]\nDescription=Nextcloud-flare verified weekly encrypted backup\nWants=network-online.target\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=oneshot\nEnvironmentFile=${root}/config/credentials.env\n${common}\nExecStart=${flock} -n ${root}/locks/backup.lock ${executable} ${release}/ops/backup/run-weekly.mjs --run\nTimeoutStartSec=infinity\nRestart=on-failure\nRestartSec=30min\n`,
    "ncf-weekly-backup.timer": `[Unit]\nDescription=Nextcloud-flare weekly backup Sunday 03:30 JST\n\n[Timer]\nOnCalendar=Sun *-*-* 03:30:00 Asia/Tokyo\nPersistent=true\nUnit=ncf-weekly-backup.service\n\n[Install]\nWantedBy=timers.target\n`,
    "ncf-backup-monitor.service": `[Unit]\nDescription=Nextcloud-flare backup and billing monitor\nWants=network-online.target\nAfter=network-online.target graphical-session.target\n\n[Service]\nType=oneshot\nEnvironmentFile=${root}/config/monitor-credentials.env\n${common}\nExecStart=${flock} -n ${root}/locks/monitor.lock ${executable} ${release}/ops/monitoring/run-monitor.mjs --execute\n`,
    "ncf-backup-monitor.timer": `[Unit]\nDescription=Nextcloud-flare backup and billing monitor hourly\n\n[Timer]\nOnCalendar=hourly\nPersistent=true\nUnit=ncf-backup-monitor.service\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

function runtimeEnvironment(plan) {
  const root = plan.root;
  return (
    [
      `PATH=${root}/toolchain/bin:/usr/bin:/bin`,
      `TMPDIR=${root}/tmp`,
      `XDG_CACHE_HOME=${root}/cache`,
      `MINIFLARE_WORKERD_PATH=${root}/toolchain/bin/workerd`,
      "CI=true",
      "WRANGLER_SEND_METRICS=false",
      `CLOUDFLARE_ACCOUNT_ID=${plan.cloudflareAccountId}`,
      `STAGING_D1_DATABASE_ID=${plan.databaseId}`,
      `R2_INVENTORY_ACCOUNT_ID=${plan.cloudflareAccountId}`,
      "R2_INVENTORY_BUCKET=ncf-staging-blobs",
      `NCF_BACKUP_ACCOUNT_ID=${plan.adminAccountId}`,
      `NCF_BACKUP_STATE_ROOT=${root}/state`,
      `NCF_BACKUP_WORK_ROOT=${root}/work`,
      `NCF_BACKUP_EXTERNAL_ROOT=${plan.externalRoot}`,
      `NCF_BACKUP_MOUNT_POINT=${plan.mountPoint}`,
      `NCF_BACKUP_VOLUME_UUID=${plan.volumeUuid}`,
      `NCF_BACKUP_PUBLIC_KEY_FILE=${root}/config/admin-public.json`,
      `NCF_BACKUP_AUDIT_MAX_OBJECTS=${plan.maxObjects}`,
      `NCF_BACKUP_AUDIT_MAX_BYTES=${plan.maxBytes}`,
      `NCF_MONITOR_CONFIG=${root}/config/monitor.json`,
      `NCF_MONITOR_STATE_DIR=${root}/monitor-state`,
    ].join("\n") + "\n"
  );
}

async function privateInput(path) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 16_384 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    fail("automation_install_private_input_required");
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail("automation_install_destination_exists");
}
async function plainDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    fail("automation_install_directory_invalid");
}
async function version(path, args, options = {}) {
  const { stdout } = await execFile(path, args, { timeout: 10000, maxBuffer: 4096, ...options });
  return stdout.trim();
}
async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory || !isAbsolute(directory)) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Continue to the next PATH directory. */
    }
  }
  fail("automation_install_toolchain_invalid");
}
async function trackedSource(plan) {
  const git = async (args) =>
    execFile("git", args, {
      cwd: plan.repo,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer",
    });
  const tracked = (await git(["ls-files", "-z"])).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const files = selectReleaseFiles(tracked);
  const dirty = (await git(["status", "--porcelain", "--untracked-files=all", "--", ...files]))
    .stdout;
  const untracked = (
    await git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "ops/backup",
      "ops/staging",
      "ops/monitoring",
      "scripts/backup",
      "packages/shared/src",
      "packages/worker/migrations",
      "packages/web/src/lib",
    ])
  ).stdout;
  if (dirty.length || untracked.length) fail("automation_install_source_uncommitted");
  return files;
}

async function checkDependencyLinks(repo) {
  const dependencyRoots = [
    "node_modules",
    "packages/worker/node_modules",
    "packages/web/node_modules",
    "packages/shared/node_modules",
  ];
  for (const root of dependencyRoots) {
    const source = join(repo, root);
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if (error.code === "ENOENT" && root !== "node_modules") continue;
      throw error;
    }
    if (!info.isDirectory()) fail("automation_install_dependencies_invalid");
    const todo = [source];
    while (todo.length) {
      const directory = todo.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const link = await readlink(path);
          const target = await realpath(path);
          if (
            isAbsolute(link) ||
            !within(repo, target) ||
            ![...dependencyRoots, "packages/shared", "packages/worker", "packages/web"].some(
              (allowed) => within(join(repo, allowed), target),
            )
          )
            fail("automation_install_dependencies_invalid");
        } else if (
          entry.isDirectory() &&
          ![".pnpm-store", ".cache", ".vite"].includes(entry.name)
        ) {
          todo.push(path);
        }
      }
    }
  }
}

export async function inspectAutomationInstall(options) {
  const plan = automationPlan(options);
  await plainDirectory(dirname(plan.root));
  await plainDirectory(plan.systemdDirectory);
  await absent(plan.root);
  for (const unit of UNITS) await absent(join(plan.systemdDirectory, unit));
  for (const path of [plan.credentialsFile, plan.publicKeyFile, plan.monitorConfigFile])
    await privateInput(path);
  const credentialText = parseProtectedCredentials(await readFile(plan.credentialsFile, "utf8"));
  if (credentialText.length < 1) fail();
  const monitor = JSON.parse(await readFile(plan.monitorConfigFile, "utf8"));
  if (
    monitor?.version !== 1 ||
    assessBilling(null, monitor).code === "billing_config_invalid" ||
    !Number.isFinite(monitor.backupMaxAgeDays) ||
    monitor.backupMaxAgeDays < 1 ||
    monitor.backupMaxAgeDays > 30 ||
    !Number.isFinite(monitor.backupGraceHours) ||
    monitor.backupGraceHours < 0 ||
    monitor.backupGraceHours > 48
  )
    fail("automation_install_monitor_config_invalid");
  if (
    (await version(plan.node, ["--version"])) !== "v24.21.0" ||
    (await version(plan.pnpm, ["--version"])) !== "12.4.1" ||
    !(await version(plan.workerd, ["--version"])).startsWith("workerd")
  )
    fail("automation_install_toolchain_invalid");
  const tools = Object.fromEntries(
    await Promise.all(
      ["flock", "findmnt", "tar", "busctl", "systemctl"].map(async (name) => [
        name,
        await executableOnPath(name),
      ]),
    ),
  );
  const files = await trackedSource(plan);
  await checkDependencyLinks(plan.repo);
  return { plan, files, tools, units: renderAutomationUnits(plan) };
}

async function copyDependencies(repo, release) {
  for (const relativePath of [
    "node_modules",
    "packages/worker/node_modules",
    "packages/web/node_modules",
    "packages/shared/node_modules",
  ]) {
    const source = join(repo, relativePath);
    try {
      await lstat(source);
    } catch (error) {
      if (error.code === "ENOENT" && relativePath !== "node_modules") continue;
      throw error;
    }
    await cp(source, join(release, relativePath), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) =>
        ![".pnpm-store", ".cache", ".vite"].some((name) => path.split(sep).includes(name)),
    });
  }
}

async function createInstalledTree(inspection, staging) {
  const { plan, files, tools } = inspection;
  for (const name of [
    "config",
    "release",
    "toolchain",
    "toolchain/bin",
    "state",
    "work",
    "monitor-state",
    "locks",
    "tmp",
    "cache",
  ])
    await mkdir(join(staging, name), { recursive: true, mode: 0o700 });
  const release = join(staging, "release");
  for (const name of files) {
    const source = join(plan.repo, name);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) fail("automation_install_source_changed");
    const target = join(release, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
  await copyDependencies(plan.repo, release);
  for (const [name, source] of [
    ["node", plan.node],
    ["pnpm", plan.pnpm],
    ["workerd", plan.workerd],
  ])
    await copyFile(source, join(staging, "toolchain/bin", name), constants.COPYFILE_EXCL);
  for (const name of ["flock", "findmnt", "tar", "busctl"])
    await copyFile(tools[name], join(staging, "toolchain/bin", name), constants.COPYFILE_EXCL);
  const credentials = parseProtectedCredentials(await readFile(plan.credentialsFile, "utf8"));
  await writeFile(join(staging, "config/credentials.env"), credentials, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(staging, "config/monitor-credentials.env"),
    credentials.split("\n").find((line) => line.startsWith("CLOUDFLARE_API_TOKEN=")) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await copyFile(
    plan.publicKeyFile,
    join(staging, "config/admin-public.json"),
    constants.COPYFILE_EXCL,
  );
  await copyFile(
    plan.monitorConfigFile,
    join(staging, "config/monitor.json"),
    constants.COPYFILE_EXCL,
  );
  await writeFile(join(staging, "config/runtime.env"), runtimeEnvironment(plan), {
    flag: "wx",
    mode: 0o600,
  });
  const node = join(staging, "toolchain/bin/node");
  if (
    (await version(node, ["--version"])) !== "v24.21.0" ||
    (await version(join(staging, "toolchain/bin/pnpm"), ["--version"])) !== "12.4.1"
  )
    fail("automation_install_toolchain_invalid");
  await version(node, [join(release, "node_modules/wrangler/bin/wrangler.js"), "--version"]);
  const smokeEnv = {
    ...process.env,
    PATH: `${join(staging, "toolchain/bin")}:/usr/bin:/bin`,
    TMPDIR: join(staging, "tmp"),
    ESBUILD_BINARY_PATH: "",
    NODE_OPTIONS: "",
  };
  await version(
    node,
    [
      "--input-type=module",
      "-e",
      "import {createRequire} from 'node:module'; const r=createRequire(import.meta.resolve('wrangler')); r('esbuild').buildSync({stdin:{contents:'export const x=1'},bundle:true,write:false}); await import('./ops/backup/run-weekly.mjs'); await import('./ops/monitoring/run-monitor.mjs')",
    ],
    { cwd: release, env: smokeEnv },
  );
}

export async function installUserAutomation(options, { systemctl } = {}) {
  const inspection = await inspectAutomationInstall(options);
  const { plan, units } = inspection;
  const control =
    systemctl ??
    ((args) => execFile(inspection.tools.systemctl, ["--user", ...args], { timeout: 30000 }));
  const staging = `${plan.root}.staging-${randomUUID()}`;
  let published = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    await createInstalledTree(inspection, staging);
    await absent(plan.root);
    await rename(staging, plan.root);
    published = true;
    for (const name of UNITS)
      await writeFile(join(plan.systemdDirectory, name), units[name], { flag: "wx", mode: 0o600 });
    await control(["daemon-reload"]);
    await control(["enable", "--now", "ncf-weekly-backup.timer", "ncf-backup-monitor.timer"]);
    return { installed: true };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

function cliOptions(args) {
  const mode = args.shift();
  if (!["--check", "--install"].includes(mode) || args.length % 2 !== 0)
    fail("automation_install_usage");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!/^--[a-z-]+$/.test(args[index]) || values.has(args[index]) || !args[index + 1])
      fail("automation_install_usage");
    values.set(args[index], args[index + 1]);
  }
  const names = {
    "--root": "root",
    "--repo": "repo",
    "--systemd-dir": "systemdDirectory",
    "--credentials": "credentialsFile",
    "--public-key": "publicKeyFile",
    "--monitor-config": "monitorConfigFile",
    "--node": "node",
    "--pnpm": "pnpm",
    "--workerd": "workerd",
    "--external-root": "externalRoot",
    "--mount-point": "mountPoint",
    "--volume-uuid": "volumeUuid",
    "--cloudflare-account": "cloudflareAccountId",
    "--database": "databaseId",
    "--admin-account": "adminAccountId",
    "--max-objects": "maxObjects",
    "--max-bytes": "maxBytes",
  };
  if (
    [...values.keys()].some((name) => !Object.hasOwn(names, name)) ||
    Object.keys(names)
      .filter((name) => !["--max-objects", "--max-bytes"].includes(name))
      .some((name) => !values.has(name))
  )
    fail("automation_install_usage");
  return {
    mode,
    options: Object.fromEntries([...values].map(([key, value]) => [names[key], value])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { mode, options } = cliOptions(process.argv.slice(2));
    if (mode === "--check") await inspectAutomationInstall(options);
    else await installUserAutomation(options);
    process.stdout.write(
      mode === "--check" ? "automation_install_ready\n" : "automation_install_complete\n",
    );
  } catch (error) {
    const code =
      error instanceof Error && /^automation_install_[a-z_]+$/.test(error.message)
        ? error.message
        : "automation_install_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
