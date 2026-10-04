import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const actions = new Map([
  ["recover", "recover"],
  ["status", "status"],
  ["audit-start", "beginAudit"],
  ["audit-next", "nextAuditPage"],
  ["resume", "resume"],
  ["gc-resume", "resumeGarbageCollection"],
]);

export function operatorConfig(accountId) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId))
    throw new Error("staging_control_account_id_required");
  return {
    name: "ncf-staging-control-client",
    compatibility_date: "2026-08-15",
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    account_id: accountId,
    services: [
      {
        binding: "STAGING_CONTROL",
        service: "next-cloud-flare-staging",
        entrypoint: "StagingControlOperator",
        props: { purpose: "staging-control-recovery-v1", environment: "staging" },
        remote: true,
      },
    ],
  };
}

export function parseAction(argv) {
  const [action, epochArg, ...extra] = argv;
  if (!actions.has(action) || extra.length > 0) throw new Error("staging_control_invalid_action");
  if (action === "recover" || action === "status") {
    if (epochArg !== undefined) throw new Error("staging_control_invalid_action");
    return { action, method: actions.get(action), args: [] };
  }
  if (!/^[1-9][0-9]*$/.test(epochArg ?? "")) throw new Error("staging_control_invalid_epoch");
  const epoch = Number(epochArg);
  if (!Number.isSafeInteger(epoch)) throw new Error("staging_control_invalid_epoch");
  return { action, method: actions.get(action), args: [epoch] };
}

export async function invokeOperator(accountId, argv, factory) {
  const operation = parseAction(argv);
  const directory = await mkdtemp(join(tmpdir(), "ncf-staging-control-"));
  let proxy;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify(operatorConfig(accountId)), {
      flag: "wx",
      mode: 0o600,
    });
    const getProxy = factory ?? (await import("wrangler")).getPlatformProxy;
    proxy = await getProxy({
      configPath,
      remoteBindings: true,
      persist: false,
      envFiles: [],
    });
    const binding = proxy.env.STAGING_CONTROL;
    if (typeof binding?.[operation.method] !== "function")
      throw new Error("staging_control_binding_missing");
    const result = await binding[operation.method](...operation.args);
    if (
      operation.action === "audit-next" &&
      (!result || result.epoch !== operation.args[0] || typeof result.completed !== "boolean")
    )
      throw new Error("staging_control_invalid_response");
    return { action: operation.action, result };
  } catch (error) {
    // Provider errors may include credentials, headers or URLs. CLI logs only local codes.
    const message = error instanceof Error ? error.message : "";
    if (/^staging_control_[a-z_]+$/.test(message)) throw error;
    throw new Error("staging_control_unavailable");
  } finally {
    try {
      await proxy?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Wrangler's remote proxy can wait indefinitely before invoking the RPC. A process
  // watchdog also closes its sockets if the proxy never reaches a disposable state.
  const watchdog = setTimeout(() => {
    process.stderr.write("staging_control_timeout_unknown_outcome\n");
    process.exit(124);
  }, 45_000);
  try {
    const result = await invokeOperator(process.env.CLOUDFLARE_ACCOUNT_ID, process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^staging_control_[a-z_]+$/.test(message)
      ? message
      : "staging_control_unavailable";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
