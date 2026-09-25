import type { BudgetDO } from "./do/BudgetDO";
import type { ControlDO } from "./do/ControlDO";
import type { LockDO } from "./do/LockDO";
import type { UploadDO } from "./do/UploadDO";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  BACKUPS: R2Bucket;
  CACHE: KVNamespace;
  CONTROL: DurableObjectNamespace<ControlDO>;
  LOCKS: DurableObjectNamespace<LockDO>;
  UPLOADS: DurableObjectNamespace<UploadDO>;
  BUDGETS: DurableObjectNamespace<BudgetDO>;
  JOBS: Queue;
  IMAGES: ImagesBinding;
  EDGE_LIMITER: RateLimit;
  ASSETS: Fetcher;
  ENVIRONMENT: "development" | "staging" | "production";
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  CONTENT_TICKET_KEYS?: string;
  CONTENT_COOKIE_KEYS?: string;
  CONTENT_TICKET_ACTIVE_KID?: string;
  CONTENT_COOKIE_ACTIVE_KID?: string;
  ACCESS_ISSUER?: string;
  ACCESS_USER_AUDIENCE?: string;
  ACCESS_SERVICE_AUDIENCE?: string;
  BOOTSTRAP_OWNER_EMAILS?: string;
  BOOTSTRAP_OWNER_IDENTITIES?: string;
  BOOTSTRAP_QUOTA_BYTES?: string;
  CSRF_PRIVATE_KEYS?: string;
  CSRF_PUBLIC_KEYS?: string;
  CSRF_PRIVATE_ACTIVE_KID?: string;
  CSRF_PUBLIC_ACTIVE_KID?: string;
  NODE_CURSOR_KEYS?: string;
  NODE_CURSOR_ACTIVE_KID?: string;
  APP_PASSWORD_PEPPERS?: string;
  APP_PASSWORD_ACTIVE_KID?: string;
  UPLOAD_CAPABILITY_KEYS?: string;
  UPLOAD_CAPABILITY_ACTIVE_KID?: string;
  R2_INVENTORY_ACCOUNT_ID?: string;
  R2_INVENTORY_BUCKET?: string;
  R2_INVENTORY_JURISDICTION?: string;
  R2_INVENTORY_ACCESS_KEY_ID?: string;
  R2_INVENTORY_SECRET_ACCESS_KEY?: string;
  PBKDF2_ITERATIONS: string;
  EPOCH_FLOOR?: string;
  BACKUP_OPERATOR_ENABLED?: string;
  RESTORE_OPERATOR_ENABLED?: string;
}

export const REQUIRED_BINDINGS = [
  "DB",
  "BLOBS",
  "BACKUPS",
  "CACHE",
  "CONTROL",
  "LOCKS",
  "UPLOADS",
  "BUDGETS",
  "JOBS",
  "IMAGES",
  "EDGE_LIMITER",
  "ASSETS",
] as const satisfies readonly (keyof Env)[];

export function hasBindings(env: Partial<Env>): env is Env {
  return REQUIRED_BINDINGS.every((name) => env[name] !== undefined && env[name] !== null);
}
