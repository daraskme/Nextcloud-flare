export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  BACKUPS: R2Bucket;
  CACHE: KVNamespace;
  LOCKS: DurableObjectNamespace;
  UPLOADS: DurableObjectNamespace;
  BUDGETS: DurableObjectNamespace;
  CONTROL: DurableObjectNamespace;
  JOBS: Queue;
  IMAGES: ImagesBinding;
  EDGE_LIMITER: RateLimit;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_USER_AUD: string;
  ACCESS_SERVICE_AUD: string;
  PBKDF2_ITERATIONS: string;
  OWNER_EMAILS: string;
  SIGNING_KEYS?: string;
  CSRF_KEY?: string;
  CONTENT_SESSION_KEY?: string;
  APP_PASSWORD_PEPPER?: string;
  EPOCH_FLOOR?: string;
}
