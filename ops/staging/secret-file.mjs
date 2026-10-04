import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const templatePath = fileURLToPath(new URL("./wrangler.staging.example.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(templatePath, readFileSync(templatePath, "utf8"));
if (parsed.error) throw new Error("Invalid staging Wrangler template");
const required = parsed.config.secrets?.required;
if (!Array.isArray(required) || required.length === 0) throw new Error("No required secrets");

const rings = [
  ["CSRF_PRIVATE_KEYS", "CSRF_PRIVATE_ACTIVE_KID"],
  ["CSRF_PUBLIC_KEYS", "CSRF_PUBLIC_ACTIVE_KID"],
  ["CONTENT_TICKET_KEYS", "CONTENT_TICKET_ACTIVE_KID"],
  ["CONTENT_COOKIE_KEYS", "CONTENT_COOKIE_ACTIVE_KID"],
  ["NODE_CURSOR_KEYS", "NODE_CURSOR_ACTIVE_KID"],
  ["APP_PASSWORD_PEPPERS", "APP_PASSWORD_ACTIVE_KID"],
  ["SHARE_PASSWORD_PEPPERS", "SHARE_PASSWORD_ACTIVE_KID"],
  ["UPLOAD_CAPABILITY_KEYS", "UPLOAD_CAPABILITY_ACTIVE_KID"],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function privatePath(input) {
  assert(typeof input === "string" && isAbsolute(input), "Use an absolute secret file path");
  const path = resolve(input);
  const withinRepo = relative(repoRoot, path);
  assert(
    withinRepo === ".." || withinRepo.startsWith("../"),
    "Secret file must be outside repository",
  );
  return path;
}
function jsonValue(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON value for ${name}`);
  }
}
function validKey(encoded) {
  return (
    typeof encoded === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(encoded) &&
    Buffer.from(encoded, "base64url").length === 32 &&
    Buffer.from(encoded, "base64url").toString("base64url") === encoded
  );
}

function create(path) {
  const output = Object.fromEntries(required.map((name) => [name, `FILL_${name}`]));
  for (const [keyName, kidName] of rings) {
    output[keyName] = JSON.stringify({ s1: randomBytes(32).toString("base64url") });
    output[kidName] = "s1";
  }
  output.BOOTSTRAP_OWNER_IDENTITIES = "[]";
  output.BOOTSTRAP_QUOTA_BYTES = "1073741824";
  output.R2_INVENTORY_BUCKET = "ncf-staging-blobs";
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(
    "Created private staging secret draft; fill Access, owner and R2 fields before validation",
  );
}

function validate(path) {
  const info = statSync(path);
  assert(info.isFile(), "Secret path is not a regular file");
  if (process.platform !== "win32")
    assert((info.mode & 0o077) === 0, "Secret file must be mode 0600");
  const data = jsonValue(readFileSync(realpathSync(path), "utf8"), "secret file");
  assert(
    data && typeof data === "object" && !Array.isArray(data),
    "Secret file must be a JSON object",
  );
  const allowed = new Set([...required, "R2_INVENTORY_JURISDICTION"]);
  assert(
    Object.keys(data).every((name) => allowed.has(name)),
    "Unknown secret name",
  );
  assert(
    required.every(
      (name) =>
        typeof data[name] === "string" && data[name].length > 0 && !data[name].startsWith("FILL_"),
    ),
    "Required secret value missing or unfilled",
  );
  let issuer;
  try {
    issuer = new URL(data.ACCESS_ISSUER);
  } catch {
    throw new Error("Invalid Access issuer");
  }
  assert(
    issuer.protocol === "https:" && issuer.origin === data.ACCESS_ISSUER,
    "Invalid Access issuer",
  );
  assert(
    data.ACCESS_USER_AUDIENCE !== data.ACCESS_SERVICE_AUDIENCE,
    "Access audiences must differ",
  );
  const emails = jsonValue(data.BOOTSTRAP_OWNER_EMAILS, "BOOTSTRAP_OWNER_EMAILS");
  const identities = jsonValue(data.BOOTSTRAP_OWNER_IDENTITIES, "BOOTSTRAP_OWNER_IDENTITIES");
  assert(
    Array.isArray(emails) && emails.every((value) => typeof value === "string"),
    "Invalid bootstrap emails",
  );
  assert(
    Array.isArray(identities) &&
      identities.every((value) => typeof value?.iss === "string" && typeof value?.sub === "string"),
    "Invalid bootstrap identities",
  );
  assert(emails.length + identities.length > 0, "No bootstrap owner");
  const quota = Number(data.BOOTSTRAP_QUOTA_BYTES);
  assert(Number.isSafeInteger(quota) && quota >= 0, "Invalid bootstrap quota");
  const usedKeys = new Set();
  for (const [keyName, kidName] of rings) {
    const map = jsonValue(data[keyName], keyName);
    assert(map && typeof map === "object" && !Array.isArray(map), `Invalid ${keyName}`);
    assert(
      Object.keys(map).length === 1 && Object.hasOwn(map, data[kidName]),
      `Invalid ${keyName} kid`,
    );
    const key = map[data[kidName]];
    assert(validKey(key) && !usedKeys.has(key), `Invalid or reused ${keyName} key`);
    usedKeys.add(key);
  }
  assert(/^[a-f\d]{32}$/.test(data.R2_INVENTORY_ACCOUNT_ID), "Invalid R2 account ID");
  assert(data.R2_INVENTORY_BUCKET === "ncf-staging-blobs", "Unexpected R2 inventory bucket");
  assert(
    /^[A-Za-z\d_-]{16,128}$/.test(data.R2_INVENTORY_ACCESS_KEY_ID),
    "Invalid R2 access key ID",
  );
  assert(
    /^[A-Za-z\d+/=_-]{32,128}$/.test(data.R2_INVENTORY_SECRET_ACCESS_KEY),
    "Invalid R2 secret key",
  );
  if (data.R2_INVENTORY_JURISDICTION !== undefined)
    assert(
      ["default", "eu", "fedramp", "us"].includes(data.R2_INVENTORY_JURISDICTION),
      "Invalid R2 jurisdiction",
    );
  console.log(
    `Validated structure of ${required.length} staging Worker secret values without displaying them`,
  );
}

const path = privatePath(process.argv[3]);
switch (process.argv[2]) {
  case "create":
    create(path);
    break;
  case "validate":
    validate(path);
    break;
  default:
    throw new Error("Usage: node secret-file.mjs create|validate /absolute/private/path.json");
}
