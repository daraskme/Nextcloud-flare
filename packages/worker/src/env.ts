import type { BudgetDO } from "./do/BudgetDO";
import type { ControlDO } from "./do/ControlDO";
import type { LockDO } from "./do/LockDO";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  BACKUPS: R2Bucket;
  CACHE: KVNamespace;
  CONTROL: DurableObjectNamespace<ControlDO>;
  LOCKS: DurableObjectNamespace<LockDO>;
  UPLOADS: DurableObjectNamespace;
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
  PBKDF2_ITERATIONS: string;
  EPOCH_FLOOR?: string;
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
